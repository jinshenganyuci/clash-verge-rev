import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  accountWrite,
  completeOnboarding,
  readAccount,
  refreshAccount,
  signIn,
  signOut,
  type AccountSnapshot,
} from './xboard'

const backend = vi.hoisted(() => ({
  snapshot: vi.fn(), policy: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn(),
  refresh: vi.fn(), request: vi.fn(), onboarding: vi.fn(),
  copySubscription: vi.fn(), copyTelegram: vi.fn(),
}))
const state = vi.hoisted(() => ({
  remote: undefined as AccountSnapshot | undefined,
  cached: undefined as AccountSnapshot | undefined,
  writes: [] as AccountSnapshot[],
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
}))
vi.mock('@/services/query-client', () => ({
  setCacheData: async (_key: unknown, value: AccountSnapshot) => {
    state.cached = value
    state.writes.push(value)
  },
  revalidateQueries: async () => undefined,
  revalidateQuery: async (key: readonly string[]) => {
    if (key[0] === 'xboardSnapshot') state.cached = await backend.snapshot()
    return state.cached
  },
}))
vi.mock('@/services/notice-service', () => ({ showNotice: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }))

const guest = (): AccountSnapshot => ({
  onboarding_complete: false, signed_in: false, email: null,
  profile_uid: null, last_sync: null, subscription: null, error: null,
})
const member = (): AccountSnapshot => ({
  ...guest(), onboarding_complete: true, signed_in: true, email: 'member@example.com',
  profile_uid: 'xboard-account',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  state.remote = guest()
  state.cached = state.remote
  state.writes = []
  backend.snapshot.mockImplementation(async () => state.remote)
})

describe('account lifecycle', () => {
  it('preserves a failed login error without publishing a signed-in snapshot', async () => {
    const failure = { code: 'XBOARD_REQUEST_FAILED', detail: 'Incorrect email or password.' }
    backend.login.mockRejectedValue(failure)

    await expect(signIn('member@example.com', 'incorrect-password')).rejects.toBe(failure)

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
    expect(backend.login).not.toHaveBeenCalled()
  })

  it('does not retry a failed write or turn it into a successful result', async () => {
    state.remote = member()
    const failure = { code: 'XBOARD_NETWORK_FAILED', detail: 'The request could not be confirmed.' }
    backend.request.mockRejectedValue(failure)

    await expect(accountWrite('ticket_save', { subject: 'Issue', level: 0, message: 'Details' })).rejects.toBe(failure)

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

    await expect(refreshAccount(true)).rejects.toMatchObject({ code: 'XBOARD_SESSION_EXPIRED' })

    expect(state.cached?.signed_in).toBe(false)
    expect(state.cached?.subscription).toBeNull()
  })
})
