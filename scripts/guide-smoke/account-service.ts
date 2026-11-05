import { setCacheData } from '@/services/query-client'

export type ConnectionMode = 'tun' | 'system'
type Phase =
  | 'idle'
  | 'syncing'
  | 'testing'
  | 'ready'
  | 'connecting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export type ConnectionGuide = {
  attempt_id: number
  phase: Phase
  mode: ConnectionMode
  group_name: string | null
  node_name: string | null
  latency_ms: number | null
  error: string | null
  error_stage: 'prepare' | 'connect' | null
  tested: number
  total: number
}
export type AccountOperation = string
export type AccountParams = Record<string, string | number>
export const accountKey = ['xboardSnapshot'] as const
export const connectionGuideKey = ['xboardGuideSnapshot'] as const

const scenario = new URLSearchParams(location.search).get('scenario')
const calls: Array<{
  command: string
  attemptId?: number
  mode?: ConnectionMode
}> = []
let reads = 0
let account = {
  onboarding_complete: true,
  guide_pending: true,
  signed_in: true,
  email: 'fixture@example.invalid',
  profile_uid: null,
  last_sync: null,
  subscription: null,
  error: null,
}
let guide: ConnectionGuide = {
  attempt_id: 0,
  phase: 'idle',
  mode: 'tun',
  group_name: null,
  node_name: null,
  latency_ms: null,
  error: null,
  error_stage: null,
  tested: 0,
  total: 3,
}

const publishGuide = () => setCacheData(connectionGuideKey, { ...guide })
export const readAccount = async () => ({ ...account })
export const readConnectionGuide = async () => {
  reads += 1
  return { ...guide }
}
export const refreshAccount = async () => ({ ...account })
export async function prepareConnectionGuide() {
  calls.push({ command: 'prepare' })
  guide = { ...guide, attempt_id: guide.attempt_id + 1, phase: 'testing' }
  await publishGuide()
  return { ...guide }
}
export async function cancelConnectionGuide() {
  calls.push({ command: 'cancel' })
  guide = { ...guide, phase: 'cancelled' }
  account = { ...account, guide_pending: false }
  await publishGuide()
  await setCacheData(accountKey, { ...account })
  return { ...guide }
}
export async function connectAccount(attemptId: number, mode: ConnectionMode) {
  calls.push({ command: 'connect', attemptId, mode })
  if (guide.phase !== 'ready' && guide.phase !== 'failed')
    throw new Error('Unexpected connection command')
  guide = {
    ...guide,
    phase: 'connecting',
    mode,
    error: null,
    error_stage: null,
  }
  await publishGuide()
  window.setTimeout(() => {
    const firstFailure =
      scenario === 'failure' &&
      calls.filter((call) => call.command === 'connect').length === 1
    guide = firstFailure
      ? {
          ...guide,
          phase: 'failed',
          error_stage: 'connect',
          error: 'TUN could not be enabled. Retry or choose system proxy.',
        }
      : { ...guide, phase: 'succeeded' }
  }, 100)
  return { ...guide }
}
export async function completeConnectionGuide(attemptId: number) {
  calls.push({ command: 'complete', attemptId })
  if (guide.phase !== 'succeeded') throw new Error('Completion before success')
  account = { ...account, guide_pending: false }
  await setCacheData(accountKey, { ...account })
  return { ...guide }
}

const outsideScope = async (): Promise<never> => {
  throw new Error('Authentication is outside this fixture')
}
export const accountWrite = outsideScope
export const accountRequest = outsideScope
export const completeOnboarding = outsideScope
export const openAccountWebsite = outsideScope
export const registerAccount = outsideScope
export const signIn = outsideScope
export const readRegistrationPolicy = outsideScope

// This driver exists only in the standalone fixture, which the production entry never imports.
Object.assign(window, {
  __guideFixture: {
    ready() {
      guide = {
        ...guide,
        phase: 'ready',
        tested: 3,
        group_name: '自动选择',
        node_name: '可用线路 A',
        latency_ms: 42,
      }
    },
    state() {
      return { calls, reads, guide, pending: account.guide_pending }
    },
  },
})
