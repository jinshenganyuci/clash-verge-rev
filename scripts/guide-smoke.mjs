import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Guide UI smoke only runs on disposable Windows GitHub runners.')
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(repo, process.argv[2] ?? 'artifacts/guide-ui')
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'ikun-guide-ui-'))
const checks = []
const browserErrors = []
let server
let browser
let cdp
let lastState

async function waitFor(label, check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails)
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
      request.reject(new Error('Edge CDP closed'))
    }
    pending.clear()
  })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Edge CDP connection timed out')), 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Edge CDP connection failed')) }, { once: true })
  })
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      const id = ++sequence
      return new Promise((done, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 10000)
        pending.set(id, { resolve: done, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

async function evaluate(expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

function inspectPage() {
  const dialog = document.querySelector('[role="dialog"]')
  const fixture = window.__guideFixture?.state()
  const visibleButtons = [...(dialog?.querySelectorAll('button') ?? [])]
    .filter((element) => !element.disabled && element.getBoundingClientRect().width > 0)
    .map((element) => element.textContent.trim())
  return {
    fixture,
    text: dialog?.textContent ?? '',
    dialog: Boolean(dialog),
    buttons: visibleButtons,
    backgroundNode: Boolean(document.querySelector('[data-testid="background-node"]')),
    backgroundProxy: Boolean(document.querySelector('[data-testid="background-proxy"]')),
    main: Boolean(document.querySelector('[data-testid="normal-interface"]')),
    tunSelected: Boolean(document.querySelector('input[type="radio"][value="tun"]')?.checked),
    systemSelected: Boolean(document.querySelector('input[type="radio"][value="system"]')?.checked),
  }
}
async function inspect() {
  lastState = await evaluate(`(${inspectPage.toString()})()`)
  return lastState
}
async function click(selector, text) {
  const point = await evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => ${text === undefined ? 'true' : `item.textContent.trim() === ${JSON.stringify(text)}`});
    if (!element || element.disabled) return null;
    element.scrollIntoView({block:'center'});
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (!element.contains(document.elementFromPoint(x, y))) return null;
    return {x, y};
  })()`)
  assert.ok(point, `Clickable control: ${text ?? selector}`)
  await clickPoint(point)
  return point
}
async function clickPoint(point) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
async function screenshot(name) {
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const png = Buffer.from(data, 'base64')
  assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
  assert.ok(png.readUInt32BE(16) >= 1000 && png.readUInt32BE(20) >= 700)
  await writeFile(join(artifacts, name), png)
}
async function openScenario(scenario, theme) {
  await cdp.call('Page.navigate', { url: `${server.resolvedUrls.local[0]}?scenario=${scenario}&theme=${theme}` })
  await waitFor(`${scenario}: preparing`, async () => {
    const state = await inspect()
    return state.fixture?.guide.phase === 'testing' && state.dialog
  })
  const state = await inspect()
  assert.equal(state.backgroundNode, false)
  assert.equal(state.backgroundProxy, false)
  assert.deepEqual(state.buttons, ['暂不连接'])
  assert.equal(state.fixture.calls.filter((call) => call.command === 'prepare').length, 1)
  return state
}
async function ready() {
  await evaluate('window.__guideFixture.ready()')
  await waitFor('ready controls', async () => (await inspect()).buttons.includes('开始使用'))
  const state = await inspect()
  assert.equal(state.tunSelected, true)
  assert.equal(state.systemSelected, false)
  assert.equal(state.backgroundNode, false)
  assert.equal(state.backgroundProxy, false)
}

try {
  const edgeCandidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean).map((base) => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  let edge
  for (const candidate of edgeCandidates) {
    try { await access(candidate); edge = candidate; break } catch { /* Try the other standard install location. */ }
  }
  assert.ok(edge, 'Microsoft Edge is installed on the runner')
  server = await createServer({
    configFile: false,
    root: join(repo, 'scripts', 'guide-smoke'),
    plugins: [react()],
    resolve: { alias: [
      { find: '@/services/xboard', replacement: join(repo, 'scripts', 'guide-smoke', 'account-service.ts') },
      { find: '@', replacement: join(repo, 'src') },
    ] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
  })
  await server.listen()
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1100,820', 'about:blank'], { stdio: 'ignore' })
  let spawnError
  browser.on('error', (error) => { spawnError = error })
  const port = await waitFor('Edge debugger port', async () => {
    if (spawnError) throw spawnError
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]) } catch { return null }
  })
  const target = await waitFor('Edge page', async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
  })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.call('Page.enable')
  await cdp.call('Runtime.enable')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false })

  await openScenario('success', 'light')
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await clickPoint({ x: 5, y: 5 })
  assert.equal((await inspect()).dialog, true)
  assert.equal(lastState.fixture.calls.some((call) => call.command === 'cancel'), false)
  await ready()
  await screenshot('ready-light.png')
  const start = await click('button', '开始使用')
  await clickPoint(start)
  await waitFor('success message', async () => (await inspect()).text.includes('连接成功'))
  await waitFor('normal interface after completion', async () => (await inspect()).main)
  await delay(1200)
  const successful = await inspect()
  assert.equal(successful.fixture.calls.filter((call) => call.command === 'connect').length, 1)
  assert.equal(successful.fixture.calls.filter((call) => call.command === 'complete').length, 1)
  assert.equal(successful.fixture.calls.find((call) => call.command === 'connect').mode, 'tun')
  assert.equal(successful.fixture.pending, false)
  assert.ok(successful.fixture.reads >= 3, 'The real guide polling remains active during setup')
  checks.push({ scenario: 'success', state: successful })

  await openScenario('failure', 'dark')
  await ready()
  await screenshot('ready-dark.png')
  await click('button', '开始使用')
  await waitFor('TUN failure', async () => (await inspect()).buttons.includes('重试连接'))
  assert.equal(lastState.main, false)
  assert.equal(lastState.fixture.calls.some((call) => call.command === 'complete'), false)
  await click('input[type="radio"][value="system"]')
  assert.equal((await inspect()).systemSelected, true)
  await click('button', '重试连接')
  await waitFor('system proxy retry completed', async () => (await inspect()).main)
  const retried = await inspect()
  assert.deepEqual(retried.fixture.calls.filter((call) => call.command === 'connect').map((call) => call.mode), ['tun', 'system'])
  assert.equal(retried.fixture.calls.filter((call) => call.command === 'complete').length, 1)
  checks.push({ scenario: 'failure', state: retried })

  await openScenario('cancel', 'light')
  await click('button', '暂不连接')
  await waitFor('cancelled guide closes', async () => (await inspect()).main)
  await delay(1200)
  const cancelled = await inspect()
  assert.equal(cancelled.fixture.calls.filter((call) => call.command === 'cancel').length, 1)
  assert.equal(cancelled.fixture.calls.some((call) => call.command === 'connect' || call.command === 'complete'), false)
  assert.equal(cancelled.fixture.pending, false)
  checks.push({ scenario: 'cancel', state: cancelled })
  assert.deepEqual(browserErrors, [])
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ status: 'passed', checks }, null, 2))
  console.log('Guide UI smoke passed: success, system fallback and cancellation; light/dark screenshots saved.')
} catch (error) {
  if (cdp) await screenshot('failure.png').catch(() => {})
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ error: String(error), lastState, browserErrors, checks }, null, 2))
  throw error
} finally {
  cdp?.close()
  if (browser?.pid) spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' })
  await server?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
}
