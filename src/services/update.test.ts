import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => vi.fn())
const cache = vi.hoisted(() => vi.fn())
vi.mock('./cmds', () => ({ checkIkunUpdate: backend }))
vi.mock('./query-client', () => ({ setCacheData: cache }))

const release = {
  version: '2.5.14',
  tag: 'ikun-preview-2.5.14.1',
  releaseUrl:
    'https://github.com/jinshenganyuci/clash-verge-rev/releases/tag/ikun-preview-2.5.14.1',
  downloadUrl:
    'https://github.com/jinshenganyuci/clash-verge-rev/releases/download/ikun-preview-2.5.14.1/IKUN_2.5.14_x64-setup.exe',
  body: 'Release notes',
  publishedAt: '2026-11-25T10:00:00Z',
  size: 1234,
}

beforeEach(() => {
  vi.resetModules()
  backend.mockReset()
  cache.mockReset()
  cache.mockResolvedValue(undefined)
  vi.stubGlobal('localStorage', {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
  })
})

afterEach(() => vi.unstubAllGlobals())

it('uses the verified release returned by the IKUN command', async () => {
  backend.mockResolvedValue(release)
  const { checkUpdateSafe, markUpdatePrompted } = await import('./update')
  expect(await checkUpdateSafe('automatic')).toEqual(release)
  expect(backend).toHaveBeenCalledExactlyOnceWith()
  expect(markUpdatePrompted(release.version)).toBe(true)
  expect(markUpdatePrompted(release.version)).toBe(false)
  expect(markUpdatePrompted('2.5.15')).toBe(true)
})

it('joins a pending automatic check and claims its prompt before manual results are returned', async () => {
  let finish!: (value: typeof release) => void
  backend.mockImplementation(
    () =>
      new Promise<typeof release>((resolve) => {
        finish = resolve
      }),
  )
  const { checkUpdateSafe, markUpdatePrompted } = await import('./update')
  const automatic = checkUpdateSafe('automatic')
  const manual = checkUpdateSafe()
  expect(manual).toBe(automatic)
  finish(release)
  expect(await automatic).toEqual(release)
  expect(markUpdatePrompted(release.version)).toBe(false)
  expect(await manual).toEqual(release)
  expect(backend).toHaveBeenCalledOnce()
})

it('checks automatically at startup and after 24 hours without repeating on remount', async () => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  backend.mockResolvedValue(null)
  const { checkUpdateSafe, UPDATE_CHECK_INTERVAL } = await import('./update')
  expect(await checkUpdateSafe('automatic')).toBeNull()
  now += UPDATE_CHECK_INTERVAL - 1
  expect(await checkUpdateSafe('automatic')).toBeNull()
  expect(backend).toHaveBeenCalledOnce()
  now += 1
  expect(await checkUpdateSafe('automatic')).toBeNull()
  expect(backend).toHaveBeenCalledTimes(2)
})

it('does not turn a failed manual check into a no-update success', async () => {
  const failure = new Error('IKUN_UPDATE_UNAVAILABLE')
  backend.mockRejectedValueOnce(failure).mockResolvedValueOnce(release)
  const { checkUpdateSafe } = await import('./update')
  await expect(checkUpdateSafe()).rejects.toBe(failure)
  expect(cache).not.toHaveBeenCalled()
  expect(await checkUpdateSafe()).toEqual(release)
  expect(backend).toHaveBeenCalledTimes(2)
})

it('does not retry failed automatic checks on remount but allows manual retry', async () => {
  backend
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(null)
  const { checkUpdateSafe } = await import('./update')
  await expect(checkUpdateSafe('automatic')).rejects.toThrow('Offline')
  expect(await checkUpdateSafe('automatic')).toBeNull()
  expect(backend).toHaveBeenCalledOnce()
  expect(await checkUpdateSafe('manual')).toBeNull()
  expect(backend).toHaveBeenCalledTimes(2)
})

it('retries an automatic failure after the next daily interval', async () => {
  let now = 1000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  backend
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(release)
  const { checkUpdateSafe, UPDATE_CHECK_INTERVAL } = await import('./update')
  await expect(checkUpdateSafe('automatic')).rejects.toThrow('Offline')
  now += UPDATE_CHECK_INTERVAL
  expect(await checkUpdateSafe('automatic')).toEqual(release)
  expect(backend).toHaveBeenCalledTimes(2)
})

it('keeps a successful check usable when local preference storage is unavailable', async () => {
  const unavailable = () => {
    throw new Error('Storage unavailable')
  }
  vi.stubGlobal('localStorage', {
    getItem: unavailable,
    setItem: unavailable,
  })
  backend.mockResolvedValue(release)
  const { checkUpdateSafe, readLastCheckTime } = await import('./update')
  expect(readLastCheckTime()).toBeNull()
  expect(await checkUpdateSafe()).toEqual(release)
  expect(cache).toHaveBeenCalledWith(
    ['ikun-last-check-update'],
    expect.any(Number),
  )
})

it('allows the same release to be prompted in a new app session', async () => {
  const firstSession = await import('./update')
  expect(firstSession.markUpdatePrompted(release.version)).toBe(true)
  expect(firstSession.markUpdatePrompted(release.version)).toBe(false)
  vi.resetModules()
  const nextSession = await import('./update')
  expect(nextSession.markUpdatePrompted(release.version)).toBe(true)
})
