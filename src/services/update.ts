import { checkIkunUpdate } from './cmds'
import { setCacheData } from './query-client'

export type IkunUpdateInfo = NonNullable<
  Awaited<ReturnType<typeof checkIkunUpdate>>
>

export const IKUN_UPDATE_KEY = ['checkIkunUpdate'] as const
export const LAST_CHECK_KEY = 'ikun-last-check-update'
export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000

let pendingCheck: Promise<IkunUpdateInfo | null> | null = null
let manualCheckRequested = false
let lastAttempt: number | null = null
let latestUpdate: IkunUpdateInfo | null = null
const promptedVersions = new Set<string>()

export function markUpdatePrompted(version: string): boolean {
  if (promptedVersions.has(version)) return false
  promptedVersions.add(version)
  return true
}

export function readLastCheckTime(): number | null {
  try {
    const stored = localStorage.getItem(LAST_CHECK_KEY)
    if (!stored) return null
    const timestamp = Number(stored)
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
  } catch {
    return null
  }
}

export function updateLastCheckTime(timestamp = Date.now()): number {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(timestamp))
  } catch {
    // A display preference must not discard a successful release check.
  }
  void setCacheData([LAST_CHECK_KEY], timestamp)
  return timestamp
}

export function checkUpdateSafe(
  source: 'automatic' | 'manual' = 'manual',
): Promise<IkunUpdateInfo | null> {
  if (source === 'manual') manualCheckRequested = true
  if (pendingCheck) return pendingCheck
  const now = Date.now()
  if (
    source === 'automatic' &&
    lastAttempt !== null &&
    now - lastAttempt < UPDATE_CHECK_INTERVAL
  ) {
    return Promise.resolve(latestUpdate)
  }
  lastAttempt = now
  pendingCheck = checkIkunUpdate()
    .then((update) => {
      latestUpdate = update
      if (update && manualCheckRequested) markUpdatePrompted(update.version)
      updateLastCheckTime()
      return update
    })
    .finally(() => {
      pendingCheck = null
      manualCheckRequested = false
    })
  return pendingCheck
}
