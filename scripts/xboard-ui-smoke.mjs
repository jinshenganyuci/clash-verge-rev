import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
  process.platform !== 'win32'
) {
  throw new Error('UI smoke only runs on disposable Windows GitHub runners.')
}

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    mode: { type: 'string' },
    artifacts: { type: 'string' },
    'data-dir': { type: 'string' },
  },
})
const port = Number(values.port)
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !['first-run', 'reinstall'].includes(values.mode) ||
  !values.artifacts ||
  !values['data-dir']
) {
  throw new Error('Expected --port, --mode, --artifacts and --data-dir.')
}

async function waitFor(description, check) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let sequence = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('The application CDP connection closed.'))
    }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('CDP connection timed out.'))
    }, 10000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP connection failed.'))
    })
  })
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} timed out.`))
        }, 10000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

function inspectApp(action) {
  const normalize = (text) => text.replace(/\s/g, '')
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    )
  }
  const named = (selector, names) =>
    [...document.querySelectorAll(selector)].find(
      (element) =>
        visible(element) &&
        names.some(
          (name) => normalize(element.textContent ?? '') === normalize(name),
        ),
    )
  const welcome = named('h4', ['欢迎使用 IKUN', 'Welcome to IKUN'])
  const skip = named('button', [
    '暂时跳过，进入客户端',
    'Skip for now and open the client',
  ])
  const email = document.querySelector('input[type="email"]')
  const password = document.querySelector('input[type="password"]')
  const login = named('button', ['登录并同步订阅', 'Sign in and sync'])
  const signInTab = named('[role="tab"]', ['登录', 'Sign in'])
  const registerTab = named('[role="tab"]', ['注册账号', 'Register'])
  const account = named('[role="button"]', ['账户', '帳戶', 'Account'])
  const home = named('[role="button"]', ['首页', '首頁', 'Home'])
  const overlay = document.getElementById('initial-loading-overlay')
  const uncovered = !overlay || Number(getComputedStyle(overlay).opacity) === 0
  const main = uncovered && !welcome && !skip && account && home
  let skipPoint = null
  if (action === 'skip' && skip && !skip.disabled) {
    skip.scrollIntoView({ block: 'center' })
    const rect = skip.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    if (skip.contains(document.elementFromPoint(x, y))) skipPoint = { x, y }
  }
  return {
    welcome: Boolean(
      uncovered &&
        welcome &&
        skip &&
        !skip.disabled &&
        email &&
        visible(email) &&
        password &&
        visible(password) &&
        login &&
        signInTab &&
        registerTab,
    ),
    main: Boolean(main),
    skipPoint,
    width: innerWidth,
    height: innerHeight,
  }
}

let cdp
let screenshot
let lastState
const discovery = {
  endpoint: `http://127.0.0.1:${port}/json/list`,
  attempts: 0,
  response: null,
  targets: [],
  error: null,
}
function diagnosticUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href.slice(0, 512)
  } catch {
    return '[invalid URL]'
  }
}
try {
  const target = await waitFor('the Tauri application CDP page', async () => {
    discovery.attempts++
    try {
      const response = await fetch(discovery.endpoint, {
        signal: AbortSignal.timeout(2000),
      })
      discovery.response = {
        status: response.status,
        contentType: response.headers.get('content-type'),
      }
      const targets = await response.json()
      if (!Array.isArray(targets)) {
        throw new Error('CDP discovery returned a non-array JSON value.')
      }
      discovery.targets = targets.map((page) => ({
        type: page.type,
        url: diagnosticUrl(page.url),
        debuggerUrl: page.webSocketDebuggerUrl
          ? diagnosticUrl(page.webSocketDebuggerUrl)
          : null,
      }))
      discovery.error = null
      return targets.find((page) => {
        try {
          return (
            page.type === 'page' &&
            new URL(page.url).hostname === 'tauri.localhost' &&
            page.webSocketDebuggerUrl
          )
        } catch {
          return false
        }
      })
    } catch (error) {
      discovery.error = {
        name: error.name,
        message: error.message,
        cause: error.cause && {
          code: error.cause.code,
          address: error.cause.address,
          port: error.cause.port,
        },
      }
      return false
    }
  })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.call('Page.enable')
  await cdp.call('Page.bringToFront')
  const inspect = async (action = '') => {
    const result = await cdp.call('Runtime.evaluate', {
      expression: `(${inspectApp.toString()})(${JSON.stringify(action)})`,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error('Application DOM inspection failed.')
    }
    lastState = result.result.value
    return lastState
  }
  screenshot = async (name) => {
    const { data } = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const png = Buffer.from(data, 'base64')
    const signature = Buffer.from('89504e470d0a1a0a', 'hex')
    if (png.length < 24 || !png.subarray(0, 8).equals(signature)) {
      throw new Error('CDP did not return a PNG screenshot.')
    }
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (width < 640 || height < 400) {
      throw new Error(
        `Application screenshot is too small: ${width}x${height}.`,
      )
    }
    await writeFile(join(values.artifacts, name), png)
    return { width, height }
  }
  const markerPath = join(values['data-dir'], 'xboard-onboarding-complete')
  const completed = async () => {
    try {
      return (await readFile(markerPath, 'utf8')) === '1'
    } catch {
      return false
    }
  }
  const evidence = {
    mode: values.mode,
    page: diagnosticUrl(target.url),
    discovery,
  }
  if (values.mode === 'first-run') {
    if (await completed()) {
      throw new Error('Onboarding was already completed before the UI test.')
    }
    evidence.welcome = await waitFor('the real welcome form', async () => {
      const state = await inspect()
      return state.welcome && state
    })
    evidence.screenshot = await screenshot('first-run-window.png')
    const { skipPoint } = await inspect('skip')
    if (!skipPoint) {
      throw new Error('The real Skip button could not be clicked.')
    }
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...skipPoint,
      button: 'left',
      clickCount: 1,
    })
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...skipPoint,
      button: 'left',
      clickCount: 1,
    })
  }
  evidence.main = await waitFor(
    'home, account navigation and marker',
    async () => {
      const state = await inspect()
      return state.main && (await completed()) && state
    },
  )
  evidence.mainScreenshot = await screenshot(`${values.mode}-home.png`)
  evidence.markerWrittenByApp = true
  await writeFile(
    join(values.artifacts, `${values.mode}-ui.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  console.log(`${values.mode}: real UI and persisted onboarding passed.`)
} catch (error) {
  const failure = { error: error.message, lastState, discovery }
  console.error(JSON.stringify(failure, null, 2))
  await writeFile(
    join(values.artifacts, `${values.mode}-ui-failure.json`),
    `${JSON.stringify(failure, null, 2)}\n`,
  )
  if (screenshot) {
    try {
      await screenshot(`${values.mode}-failure.png`)
    } catch {
      // A crashed WebView may no longer expose a screenshot surface.
    }
  }
  throw error
} finally {
  cdp?.close()
}
