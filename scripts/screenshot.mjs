/**
 * One-off: drive the app in a real browser and capture screenshots of each view,
 * so the layout can actually be looked at (not just asserted against).
 *
 *   node scripts/screenshot.mjs [url] [outDir]
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const URL_TO_OPEN = process.argv[2] || 'http://localhost:8080/'
const OUT = process.argv[3] || '/tmp/miniforecast-shots'
const PORT = 9334

function findChrome() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds) {
    for (const rel of [
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ]) {
      const candidate = join(cache, build, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('no Chrome found')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1440,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(process.env.TMPDIR || '/tmp', 'miniforecast-shot-profile')}`,
    URL_TO_OPEN,
  ],
  { stdio: 'ignore' },
)

async function fetchJson(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(250)
  }
  throw new Error('chrome not reachable')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 1
    const pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        const { resolve: res, reject: rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const mid = id++
          ws.send(JSON.stringify({ id: mid, method, params }))
          return new Promise((res, rej) => pending.set(mid, { resolve: res, reject: rej }))
        },
        close: () => ws.close(),
      }),
    )
  })
}

try {
  await fetchJson(`http://127.0.0.1:${PORT}/json/version`)
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`)
  const page = targets.find((t) => t.type === 'page')
  const client = await connect(page.webSocketDebuggerUrl)
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  })

  const shoot = async (name, expression) => {
    const { result } = await client.send('Runtime.evaluate', { expression, awaitPromise: true })
    if (result.subtype === 'error') throw new Error(result.description)
    await sleep(900)
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    console.log('  captured', `${name}.png`)
  }

  const sleepFn = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));'
  const ready = 'await sleep(4000);'
  await shoot('01-landing', `(async()=>{${sleepFn}${ready}})()`)

  await shoot(
    '02-history',
    `(async()=>{${sleepFn}
      document.getElementById('loadMultiSample').click();
      const t0=Date.now();
      while(Date.now()-t0<20000){ if(document.querySelectorAll('#historyTable tbody tr').length===4) break; await sleep(50) }
      await sleep(1200);
    })()`,
  )

  await shoot(
    '03-model-selection',
    `(async()=>{${sleepFn}
      document.querySelector('#nav button[data-view="models"]').click();
      document.getElementById('runModels').click();
      const t0=Date.now();
      while(Date.now()-t0<120000){ if(!document.getElementById('modelsResults').hidden) break; await sleep(100) }
      await sleep(1200);
    })()`,
  )

  await shoot(
    '04-forecast',
    `(async()=>{${sleepFn}
      document.getElementById('runForecast').click();
      const t0=Date.now();
      while(Date.now()-t0<120000){ if(document.querySelectorAll('#forecastTable tbody tr').length>0) break; await sleep(100) }
      document.querySelector('#nav button[data-view="forecast"]').click();
      await sleep(1500);
    })()`,
  )

  await shoot(
    '05-accuracy',
    `(async()=>{${sleepFn}
      document.querySelector('#nav button[data-view="accuracy"]').click();
      await sleep(1500);
    })()`,
  )

  await shoot(
    '06-single-mode',
    `(async()=>{${sleepFn}
      const cb=document.getElementById('batchMode'); cb.checked=false;
      cb.dispatchEvent(new Event('change'));
      document.querySelector('#nav button[data-view="models"]').click();
      document.getElementById('runModels').click();
      const t0=Date.now();
      while(Date.now()-t0<120000){ if(!document.getElementById('modelsResults').hidden) break; await sleep(100) }
      await sleep(1200);
    })()`,
  )

  client.close()
  console.log(`\nsaved to ${OUT}`)
} finally {
  chrome.kill()
}
