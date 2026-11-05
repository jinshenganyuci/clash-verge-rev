import { check } from '@tauri-apps/plugin-updater'
import { expect, it, vi } from 'vitest'

import { checkUpdateSafe } from './update'

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }))

it('never contacts the upstream application updater in Xboard builds', async () => {
  expect(await checkUpdateSafe()).toBeNull()
  expect(check).not.toHaveBeenCalled()
})
