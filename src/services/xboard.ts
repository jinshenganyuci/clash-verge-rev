import { writeText } from '@tauri-apps/plugin-clipboard-manager'

import {
  xboardSnapshot,
  xboardRegistrationPolicy,
  xboardLogin,
  xboardRegister,
  xboardLogout,
  xboardRefresh,
  xboardRequest,
  xboardCompleteOnboarding,
  xboardCopySubscription,
  xboardCopyTelegramBinding,
  xboardGuideSnapshot,
  xboardGuidePrepare,
  xboardGuideCancel,
  xboardGuideConnect,
  xboardGuideComplete,
} from '@/services/cmds'
import { mutate } from '@/services/mutate'
import { revalidateQuery, setCacheData } from '@/services/query-client'
import { openExternalUrl } from '@/utils/open-external-url'

export type AccountSnapshot = Awaited<ReturnType<typeof xboardSnapshot>>
export type AccountOperation = Parameters<typeof xboardRequest>[0]
export type ConnectionGuide = Awaited<ReturnType<typeof xboardGuideSnapshot>>
export type ConnectionMode = Parameters<typeof xboardGuideConnect>[1]

export type AccountParams = Record<string, string | number>
export type AccountEnvelope<T> = Omit<
  Awaited<ReturnType<typeof xboardRequest>>,
  'data'
> & { data: T }
export const accountKey = ['xboardSnapshot'] as const
export const connectionGuideKey = ['xboardGuideSnapshot'] as const
export const readRegistrationPolicy = () => xboardRegistrationPolicy()
let snapshotVersion = 0
let guideVersion = 0

export async function readConnectionGuide(): Promise<ConnectionGuide> {
  const version = guideVersion
  const snapshot = await xboardGuideSnapshot()
  if (version !== guideVersion) return readConnectionGuide()
  if (snapshot.phase === 'cancelled') {
    snapshotVersion += 1
    const account = await readAccount()
    await setCacheData(accountKey, account)
  }
  return snapshot
}

async function guideMutation(
  action: () => Promise<ConnectionGuide>,
  cancel = false,
  reconcileAccount = true,
) {
  let version = ++guideVersion
  try {
    const result = await mutate(action, {
      // Cancellation must reach the backend without waiting for preparation.
      id: cancel ? 'xboard-guide-cancel' : 'xboard-guide',
      errorNotice: false,
      onFulfilled: (snapshot) => {
        if (version === guideVersion) {
          version = ++guideVersion
          void setCacheData(connectionGuideKey, snapshot)
        }
      },
    })
    if (version !== guideVersion)
      return reconcileAccount ? readConnectionGuide() : result.value
    if ((result.value.phase === 'cancelled' || cancel) && reconcileAccount) {
      snapshotVersion += 1
      const snapshot = await readAccount()
      await setCacheData(accountKey, snapshot)
    }
    return result.value
  } catch (error) {
    if (version === guideVersion) guideVersion += 1
    const reconciliation = revalidateQuery(connectionGuideKey)
    if (reconcileAccount) await Promise.allSettled([reconciliation])
    else void reconciliation.catch(() => {})
    throw error
  }
}

export const prepareConnectionGuide = () => guideMutation(xboardGuidePrepare)
export const cancelConnectionGuide = () =>
  guideMutation(xboardGuideCancel, true)
export async function interruptConnectionGuide() {
  try {
    await guideMutation(xboardGuideCancel, true, false)
  } catch (error) {
    // The backend settles cancellation before attempting to persist its marker.
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'XBOARD_STORAGE_FAILED'
    )
      throw error
  }
}
export const connectAccount = (attemptId: number, mode: ConnectionMode) =>
  guideMutation(() => xboardGuideConnect(attemptId, mode))
export async function completeConnectionGuide(attemptId: number) {
  const result = await guideMutation(() => xboardGuideComplete(attemptId))
  snapshotVersion += 1
  const snapshot = await readAccount()
  await setCacheData(accountKey, snapshot)
  return result
}

export async function readAccount(): Promise<AccountSnapshot> {
  const version = snapshotVersion
  const snapshot = await xboardSnapshot()
  return version === snapshotVersion ? snapshot : readAccount()
}

async function accountMutation(action: () => Promise<AccountSnapshot>) {
  try {
    const result = await mutate(action, {
      id: 'xboard-account',
      errorNotice: false,
      onFulfilled: (snapshot) => {
        snapshotVersion += 1
        void setCacheData(accountKey, snapshot)
      },
      revalidate: [['getProfiles']],
    })
    return result.value
  } catch (error) {
    snapshotVersion += 1
    await Promise.allSettled([
      revalidateQuery(accountKey),
      revalidateQuery(['getProfiles']),
    ])
    throw error
  }
}

export const signIn = (email: string, password: string) =>
  accountMutation(() => xboardLogin(email.trim(), password))
export const registerAccount = (input: {
  email: string
  password: string
  email_code?: string
  invite_code?: string
}) =>
  accountMutation(() =>
    xboardRegister({
      ...input,
      email_code: input.email_code ?? null,
      invite_code: input.invite_code ?? null,
    }),
  )
export const signOut = () => accountMutation(xboardLogout)
export const refreshAccount = (force = false) =>
  accountMutation(() => xboardRefresh(force))
export const completeOnboarding = () =>
  accountMutation(xboardCompleteOnboarding)

export async function accountRequest<T>(
  operation: AccountOperation,
  params: AccountParams = {},
): Promise<AccountEnvelope<T>> {
  try {
    return (await xboardRequest(
      operation,
      params,
    )) as unknown as AccountEnvelope<T>
  } catch (error) {
    snapshotVersion += 1
    await Promise.allSettled([revalidateQuery(accountKey)])
    throw error
  }
}

export async function accountWrite(
  operation: AccountOperation,
  params: AccountParams = {},
) {
  const result = await mutate(
    () => accountRequest<unknown>(operation, params),
    {
      id: 'xboard-account',
      errorNotice: false,
      onFulfilled: () => {
        if (operation === 'reset_security') snapshotVersion += 1
      },
      revalidate:
        operation === 'reset_security'
          ? [accountKey, ['getProfiles']]
          : [accountKey],
    },
  )
  return result.value
}

export async function copyAccountLink(telegram = false) {
  try {
    await mutate(
      telegram ? xboardCopyTelegramBinding : xboardCopySubscription,
      {
        id: 'xboard-account',
        errorNotice: false,
        revalidate: [accountKey],
      },
    )
  } catch (error) {
    snapshotVersion += 1
    await Promise.allSettled([revalidateQuery(accountKey)])
    throw error
  }
}

export async function copyInviteLink(code: string) {
  await mutate(
    () =>
      writeText(
        `https://ikun.iil.im/#/register?code=${encodeURIComponent(code)}`,
      ),
    {
      id: 'xboard-clipboard',
      errorNotice: false,
    },
  )
}

export async function openAccountWebsite(raw: string, telegram = false) {
  const url = new URL(raw, 'https://ikun.iil.im/')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (telegram &&
      (!['t.me', 'telegram.me'].includes(url.hostname) ||
        (url.port && url.port !== '443')))
  ) {
    throw new Error('Invalid website address')
  }
  await mutate(() => openExternalUrl(url.href), {
    id: 'xboard-external-link',
    errorNotice: false,
  })
}
