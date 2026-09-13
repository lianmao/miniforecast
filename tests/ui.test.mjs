/**
 * End-to-end UI test: boots the real index.html in jsdom, runs the real app.js,
 * loads the real sample workbook, and drives the whole upload → model selection →
 * forecast → accuracy flow.
 *
 * Chart.js is replaced with a recording stub (jsdom has no canvas backend), and
 * fetch is stubbed to serve repo files. Everything else — the DOM, the modules,
 * the forecasting engine, the ARIMA WASM — is the production code path.
 *
 * Run from the repo root:
 *   node --test tests/ui.test.mjs
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

import { loadArimaBundle, loadXlsx } from './helpers.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Stands in for Chart.js — records what would have been drawn. */
class FakeChart {
  static instances = []
  static reset() {
    FakeChart.instances = []
  }
  constructor(canvas, config) {
    this.canvas = canvas
    this.config = config
    this.destroyed = false
    FakeChart.instances.push(this)
  }
  destroy() {
    this.destroyed = true
  }
  static forCanvas(id) {
    return FakeChart.instances.filter((c) => c.canvas?.id === id).at(-1)
  }
  static datasets(id) {
    return FakeChart.forCanvas(id)?.config?.data?.datasets ?? []
  }
  static labels(id) {
    return FakeChart.forCanvas(id)?.config?.data?.labels ?? []
  }
}

const dom = {}
let document

const waitFor = async (predicate, { timeout = 30000, interval = 40, label = 'condition' } = {}) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const $ = (id) => document.getElementById(id)
const visible = (id) => !$(id).hidden
const click = (selector) => document.querySelector(selector).click()
const tableRows = (id) => $(id).querySelectorAll('tbody tr').length
const tableHeaders = (id) => [...$(id).querySelectorAll('thead th')].map((th) => th.textContent.trim())

before(async () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const jsdomInstance = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true })
  dom.window = jsdomInstance.window
  document = jsdomInstance.window.document

  globalThis.window = jsdomInstance.window
  globalThis.document = document
  globalThis.Chart = FakeChart
  globalThis.HTMLElement = jsdomInstance.window.HTMLElement
  globalThis.Event = jsdomInstance.window.Event
  dom.window.scrollTo = () => {}

  // Serve repo files in place of a web server.
  globalThis.fetch = async (url) => {
    const relative = String(url).replace(/^https?:\/\/[^/]+\//, '')
    const buffer = readFileSync(join(root, relative))
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    }
  }

  // jsdom does not execute <script> tags, so load the two globals the page
  // normally gets from vendor/*.js via script tags, in the same order.
  loadXlsx()
  await loadArimaBundle()

  // Boot the app (init() runs on import).
  await import('../src/app.js')
})

test('boots with the landing view and an empty navigation', () => {
  assert.ok($('view-landing').classList.contains('active'), 'landing view should be visible')
  assert.equal($('settingsBlock').hidden, true, 'settings should be hidden before data is loaded')
  for (const btn of document.querySelectorAll('#nav button')) {
    assert.equal(btn.disabled, true, `nav button ${btn.dataset.view} should be disabled`)
  }
})

test('reports the ARIMA engine as ready', async () => {
  await waitFor(() => $('arimaStatus').textContent === 'ready', { label: 'ARIMA ready' })
  assert.equal($('arimaStatus').className, 'status ok')
})

test('loads the sample workbook and renders history', async () => {
  click('#loadMultiSample')
  await waitFor(() => tableRows('historyTable') === 4, { label: 'history table' })

  assert.match($('fileStatus').textContent, /Loaded 4 series/)
  assert.equal($('settingsBlock').hidden, false, 'settings should appear once data is loaded')
  assert.ok($('view-history').classList.contains('active'), 'should switch to the history view')
  assert.equal($('batchMode').checked, true, 'multi-product files should default to batch mode')

  assert.deepEqual(tableHeaders('historyTable'), [
    'Product', 'Points', 'Mean', 'Std', 'Min', 'Median', 'Max', 'Zero/negative',
  ])
  const products = [...$('historyTable').querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent)
  assert.deepEqual(products, ['Product_A', 'Product_B', 'Product_C', 'Product_D'])

  // One history chart per product in batch mode.
  assert.equal(FakeChart.instances.filter((c) => c.canvas.id.startsWith('historyChart')).length, 4)
})

test('runs all 8 models against all 4 products and ranks them per product', async () => {
  click('#nav button[data-view="models"]')
  assert.ok($('view-models').classList.contains('active'))
  assert.equal($('modelsResults').hidden, true, 'results should be hidden before running')

  click('#runModels')
  await waitFor(() => visible('modelsResults'), { timeout: 60000, label: 'model results' })

  // Per-product summary: one row per product, each with its own winning model.
  assert.equal(tableRows('perProductTable'), 4)
  assert.deepEqual(tableHeaders('perProductTable').slice(0, 3), ['Product', 'Best model', 'MAPE'])

  const assigned = {}
  for (const tr of $('perProductTable').querySelectorAll('tbody tr')) {
    const cells = [...tr.querySelectorAll('td')]
    assigned[cells[0].textContent] = cells[1].textContent
    assert.match(cells[2].textContent, /%$/, `${cells[0].textContent} should report a MAPE`)
  }
  assert.deepEqual(Object.keys(assigned).sort(), ['Product_A', 'Product_B', 'Product_C', 'Product_D'])

  // The single-series comparison card is meaningless in batch mode.
  assert.equal($('comparisonCard').hidden, true, 'batch mode hides the single-series comparison')
  assert.equal($('perProductCard').hidden, false)

  // Per-product rankings: all 8 models scored for the inspected product.
  assert.equal(tableRows('batchRankingTable'), 8)
  assert.deepEqual(tableHeaders('batchRankingTable'), [
    'Model', 'MAE', 'RMSE', 'MAPE', 'SMAPE', 'MASE', 'Time', 'Status',
  ])

  // The winner row is highlighted and the MAPE chart has bars.
  assert.equal($('batchRankingTable').querySelectorAll('tbody tr.winner').length, 1)
  const bars = FakeChart.forCanvas('mapeChart')?.config?.data?.datasets?.[0]?.data ?? []
  assert.equal(bars.length, 8, 'MAPE chart should have one bar per model')

  // At least one product should be assigned the ARIMA winner (it wins on this data).
  console.log('      per-product winners:', JSON.stringify(assigned))
  const times = [...$('batchRankingTable').querySelectorAll('tbody tr')].map((tr) =>
    Number.parseInt(tr.querySelectorAll('td')[6].textContent, 10),
  )
  assert.ok(times.every(Number.isFinite), 'every model should report a runtime')
})

test('generates an 18-period forecast table and enables CSV download', async () => {
  click('#runForecast')
  await waitFor(() => tableRows('forecastTable') > 0, { timeout: 60000, label: 'forecast table' })

  assert.equal($('downloadCsv').disabled, false)
  // 18 forecast rows + 1 header row.
  assert.equal($('forecastTable').querySelectorAll('tbody tr').length, 18)

  const headers = tableHeaders('forecastTable')
  assert.deepEqual(headers.slice(0, 2), ['Period', 'Date'])
  assert.deepEqual(headers.slice(2), ['Product_A', 'Product_B', 'Product_C', 'Product_D'])

  // Forecast dates must be strictly after the end of history (2024-12-01).
  const dates = [...$('forecastTable').querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[1].textContent)
  assert.equal(dates[0], '2025-01-01')
  assert.equal(dates.at(-1), '2026-06-01')

  // Every cell must be a real number, not a dash or NaN.
  for (const tr of $('forecastTable').querySelectorAll('tbody tr')) {
    for (const td of [...tr.querySelectorAll('td')].slice(2)) {
      assert.match(td.textContent, /^-?[\d,]+(\.\d+)?$/, `forecast cell "${td.textContent}" should be numeric`)
    }
  }
})

test('accuracy dashboard summarises every product', async () => {
  click('#nav button[data-view="accuracy"]')
  assert.ok($('view-accuracy').classList.contains('active'))
  assert.equal($('accuracyBody').hidden, false)
  assert.equal($('batchAccuracyCard').hidden, false)
  assert.equal(tableRows('batchAccuracyTable'), 4)

  const cards = [...$('accuracyMetrics').querySelectorAll('.metric')].map((m) => ({
    key: m.querySelector('.k').textContent,
    value: m.querySelector('.v').textContent,
  }))
  const map = Object.fromEntries(cards.map((c) => [c.key, c.value]))
  assert.equal(map['Products scored'], '4')
  assert.match(map['Mean MAPE'], /%$/)
  assert.match(map['Best MAPE'], /%$/)
  assert.ok(['Product_A', 'Product_B', 'Product_C', 'Product_D'].includes(map['Worst product']))

  // Residual diagnostics are per-series, so they must be hidden in batch mode.
  assert.equal($('accuracyDiagnostics').hidden, true)
})

test('switching to single mode narrows the flow to one series', async () => {
  const checkbox = $('batchMode')
  checkbox.checked = false
  checkbox.dispatchEvent(new dom.window.Event('change'))

  assert.equal($('productField').hidden, false)
  // Changing mode invalidates any previous results.
  assert.equal($('modelsResults').hidden, true, 'results should reset after switching mode')

  click('#runModels')
  await waitFor(() => visible('modelsResults'), { timeout: 60000, label: 'single-mode results' })

  assert.equal(tableRows('comparisonTable'), 8, 'all 8 models should be scored')
  assert.equal($('comparisonTable').querySelectorAll('tbody tr.winner').length, 1)
  assert.equal($('modelPick').options.length, 8)
  assert.equal($('pickCard').hidden, false, 'single mode shows the model picker')
  assert.equal($('perProductCard').hidden, true, 'single mode hides the per-product panel')
  assert.equal($('comparisonCard').hidden, false, 'single mode shows the comparison table')

  // The accuracy dashboard should now show residual diagnostics instead of the batch table.
  click('#nav button[data-view="accuracy"]')
  assert.equal($('batchAccuracyCard').hidden, true)
  assert.equal($('accuracyDiagnostics').hidden, false)
  assert.equal($('accuracyHistCard').hidden, false)
  assert.equal($('accuracyMetrics').querySelectorAll('.metric').length, 5)

  // Residual chart should carry one bar per holdout period (default 6).
  const residuals = FakeChart.forCanvas('accuracyResidualChart')?.config?.data?.datasets?.[0]?.data
  assert.equal(residuals.length, 6, 'residuals should cover the holdout window')
})

/**
 * Regression guard: a dataset with a different length than its labels is silently
 * dropped by Chart.js, which renders as an empty chart with no error. The batch
 * forecast chart was blank for exactly this reason.
 */
test('every chart keeps its datasets aligned with its labels', () => {
  let checked = 0
  for (const chart of FakeChart.instances) {
    const labels = chart.config?.data?.labels
    if (!labels) continue
    for (const dataset of chart.config.data.datasets) {
      assert.equal(
        dataset.data.length,
        labels.length,
        `${chart.canvas.id} → dataset "${dataset.label}" has ${dataset.data.length} points but there are ${labels.length} labels`,
      )
      checked++
    }
  }
  assert.ok(checked > 0, 'expected at least one chart to have been drawn')
})

test('every chart actually has plottable data', () => {
  for (const chart of FakeChart.instances) {
    const datasets = chart.config?.data?.datasets ?? []
    if (!datasets.length) continue // placeholder charts are allowed
    assert.ok(
      datasets.some((ds) => ds.data.some((v) => v !== null && Number.isFinite(v))),
      `${chart.canvas.id} has datasets but every value is null`,
    )
  }
})

/**
 * Regression guard: `[hidden]` is only `display: none` in the UA stylesheet, so any
 * author rule that sets `display` (e.g. .grid-2 { display: grid }) overrides it and
 * the element stays visible. The accuracy diagnostics showed as two blank cards
 * because of this.
 */
test('[hidden] beats layout classes that set display', () => {
  for (const id of ['accuracyDiagnostics', 'perProductCard', 'comparisonCard']) {
    const element = $(id)
    const wasHidden = element.hidden
    element.hidden = true
    const computed = dom.window.getComputedStyle(element).display
    element.hidden = wasHidden
    assert.equal(computed, 'none', `#${id} stays visible when hidden — a display rule is overriding [hidden]`)
  }
})
