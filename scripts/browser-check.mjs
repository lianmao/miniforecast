/**
 * Real-browser end-to-end check via the Chrome DevTools Protocol.
 *
 * Launches headless Chrome, opens the locally served app, and drives the whole
 * planner flow — load sample data, run all models, generate a forecast, open the
 * accuracy dashboard — reporting what the real DOM ended up containing and any
 * console errors or uncaught exceptions.
 *
 * jsdom (tests/ui.test.mjs) covers the same path faster, but it is not a browser:
 * this script is what proves the module graph, Chart.js rendering and the ARIMA
 * WASM all work in a real engine.
 *
 * Usage:
 *   node scripts/serve.mjs &          # app must be reachable
 *   node scripts/browser-check.mjs [url] [chrome-path] [port]
 *
 * Exits non-zero if any assertion fails.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const URL_TO_OPEN = process.argv[2] || 'http://localhost:8080/'
const PORT = Number(process.argv[4] || 9333)

/** Finds the newest Playwright-managed Chromium, or falls back to system Chrome. */
function findChrome() {
  if (process.argv[3]) return process.argv[3]
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      for (const rel of [
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
      ]) {
        const candidate = join(cache, build, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome binary found — pass the path as the 2nd argument')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`could not reach ${url}`)
}

/** Minimal CDP client over the WebSocket that Node ships with. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    const events = []

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const { resolve: res, reject: rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(message.error.message))
        else res(message.result)
      } else if (message.method) {
        events.push(message)
      }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () =>
      resolve({
        events,
        send(method, params = {}) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params }))
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }))
        },
        close: () => ws.close(),
      }),
    )
  })
}

// The whole flow, executed inside the page.
const DRIVER = `(async () => {
  const $ = (id) => document.getElementById(id)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (fn, ms, label) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return; await sleep(50) }
    throw new Error('timeout: ' + label)
  }
  const rows = (id) => [...document.querySelectorAll('#' + id + ' tbody tr')].map(
    (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))

  const out = {}

  // app.js must have run before anything is clickable — the static HTML contains
  // an #arimaStatus placeholder, so its mere presence proves nothing.
  await wait(() => ['ready', 'unavailable — the other 7 models still work'].includes($('arimaStatus').textContent), 90000, 'app initialised')
  out.arimaStatus = $('arimaStatus').textContent

  document.getElementById('loadMultiSample').click()
  await wait(() => rows('historyTable').length === 4, 90000, 'history table')
  out.fileStatus = $('fileStatus').textContent
  out.products = rows('historyTable').map((r) => r[0])
  out.historyCanvases = document.querySelectorAll('#historyCharts canvas').length
  // A rendered canvas has non-zero backing size in a real browser.
  const c0 = document.querySelector('#historyCharts canvas')
  out.canvasBackingSize = c0 ? c0.width + 'x' + c0.height : 'none'

  document.querySelector('#nav button[data-view="models"]').click()
  document.getElementById('runModels').click()
  await wait(() => !$('modelsResults').hidden, 120000, 'model results')
  out.perProduct = rows('perProductTable')
  out.rankingRowCount = rows('batchRankingTable').length
  out.modelsTiming = $('modelsTiming').textContent
  out.mapeBars = (window.Chart && Chart.getChart('mapeChart')) ? Chart.getChart('mapeChart').data.datasets[0].data.length : -1

  document.getElementById('runForecast').click()
  await wait(() => rows('forecastTable').length > 0, 120000, 'forecast table')
  out.forecastRowCount = rows('forecastTable').length
  out.forecastHead = rows('forecastTable')[0]
  out.forecastTail = rows('forecastTable').at(-1)
  out.csvEnabled = !$('downloadCsv').disabled

  document.querySelector('#nav button[data-view="accuracy"]').click()
  out.batchAccuracyRows = rows('batchAccuracyTable').length
  out.metricCards = [...document.querySelectorAll('#accuracyMetrics .metric')].map(
    (m) => m.querySelector('.k').textContent + ' = ' + m.querySelector('.v').textContent)

  out.totalCanvases = document.querySelectorAll('canvas').length
  out.chartsRendered = Object.keys(window.Chart ? Chart.instances : {}).length
  return JSON.stringify(out)
})()`

const failures = []
function check(label, condition, detail = '') {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!condition) failures.push(label)
}

const chromePath = findChrome()
console.log(`Chrome: ${chromePath}`)
console.log(`Target: ${URL_TO_OPEN}\n`)

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TMPDIR || '/tmp', 'miniforecast-cdp-profile')}`,
    URL_TO_OPEN,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

let stderr = ''
chrome.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

try {
  await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('no page target found')

  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Log.enable')
  await client.send('Page.enable')

  // The debugger target exists as soon as Chrome creates it, which can be before
  // the document is parsed — and over a real network (GitHub Pages) that gap is
  // long enough to bite. Wait for the app shell before driving it.
  let shellReady = false
  for (let i = 0; i < 150; i++) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: "document.readyState === 'complete' && Boolean(document.getElementById('arimaStatus'))",
      returnByValue: true,
    })
    if (result.value === true) {
      shellReady = true
      break
    }
    await sleep(200)
  }
  if (!shellReady) console.log('  [warn] app shell did not appear within 30s — driving anyway')
  else console.log('App shell ready.\n')

  console.log('Driving the app in a real browser…\n')
  const result = await client.send('Runtime.evaluate', {
    expression: DRIVER,
    awaitPromise: true,
    returnByValue: true,
  })

  if (result.exceptionDetails) {
    const e = result.exceptionDetails
    console.log('  [FAIL] flow threw inside the page')
    console.log('        ', e.exception?.description || e.text)
    failures.push('page flow')
  } else {
    const out = JSON.parse(result.result.value)

    check('ARIMA engine ready in a real browser', out.arimaStatus === 'ready', out.arimaStatus)
    check('sample workbook loaded', /Loaded 4 series/.test(out.fileStatus), out.fileStatus)
    check('4 products detected', out.products.length === 4, out.products.join(', '))
    check('4 history canvases rendered', out.historyCanvases === 4)
    check(
      'canvas has a real backing buffer (Chart.js actually drew)',
      /^[1-9]\d*x[1-9]\d*$/.test(out.canvasBackingSize),
      out.canvasBackingSize,
    )
    check('all 8 models scored', out.rankingRowCount === 8, `${out.rankingRowCount} rows`)
    check('every product got a best model', out.perProduct.length === 4)
    check(
      'best models are named, with a MAPE %',
      out.perProduct.every((r) => r[1] && /%$/.test(r[2])),
    )
    check('MAPE chart has 8 bars', out.mapeBars === 8, String(out.mapeBars))
    check('forecast produced 18 periods', out.forecastRowCount === 18, `${out.forecastRowCount} rows`)
    check('forecast starts 2025-01-01', out.forecastHead?.[1] === '2025-01-01', out.forecastHead?.[1])
    check('forecast ends 2026-06-01', out.forecastTail?.[1] === '2026-06-01', out.forecastTail?.[1])
    check(
      'forecast values are numeric',
      out.forecastHead.slice(2).every((v) => /^-?[\d,]+(\.\d+)?$/.test(v)),
      out.forecastHead.slice(2).join(' | '),
    )
    check('CSV export enabled', out.csvEnabled === true)
    check('batch accuracy table has 4 rows', out.batchAccuracyRows === 4)
    check('accuracy metric cards populated', out.metricCards.length === 5)

    console.log('\n  per-product winners:')
    for (const [product, model, mape] of out.perProduct) {
      console.log(`    ${product.padEnd(12)} ${model.padEnd(28)} ${mape}`)
    }
    console.log('\n  accuracy cards:')
    for (const card of out.metricCards) console.log('   ', card)
    console.log(`\n  ${out.modelsTiming} · ${out.totalCanvases} canvases on the page`)
  }

  // Console errors / uncaught exceptions raised while the flow ran.
  const problems = client.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
    .map((e) =>
      e.method === 'Runtime.exceptionThrown'
        ? e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text
        : `${e.params.entry.level}: ${e.params.entry.text}`,
    )
    .filter((text) => text && !/favicon|DevTools/.test(text))
  check('no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 3).join(' | '))

  client.close()
} catch (err) {
  console.log(`  [FAIL] ${err.message}`)
  failures.push(err.message)
} finally {
  chrome.kill()
}

console.log('\n' + '='.repeat(60))
if (failures.length) {
  console.log(`RESULT: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('RESULT: ALL BROWSER CHECKS PASSED')
