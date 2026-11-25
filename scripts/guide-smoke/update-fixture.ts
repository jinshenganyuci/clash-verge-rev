import { commands } from '@/services/bindings'
import type { IkunUpdateInfo } from '@/services/update'

const scenario = new URLSearchParams(location.search).get('scenario')
const theme = new URLSearchParams(location.search).get('theme')
const project = 'https://github.com/jinshenganyuci/clash-verge-rev'
const tag = 'ikun-preview-2.5.14.1'
export const update: IkunUpdateInfo = {
  version: '2.5.14',
  tag,
  releaseUrl: `${project}/releases/tag/${tag}`,
  downloadUrl: `${project}/releases/download/${tag}/IKUN_2.5.14_x64-setup.exe`,
  body: '## IKUN 更新\n\n新版安装包已准备好。\n\n> [!NOTE]\n> 下载后由你决定何时安装。',
  publishedAt: '2026-11-25T12:00:00Z',
  size: 60000000,
}
const calls: string[] = []
const opened: string[] = []
const forbidden: string[] = []

export function installUpdateMocks() {
  localStorage.removeItem('ikun-last-check-update')
  const automatic = ![
    'update-disabled',
    'update-failure',
    'update-current',
  ].includes(scenario ?? '')
  Object.assign(commands, {
    getVergeConfig: async () => {
      calls.push('config')
      return {
        language: 'zh',
        auto_check_update: false,
        ...(automatic ? {} : { auto_check_ikun_update: false }),
      }
    },
    checkIkunUpdate: async () => {
      calls.push('check')
      if (scenario?.includes('failure')) {
        throw new Error('The fixture update request failed.')
      }
      return scenario === 'update-current' ? null : { ...update }
    },
  })
  for (const command of [
    'installUpdate',
    'restartApp',
    'cancelUpdateDownload',
  ]) {
    Object.assign(commands, {
      [command]: async () => {
        forbidden.push(command)
        throw new Error(`Unexpected update mutation: ${command}`)
      },
    })
  }
}

export const recordExternalUrl = async (url: string) => {
  opened.push(url)
}

export function updateFixtureState() {
  return {
    scenario,
    theme,
    calls: [...calls],
    opened: [...opened],
    forbidden: [...forbidden],
    lastCheck: localStorage.getItem('ikun-last-check-update'),
    expectedDownload: update.downloadUrl,
    expectedRelease: update.releaseUrl,
  }
}
