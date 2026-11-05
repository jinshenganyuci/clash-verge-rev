import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openExternalUrl } from '@/utils/open-external-url'

import {
  accountWrite,
  cancelConnectionGuide,
  completeConnectionGuide,
  completeOnboarding,
  connectAccount,
  interruptConnectionGuide,
  openAccountWebsite,
  prepareConnectionGuide,
  readAccount,
  readConnectionGuide,
  refreshAccount,
  registerAccount,
  signIn,
  signOut,
  type AccountSnapshot,
  type ConnectionGuide,
} from './xboard'

const backend = vi.hoisted(() => ({
  snapshot: vi.fn(),
  policy: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  request: vi.fn(),
  onboarding: vi.fn(),
  copySubscription: vi.fn(),
  copyTelegram: vi.fn(),
  guideSnapshot: vi.fn(),
  guidePrepare: vi.fn(),
  guideCancel: vi.fn(),
  guideConnect: vi.fn(),
  guideComplete: vi.fn(),
}))
const state = vi.hoisted(() => ({
  remote: undefined as AccountSnapshot | undefined,
  cached: undefined as AccountSnapshot | undefined,
  writes: [] as AccountSnapshot[],
  guide: undefined as ConnectionGuide | undefined,
  guideCached: undefined as ConnectionGuide | undefined,
  guideWrites: [] as ConnectionGuide[],
}))

vi.mock('@/services/cmds', () => ({
  xboardSnapshot: backend.snapshot,
  xboardRegistrationPolicy: backend.policy,
  xboardLogin: backend.login,
  xboardRegister: backend.register,
  xboardLogout: backend.logout,
  xboardRefresh: backend.refresh,
  xboardRequest: backend.request,
  xboardCompleteOnboarding: backend.onboarding,
  xboardCopySubscription: backend.copySubscription,
  xboardCopyTelegramBinding: backend.copyTelegram,
  xboardGuideSnapshot: backend.guideSnapshot,
  xboardGuidePrepare: backend.guidePrepare,
  xboardGuideCancel: backend.guideCancel,
  xboardGuideConnect: backend.guideConnect,
  xboardGuideComplete: backend.guideComplete,
}))
vi.mock('@/services/query-client', () => ({
  setCacheData: async (key: readonly string[], value: AccountSnapshot | ConnectionGuide) => {
    if (key[0] === 'xboardGuideSnapshot') {
      state.guideCached = value as ConnectionGuide
      state.guideWrites.push(value as ConnectionGuide)
    } else {
      state.cached = value as AccountSnapshot
      state.writes.push(value as AccountSnapshot)
    }
  },
  revalidateQueries: async () => undefined,
  revalidateQuery: async (key: readonly string[]) => {
    if (key[0] === 'xboardSnapshot') state.cached = await backend.snapshot()
    if (key[0] === 'xboardGuideSnapshot') state.guideCached = await backend.guideSnapshot()
    return state.cached
  },
}))
vi.mock('@/services/notice-service', () => ({
  showNotice: { error: vi.fn(), success: vi.fn() },
}))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }))

const guest = (): AccountSnapshot => ({
  onboarding_complete: false,
  guide_pending: false,
  signed_in: false,
  email: null,
  profile_uid: null,
  last_sync: null,
  subscription: null,
  error: null,
})
const initialGuide = (): ConnectionGuide => ({
  attempt_id: 0,
  phase: 'idle',
  mode: 'tun',
  group_name: null,
  node_name: null,
  latency_ms: null,
  error: null,
  error_stage: null,
  tested: 0,
  total: 0,
})
const member = (): AccountSnapshot => ({
  ...guest(),
  onboarding_complete: true,
  signed_in: true,
  email: 'member@example.com',
  profile_uid: 'xboard-account',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  state.remote = guest()
  state.cached = state.remote
  state.writes = []
  state.guide = initialGuide()
  state.guideCached = state.guide
  state.guideWrites = []
  backend.snapshot.mockImplementation(async () => state.remote)
  backend.guideSnapshot.mockImplementation(async () => state.guide)
})

describe('account lifecycle', () => {
  it('does not repeat registration or complete onboarding when creation is uncertain', async () => {
    const failure = {
      code: 'XBOARD_REGISTRATION_UNCERTAIN',
      detail:
        'Registration could not be confirmed. Try signing in before registering again.',
    }
    backend.register.mockRejectedValue(failure)

    await expect(
      registerAccount({
        email: 'member@example.com',
        password: 'sample-password',
        email_code: '123456',
        invite_code: 'sample-invite',
      }),
    ).rejects.toBe(failure)

    expect(backend.register).toHaveBeenCalledTimes(1)
    expect(backend.onboarding).not.toHaveBeenCalled()
    expect(state.cached?.onboarding_complete).toBe(false)
    expect(state.writes).toHaveLength(0)
  })

  it('preserves a failed login error without publishing a signed-in snapshot', async () => {
    const failure = {
      code: 'XBOARD_REQUEST_FAILED',
      detail: 'Incorrect email or password.',
    }
    backend.login.mockRejectedValue(failure)

    await expect(
      signIn('member@example.com', 'incorrect-password'),
    ).rejects.toBe(failure)

    expect(backend.login).toHaveBeenCalledTimes(1)
    expect(state.cached?.signed_in).toBe(false)
    expect(state.writes).toHaveLength(0)
  })

  it('serializes a queued refresh behind logout so it cannot restore the old account', async () => {
    state.remote = member()
    state.cached = state.remote
    const finishLogout = deferred<void>()
    backend.logout.mockImplementation(async () => {
      await finishLogout.promise
      state.remote = { ...guest(), onboarding_complete: true }
      return state.remote
    })
    backend.refresh.mockImplementation(async () => state.remote)

    const logout = signOut()
    const refresh = refreshAccount(false)
    await Promise.resolve()
    expect(backend.refresh).not.toHaveBeenCalled()
    finishLogout.resolve()
    await Promise.all([logout, refresh])

    expect(state.cached?.signed_in).toBe(false)
    expect(state.cached?.profile_uid).toBeNull()
    expect(state.writes.every((snapshot) => !snapshot.signed_in)).toBe(true)
  })

  it('reconciles a snapshot read that was started before logout', async () => {
    const oldMember = member()
    state.remote = oldMember
    const oldRead = deferred<AccountSnapshot>()
    backend.snapshot.mockImplementationOnce(() => oldRead.promise)
    backend.logout.mockImplementation(async () => {
      state.remote = { ...guest(), onboarding_complete: true }
      return state.remote
    })

    const reading = readAccount()
    await signOut()
    oldRead.resolve(oldMember)

    expect((await reading).signed_in).toBe(false)
    expect(backend.snapshot).toHaveBeenCalledTimes(2)
  })

  it('persists skipping onboarding without fabricating a login', async () => {
    backend.onboarding.mockImplementation(async () => {
      state.remote = { ...guest(), onboarding_complete: true }
      return state.remote
    })

    await completeOnboarding()

    expect(state.cached?.onboarding_complete).toBe(true)
    expect(state.cached?.signed_in).toBe(false)
    expect(state.cached?.guide_pending).toBe(false)
    expect(backend.login).not.toHaveBeenCalled()
    expect(backend.guidePrepare).not.toHaveBeenCalled()
  })

  it('does not retry a failed write or turn it into a successful result', async () => {
    state.remote = member()
    const failure = {
      code: 'XBOARD_NETWORK_FAILED',
      detail: 'The request could not be confirmed.',
    }
    backend.request.mockRejectedValue(failure)

    await expect(
      accountWrite('ticket_save', {
        subject: 'Issue',
        level: 0,
        message: 'Details',
      }),
    ).rejects.toBe(failure)

    expect(backend.request).toHaveBeenCalledTimes(1)
    expect(state.writes).toHaveLength(0)
  })

  it('reconciles an expired session even when subscription refresh rejects', async () => {
    state.remote = member()
    state.cached = state.remote
    backend.refresh.mockImplementation(async () => {
      state.remote = { ...guest(), onboarding_complete: true }
      throw { code: 'XBOARD_SESSION_EXPIRED', detail: 'Your session expired.' }
    })

    await expect(refreshAccount(true)).rejects.toMatchObject({
      code: 'XBOARD_SESSION_EXPIRED',
    })

    expect(state.cached?.signed_in).toBe(false)
    expect(state.cached?.subscription).toBeNull()
  })
})

describe('first connection guide', () => {
  it('does not wait for account refresh before a manual node change', async () => {
    backend.guideCancel.mockResolvedValue(initialGuide())

    await interruptConnectionGuide()

    expect(backend.guideCancel).toHaveBeenCalledTimes(1)
    expect(backend.snapshot).not.toHaveBeenCalled()
  })

  it('permits a manual change after cancellation settles even if its marker cannot be saved', async () => {
    backend.guideCancel.mockRejectedValue({ code: 'XBOARD_STORAGE_FAILED', detail: 'Cannot save the marker.' })

    await expect(interruptConnectionGuide()).resolves.toBeUndefined()
    expect(backend.snapshot).not.toHaveBeenCalled()
  })

  it('publishes the guide gate in the same snapshot as a new authenticated session', async () => {
    backend.login.mockResolvedValue({ ...member(), guide_pending: true })

    await signIn('member@example.com', 'sample-password')

    expect(state.cached).toMatchObject({ signed_in: true, guide_pending: true })
    expect(state.writes).toHaveLength(1)
    expect(backend.guideConnect).not.toHaveBeenCalled()
  })

  it('does not re-enable the guide for an existing account', async () => {
    backend.login.mockResolvedValue(member())

    await signIn('member@example.com', 'sample-password')

    expect(state.cached?.guide_pending).toBe(false)
    expect(backend.guidePrepare).not.toHaveBeenCalled()
  })

  it('cancels without waiting for preparation and discards its late ready result', async () => {
    state.remote = { ...member(), guide_pending: true }
    const preparing = deferred<ConnectionGuide>()
    backend.guidePrepare.mockReturnValue(preparing.promise)
    backend.guideCancel.mockImplementation(async () => {
      state.guide = { ...initialGuide(), phase: 'cancelled' }
      state.remote = member()
      return state.guide
    })

    const preparation = prepareConnectionGuide()
    await Promise.resolve()
    await cancelConnectionGuide()
    expect(backend.guideCancel).toHaveBeenCalledTimes(1)
    expect(state.cached?.guide_pending).toBe(false)

    preparing.resolve({ ...initialGuide(), attempt_id: 1, phase: 'ready', node_name: 'Node A' })
    expect((await preparation).phase).toBe('cancelled')
    expect(state.guideCached?.phase).toBe('cancelled')
    expect(state.guideWrites.some((value) => value.phase === 'ready')).toBe(false)
    expect(backend.guideConnect).not.toHaveBeenCalled()
  })

  it('reconciles a guide read that began before cancellation', async () => {
    const oldRead = deferred<ConnectionGuide>()
    backend.guideSnapshot.mockReturnValueOnce(oldRead.promise)
    backend.guideCancel.mockImplementation(async () => {
      state.guide = { ...initialGuide(), phase: 'cancelled' }
      return state.guide
    })

    const reading = readConnectionGuide()
    await cancelConnectionGuide()
    oldRead.resolve({ ...initialGuide(), phase: 'testing' })

    expect((await reading).phase).toBe('cancelled')
    expect(backend.guideSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not let a poll started during preparation overwrite its newer result', async () => {
    const preparation = deferred<ConnectionGuide>()
    const oldRead = deferred<ConnectionGuide>()
    backend.guidePrepare.mockReturnValue(preparation.promise)
    backend.guideSnapshot.mockReturnValueOnce(oldRead.promise)

    const preparing = prepareConnectionGuide()
    const reading = readConnectionGuide()
    state.guide = { ...initialGuide(), attempt_id: 2, phase: 'syncing' }
    preparation.resolve(state.guide)
    await preparing
    oldRead.resolve(initialGuide())

    expect((await reading).phase).toBe('syncing')
    expect(state.guideCached?.phase).toBe('syncing')
  })

  it('keeps the guide open after failed connection and permits a system-proxy retry', async () => {
    state.remote = { ...member(), guide_pending: true }
    state.cached = state.remote
    const failure = { code: 'XBOARD_GUIDE_CONNECT_FAILED', detail: 'The connection could not be started.' }
    backend.guideConnect.mockRejectedValueOnce(failure)
    await expect(connectAccount(4, 'tun')).rejects.toBe(failure)
    expect(state.cached?.guide_pending).toBe(true)
    expect(backend.guideComplete).not.toHaveBeenCalled()

    backend.guideConnect.mockResolvedValue({ ...initialGuide(), attempt_id: 4, phase: 'connecting', mode: 'system' })
    await connectAccount(4, 'system')
    expect(backend.guideConnect).toHaveBeenLastCalledWith(4, 'system')
    expect(state.guideCached?.phase).toBe('connecting')
    expect(state.cached?.guide_pending).toBe(true)
  })

  it('releases the gate only after backend completion is persisted', async () => {
    state.remote = { ...member(), guide_pending: true }
    state.cached = state.remote
    backend.guideComplete.mockRejectedValueOnce(new Error('Cannot save completion'))
    await expect(completeConnectionGuide(4)).rejects.toThrow('Cannot save completion')
    expect(state.cached?.guide_pending).toBe(true)

    backend.guideComplete.mockImplementation(async () => {
      state.remote = member()
      return { ...initialGuide(), attempt_id: 4, phase: 'succeeded' }
    })
    await completeConnectionGuide(4)
    expect(backend.guideComplete).toHaveBeenLastCalledWith(4)
    expect(state.cached?.guide_pending).toBe(false)
  })
})

describe('account external links', () => {
  it('rejects scripts, insecure URLs and credential-bearing URLs before opening a browser', async () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com/terms',
      'https://user:pass@example.com/terms',
    ]) {
      await expect(openAccountWebsite(url)).rejects.toThrow(
        'Invalid website address',
      )
    }
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('keeps Telegram actions on the approved HTTPS hosts and port', async () => {
    await expect(
      openAccountWebsite('https://t.me.evil.example/bot', true),
    ).rejects.toThrow('Invalid website address')
    await expect(
      openAccountWebsite('https://t.me:8443/bot', true),
    ).rejects.toThrow('Invalid website address')
    expect(openExternalUrl).not.toHaveBeenCalled()

    await openAccountWebsite('https://t.me/example_bot', true)
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      'https://t.me/example_bot',
    )
  })
})
