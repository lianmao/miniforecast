/**
 * MiniForecast UI.
 *
 * Single-page app over the modules in this folder. No framework, no bundler —
 * plain ES modules, loaded straight by index.html.
 *
 * State lives in one object. Views are pure-ish render functions that read it.
 * All forecasting happens on the main thread; ARIMA's WASM compile is the only
 * thing that takes long enough to be worth reporting progress for.
 */

import { parseWorkbook, inferFrequency, futureDates, formatDate, formatNumber } from './data.js'
import { MODELS, MODEL_BY_KEY, evaluateAll, forecastWith } from './models.js'
import { computeAll, formatMetric, ratingFromMape } from './metrics.js'
import { loadArima } from './arima.js'

const $ = (id) => document.getElementById(id)

const state = {
  columns: [], // [{name, dates, values, points}]
  frequency: 'monthly',
  dateColumn: '',
  mode: 'single',
  selected: null, // series name (single mode)
  inspectProduct: null, // series name shown in batch detail panels
  testPeriods: 6,
  seasonality: 12,
  horizon: 18,
  evaluations: {}, // name -> { rows, train, test, ... }
  chosen: {}, // name -> model key
  forecasts: {}, // name -> { key, name, values, dates, note }
  charts: {},
  busy: false,
  view: 'landing',
}

// ---------------------------------------------------------------- charts

const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#17becf', '#bcbd22']

function drawChart(canvasId, config) {
  const canvas = $(canvasId)
  if (!canvas) return
  if (state.charts[canvasId]) state.charts[canvasId].destroy()
  state.charts[canvasId] = new Chart(canvas, config)
}

const GRID = { color: 'rgba(0,0,0,.06)' }

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { padding: 8, titleFont: { size: 12 }, bodyFont: { size: 12 } },
    },
    scales: { x: { grid: GRID, ticks: { font: { size: 11 } } }, y: { grid: GRID, ticks: { font: { size: 11 } } } },
    ...extra,
  }
}

// ---------------------------------------------------------------- helpers

function seriesByName(name) {
  return state.columns.find((c) => c.name === name) || state.columns[0]
}

/** Names of the series currently in scope (all of them in batch mode). */
function activeSeries() {
  return state.mode === 'batch' ? state.columns : [seriesByName(state.selected)]
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function setStatus(message, kind = '') {
  const el = $('fileStatus')
  el.className = `status ${kind}`
  el.textContent = message
}

function ratingBadge(name, mapeValue) {
  const rating = ratingFromMape(mapeValue)
  const tone = rating.tone === 'neutral' ? '' : rating.tone
  return `<span class="badge ${tone}">${escapeHtml(name)} · ${rating.label}</span>`
}

// ---------------------------------------------------------------- view switching

function showView(view) {
  state.view = view
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'))
  $(`view-${view}`).classList.add('active')
  document.querySelectorAll('#nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view)
  })
  // Charts measured while their container was display:none come back as 0x0, so
  // re-measure anything already drawn now that the view is actually visible.
  for (const chart of Object.values(state.charts)) chart.resize?.()
  if (view === 'models') renderModels()
  if (view === 'forecast') renderForecast()
  if (view === 'accuracy') renderAccuracy()
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
}

function updateNavState() {
  $('settingsBlock').hidden = state.columns.length === 0
  document.querySelectorAll('#nav button').forEach((btn) => {
    btn.disabled = state.columns.length === 0
  })
  if (state.view !== 'landing') showView(state.view)
}

// ---------------------------------------------------------------- data loading

async function loadFile(file) {
  if (!file) return
  setStatus('Reading file…')
  try {
    const buffer = await file.arrayBuffer()
    ingest(parseWorkbook(buffer), file.name)
  } catch (err) {
    setStatus(`Could not read the file: ${err.message}`, 'err')
  }
}

async function loadSample(fileName) {
  setStatus('Fetching sample…')
  try {
    const response = await fetch(`sample_data/${fileName}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()
    ingest(parseWorkbook(buffer), fileName)
  } catch (err) {
    setStatus(`Could not load the sample (${err.message}). Use the file picker instead.`, 'err')
  }
}

function ingest(result, sourceName) {
  if (!result.ok) {
    setStatus(result.message, 'err')
    return
  }

  state.columns = result.series
  state.dateColumn = result.dateColumn
  state.frequency = inferFrequency(result.series[0].dates).label
  state.selected = result.series[0].name
  state.inspectProduct = result.series[0].name
  state.evaluations = {}
  state.chosen = {}
  state.forecasts = {}

  const select = $('productSelect')
  select.innerHTML = result.series.map((s) => `<option>${escapeHtml(s.name)}</option>`).join('')

  // Default to batch mode when the file clearly holds several products.
  $('batchMode').checked = result.series.length > 1
  state.mode = result.series.length > 1 ? 'batch' : 'single'

  const skipped = result.skipped?.length
    ? ` · skipped ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`
    : ''
  setStatus(`Loaded ${result.series.length} series from ${sourceName}${skipped}`, 'ok')

  updateNavState()
  // Show the view *before* drawing: a chart measured while its container is
  // hidden ends up 0x0 and renders nothing.
  showView('history')
  renderHistory()
}

// ---------------------------------------------------------------- history view

function renderHistory() {
  if (!state.columns.length) return
  const first = state.columns[0]
  const freq = inferFrequency(first.dates)
  $('historySub').textContent =
    `${state.columns.length} series · ${freq.label}${freq.regular ? '' : ' (irregular spacing)'} · ` +
    `${formatDate(first.dates[0])} → ${formatDate(first.dates.at(-1))} · date column "${state.dateColumn}"`

  // One chart per series (single mode shows just the selected one).
  const container = $('historyCharts')
  container.innerHTML = ''
  const shown = activeSeries()

  container.style.gridTemplateColumns = shown.length === 1 ? '1fr' : '1fr 1fr'
  shown.forEach((series, index) => {
    const canvasId = `historyChart${index}`
    container.insertAdjacentHTML(
      'beforeend',
      `<div class="card" style="margin:0">
         <h3>${escapeHtml(series.name)}</h3>
         <div class="chart-box"><canvas id="${canvasId}"></canvas></div>
       </div>`,
    )
    drawChart(canvasId, {
      type: 'line',
      data: {
        labels: series.dates.map(formatDate),
        datasets: [
          {
            label: series.name,
            data: series.values,
            borderColor: PALETTE[index % PALETTE.length],
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.15,
          },
        ],
      },
      options: baseOptions({ plugins: { legend: { display: false }, tooltip: { padding: 8 } } }),
    })
  })

  // Summary statistics
  const rows = state.columns.map((s) => {
    const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length
    const sorted = [...s.values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const variance = s.values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, s.values.length - 1)
    return {
      Product: s.name,
      Points: s.points,
      Mean: formatNumber(mean, 1),
      Std: formatNumber(Math.sqrt(variance), 1),
      Min: formatNumber(sorted[0], 1),
      Median: formatNumber(median, 1),
      Max: formatNumber(sorted.at(-1), 1),
      'Zero/negative': s.values.filter((v) => v <= 0).length,
    }
  })
  renderTable($('historyTable'), rows)

  // Recent periods for the selected series
  const selected = seriesByName(state.selected)
  const tail = 12
  const start = Math.max(0, selected.values.length - tail)
  const rawRows = []
  for (let i = start; i < selected.values.length; i++) {
    rawRows.push({ Period: formatDate(selected.dates[i]), [selected.name]: formatNumber(selected.values[i], 1) })
  }
  $('historyRawCard').querySelector('h3').textContent = `Recent periods — ${selected.name}`
  renderTable($('historyRaw'), rawRows.reverse())
}

/** Renders an array of plain objects as a table, escaping everything. */
function renderTable(tableEl, rows, options = {}) {
  if (!rows.length) {
    tableEl.innerHTML = '<tbody><tr><td>No data</td></tr></tbody>'
    return
  }
  const headers = Object.keys(rows[0])
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const body = rows
    .map((row, i) => {
      const isWinner = options.winnerIndex === i
      const cells = headers
        .map((h) => {
          const value = row[h]
          return `<td>${value == null ? '' : typeof value === 'string' ? value : escapeHtml(value)}</td>`
        })
        .join('')
      return `<tr class="${isWinner ? 'winner' : ''}">${cells}</tr>`
    })
    .join('')
  tableEl.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`
}

// ---------------------------------------------------------------- model selection

async function runAllModels() {
  if (state.busy || !state.columns.length) return
  state.busy = true
  const button = $('runModels')
  button.disabled = true
  button.innerHTML = '<span class="spinner"></span>Training…'

  const started = performance.now()
  try {
    const targets = activeSeries()
    state.evaluations = {}
    for (const series of targets) {
      state.evaluations[series.name] = await evaluateAll(series.values, {
        testPeriods: state.testPeriods,
        seasonality: state.seasonality,
      })
      const best = state.evaluations[series.name].rows.find((r) => !r.error)
      if (best) state.chosen[series.name] = best.key
    }
    state.forecasts = {}
    $('modelsTiming').textContent = `${targets.length} × ${MODELS.length} models in ${(
      (performance.now() - started) / 1000
    ).toFixed(1)}s`
  } catch (err) {
    $('modelsTiming').textContent = ''
    $('modelsIntro').className = 'callout warn'
    $('modelsIntro').textContent = `Could not evaluate: ${err.message}`
    state.busy = false
    button.disabled = false
    button.textContent = 'Run all models'
    return
  }

  state.busy = false
  button.disabled = false
  button.textContent = 'Re-run all models'
  renderModels()
}

function renderModels() {
  if (!state.columns.length) return
  $('introTestPeriods').textContent = state.testPeriods

  const targets = activeSeries()
  const ready = targets.every((s) => state.evaluations[s.name])
  $('modelsIntro').style.display = ready ? 'none' : 'block'
  $('modelsResults').hidden = !ready
  if (!ready) return

  const isBatch = state.mode === 'batch'
  $('pickCard').hidden = isBatch
  $('perProductCard').hidden = !isBatch
  // The single-series comparison table has no meaning in batch mode, where every
  // product is scored separately — the per-product panel covers that instead.
  $('comparisonCard').hidden = isBatch

  if (!isBatch) {
    renderSingleModelResults(targets[0])
  } else {
    renderBatchModelResults(targets)
  }
}

function comparisonRows(evaluation) {
  return evaluation.rows.map((row) => ({
    Model: escapeHtml(row.name),
    MAE: formatMetric(row.metrics.MAE, 1),
    RMSE: formatMetric(row.metrics.RMSE, 1),
    MAPE: formatMetric(row.metrics.MAPE, 2, '%'),
    SMAPE: formatMetric(row.metrics.SMAPE, 2, '%'),
    MASE: formatMetric(row.metrics.MASE, 2),
    Time: row.error ? '—' : `${row.elapsedMs} ms`,
    Status: row.error ? `<span class="badge bad">failed</span>` : '',
  }))
}

function renderSingleModelResults(series) {
  const evaluation = state.evaluations[series.name]
  const rows = evaluation.rows
  const bestIndex = rows.findIndex((r) => !r.error)

  $('modelsSub').textContent = `${series.name} · training on ${evaluation.train.length} periods, testing on the last ${evaluation.testPeriods}`

  renderTable($('comparisonTable'), comparisonRows(evaluation), { winnerIndex: bestIndex })
  $('modelsBadge').textContent = bestIndex >= 0 ? `best: ${rows[bestIndex].name} · MAPE ${formatMetric(rows[bestIndex].metrics.MAPE, 2, '%')}` : 'all models failed'

  const failed = rows.filter((r) => r.error)
  $('modelsNote').textContent = failed.length
    ? `${failed.length} model(s) failed: ${failed.map((f) => `${f.name} — ${f.error}`).join('; ')}`
    : `Holdout window: ${formatDate(evaluation.test[0] ? new Date(series.dates[series.dates.length - evaluation.testPeriods]) : new Date())} onwards. MASE below 1 beats the seasonal-naive baseline.`

  drawMapeChart(rows)

  // holdout fit for the chosen model
  const chosenKey = state.chosen[series.name] || rows[bestIndex]?.key
  const chosenRow = rows.find((r) => r.key === chosenKey)
  drawFitChart(series, evaluation, chosenRow)

  const pick = $('modelPick')
  pick.innerHTML = rows
    .map((r) => `<option value="${r.key}" ${r.key === chosenKey ? 'selected' : ''}>${escapeHtml(r.name)}${r.error ? ' (failed)' : ''}</option>`)
    .join('')
  const chosenModel = MODEL_BY_KEY[chosenKey]
  $('modelPickNote').textContent = chosenModel ? chosenModel.description : ''
}

function renderBatchModelResults(targets) {
  $('modelsSub').textContent = `Batch mode · ${targets.length} products · training on ${
    Object.values(state.evaluations)[0].train.length
  } periods, testing on the last ${state.testPeriods}`

  const rows = targets.map((series) => {
    const evaluation = state.evaluations[series.name]
    const best = evaluation.rows.find((r) => !r.error)
    return {
      Product: escapeHtml(series.name),
      'Best model': best ? escapeHtml(best.name) : '<span class="badge bad">all failed</span>',
      MAPE: best ? formatMetric(best.metrics.MAPE, 2, '%') : '—',
      SMAPE: best ? formatMetric(best.metrics.SMAPE, 2, '%') : '—',
      MASE: best ? formatMetric(best.metrics.MASE, 2) : '—',
      MAE: best ? formatMetric(best.metrics.MAE, 1) : '—',
      Rating: best ? ratingBadge('', best.metrics.MAPE) : '—',
    }
  })
  renderTable($('perProductTable'), rows)

  // MAPE chart: one bar per model, averaged across products
  const averaged = MODELS.map((model, index) => {
    const values = targets
      .map((s) => state.evaluations[s.name].rows.find((r) => r.key === model.key)?.metrics.MAPE)
      .filter(Number.isFinite)
    return { name: model.name, mape: values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN, index }
  }).sort((a, b) => (Number.isFinite(a.mape) ? a.mape : 1e9) - (Number.isFinite(b.mape) ? b.mape : 1e9))
  drawMapeChart(averaged.map((a) => ({ name: a.name, metrics: { MAPE: a.mape }, error: !Number.isFinite(a.mape) })))

  // Detail panel: pick a product, show its full ranking and holdout fit.
  const names = targets.map((s) => s.name)
  if (!names.includes(state.inspectProduct)) state.inspectProduct = names[0]

  const select = $('inspectProductSelect')
  select.innerHTML = names
    .map((n) => `<option ${n === state.inspectProduct ? 'selected' : ''}>${escapeHtml(n)}</option>`)
    .join('')

  const evaluation = state.evaluations[state.inspectProduct]
  $('batchRankingTitle').textContent = `Model ranking — ${state.inspectProduct}`
  renderTable($('batchRankingTable'), comparisonRows(evaluation), {
    winnerIndex: evaluation.rows.findIndex((r) => !r.error),
  })

  drawFitChart(
    seriesByName(state.inspectProduct),
    evaluation,
    evaluation.rows.find((r) => r.key === state.chosen[state.inspectProduct]),
  )
}

function drawMapeChart(rows) {
  const usable = rows.filter((r) => Number.isFinite(r.metrics.MAPE))
  drawChart('mapeChart', {
    type: 'bar',
    data: {
      labels: usable.map((r) => r.name),
      datasets: [
        {
          data: usable.map((r) => r.metrics.MAPE),
          backgroundColor: usable.map((r) => {
            const rating = ratingFromMape(r.metrics.MAPE)
            return rating.tone === 'good' ? '#2e9e6b' : rating.tone === 'warn' ? '#d9a441' : '#c0392b'
          }),
          borderRadius: 3,
        },
      ],
    },
    options: baseOptions({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(2)}%` } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 60, minRotation: 40 } },
        y: { grid: GRID, ticks: { callback: (v) => `${v}%` } },
      },
      indexAxis: 'x',
    }),
  })
}

function drawFitChart(series, evaluation, row) {
  const testStart = series.values.length - evaluation.testPeriods
  if (!row || row.error || !row.fitted) {
    // Nothing to plot — tear the chart down rather than leaving a stale one behind.
    if (state.charts.fitChart) {
      state.charts.fitChart.destroy()
      delete state.charts.fitChart
    }
    return
  }

  // Show the last 24 periods of history plus the holdout window for context.
  const contextLength = Math.min(24, testStart)
  const histStart = testStart - contextLength
  const labels = [
    ...series.dates.slice(histStart, testStart).map(formatDate),
    ...series.dates.slice(testStart).map(formatDate),
  ]

  drawChart('fitChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'History',
          data: [...series.values.slice(histStart, testStart), ...new Array(evaluation.testPeriods).fill(null)],
          borderColor: '#95a5a6',
          borderWidth: 1.5,
          pointRadius: 0,
          spanGaps: false,
        },
        {
          label: 'Actual (holdout)',
          data: [...new Array(contextLength).fill(null), ...evaluation.test],
          borderColor: '#1f77b4',
          borderWidth: 2,
          pointRadius: 3,
          spanGaps: false,
        },
        {
          label: `${row.name} (predicted)`,
          data: [...new Array(contextLength).fill(null), ...row.fitted],
          borderColor: '#d62728',
          borderDash: [5, 4],
          borderWidth: 2,
          pointRadius: 3,
          spanGaps: false,
        },
      ],
    },
    options: baseOptions(),
  })
}

// ---------------------------------------------------------------- forecast

async function runForecast() {
  if (state.busy || !state.columns.length) return
  const targets = activeSeries().filter((s) => state.chosen[s.name])
  if (!targets.length) return

  state.busy = true
  const button = $('runForecast')
  button.disabled = true
  button.innerHTML = '<span class="spinner"></span>Forecasting…'

  try {
    state.forecasts = {}
    for (const series of targets) {
      const key = state.chosen[series.name]
      const result = await forecastWith(key, series.values, state.horizon, { seasonality: state.seasonality })
      state.forecasts[series.name] = {
        ...result,
        dates: futureDates(series.dates.at(-1), state.horizon, state.frequency),
      }
    }
  } catch (err) {
    $('forecastEmpty').hidden = false
    $('forecastEmpty').className = 'callout warn'
    $('forecastEmpty').textContent = `Forecast failed: ${err.message}`
    state.busy = false
    button.disabled = false
    button.textContent = 'Generate forecast'
    return
  }

  state.busy = false
  button.disabled = false
  button.textContent = 'Re-generate forecast'
  renderForecast()
}

function renderForecast() {
  if (!state.columns.length) return
  const ready = Object.keys(state.chosen).length > 0
  $('forecastEmpty').hidden = ready
  $('forecastBody').hidden = !ready
  $('forecastEmpty').textContent = 'Pick a model on the Model Selection page first.'
  $('forecastEmpty').className = 'callout warn'
  if (!ready) return

  const generated = Object.keys(state.forecasts).length > 0
  $('forecastEmpty').hidden = true
  $('forecastBody').hidden = false

  if (!generated) {
    $('forecastSub').textContent = `${state.horizon} periods ahead · click "Generate forecast" to compute`
    $('forecastNote').textContent = 'The forecast has not been generated for the current settings yet.'
  }

  const isBatch = state.mode === 'batch'
  const targets = activeSeries()

  if (!isBatch) {
    const series = targets[0]
    const forecast = state.forecasts[series.name]
    $('forecastSub').textContent = `${series.name} · ${state.horizon} periods ahead · model: ${MODEL_BY_KEY[state.chosen[series.name]]?.name || '—'}`
    if (forecast) {
      $('forecastNote').textContent = forecast.note ? `Fitted with ${forecast.note}` : ''
      drawForecastChart('forecastChart', series, forecast)
      renderMetrics($('forecastMetrics'), [
        ['Total', formatNumber(forecast.values.reduce((a, b) => a + b, 0), 0)],
        ['Average / period', formatNumber(forecast.values.reduce((a, b) => a + b, 0) / forecast.values.length, 1)],
        ['Minimum', formatNumber(Math.min(...forecast.values), 1)],
        ['Maximum', formatNumber(Math.max(...forecast.values), 1)],
      ])
      renderTable(
        $('forecastTable'),
        forecast.values.map((v, i) => ({ Period: i + 1, Date: formatDate(forecast.dates[i]), Forecast: formatNumber(v, 1) })),
      )
      $('forecastChartTitle').textContent = `${series.name} — history and ${state.horizon}-period forecast`
      $('downloadCsv').disabled = false
    }
  } else {
    $('forecastSub').textContent = `${targets.length} products · ${state.horizon} periods ahead · each product uses its own best model`
    if (generated) {
      drawForecastChart('forecastChart', targets[0], state.forecasts[targets[0].name], targets)
      const totals = targets.map((s) => state.forecasts[s.name]?.values.reduce((a, b) => a + b, 0) || 0)
      renderMetrics($('forecastMetrics'), [
        ['Products', String(targets.length)],
        ['Total (all)', formatNumber(totals.reduce((a, b) => a + b, 0), 0)],
        ['Average / product', formatNumber(totals.reduce((a, b) => a + b, 0) / Math.max(1, targets.length), 0)],
        ['Periods each', String(state.horizon)],
      ])
      const rows = []
      const first = state.forecasts[targets[0].name]
      for (let i = 0; i < state.horizon; i++) {
        const row = { Period: i + 1, Date: formatDate(first.dates[i]) }
        for (const s of targets) row[s.name] = formatNumber(state.forecasts[s.name]?.values[i] ?? NaN, 1)
        rows.push(row)
      }
      renderTable($('forecastTable'), rows)
      $('forecastChartTitle').textContent = `All products — history and ${state.horizon}-period forecast`
      $('forecastNote').textContent = targets
        .map((s) => `${s.name}: ${MODEL_BY_KEY[state.chosen[s.name]]?.name || '—'}`)
        .join(' · ')
      $('downloadCsv').disabled = false
    }
  }
}

function drawForecastChart(canvasId, series, forecast, allTargets) {
  const isBatch = Boolean(allTargets)
  const targets = allTargets || [series]
  const historyLength = series.dates.length
  // Single mode shows the whole history; batch mode shows the last 12 periods so
  // four products don't turn the chart into noise.
  const tailLength = isBatch ? Math.min(12, historyLength) : historyLength
  const omitted = historyLength - tailLength

  const labels = [
    ...series.dates.slice(omitted).map(formatDate),
    ...forecast.dates.map(formatDate),
  ]

  const datasets = []
  for (const [index, s] of targets.entries()) {
    const f = isBatch ? state.forecasts[s.name] : forecast
    if (!f) continue
    const color = PALETTE[index % PALETTE.length]

    // `labels` is already trimmed to the tail, so the history series must not
    // carry leading nulls — only the forecast horizon is padded. Both datasets
    // must match the label count exactly or Chart.js drops them silently.
    datasets.push({
      label: isBatch ? `${s.name} (history)` : 'History',
      data: [...s.values.slice(omitted), ...new Array(state.horizon).fill(null)],
      borderColor: isBatch ? color : '#1f77b4',
      borderWidth: isBatch ? 1.2 : 2,
      pointRadius: 0,
      spanGaps: false,
    })
    datasets.push({
      label: `${s.name}${isBatch ? '' : ' (forecast)'} — ${MODEL_BY_KEY[state.chosen[s.name]]?.name || ''}`,
      data: [...new Array(tailLength).fill(null), ...f.values],
      borderColor: isBatch ? color : '#ff7f0e',
      borderWidth: 2,
      borderDash: isBatch ? [] : [6, 4],
      pointRadius: isBatch ? 2 : 4,
      spanGaps: false,
    })
  }

  drawChart(canvasId, { type: 'line', data: { labels, datasets }, options: baseOptions() })
}

function renderMetrics(container, pairs) {
  container.innerHTML = pairs
    .map(([k, v]) => `<div class="metric"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`)
    .join('')
}

// ---------------------------------------------------------------- accuracy

function renderAccuracy() {
  if (!state.columns.length) return
  const ready = Object.keys(state.chosen).length > 0
  $('accuracyEmpty').hidden = ready
  $('accuracyBody').hidden = !ready
  if (!ready) {
    $('accuracyEmpty').textContent = 'Run model selection first.'
    return
  }

  const isBatch = state.mode === 'batch'
  const targets = activeSeries()

  if (!isBatch) {
    const series = targets[0]
    const evaluation = state.evaluations[series.name]
    if (!evaluation) {
      $('accuracyEmpty').hidden = false
      $('accuracyBody').hidden = true
      $('accuracyEmpty').textContent = 'Run model selection first.'
      return
    }
    const key = state.chosen[series.name]
    const row = evaluation.rows.find((r) => r.key === key)
    $('accuracySub').textContent = `${series.name} · ${row.name} · scored on the last ${evaluation.testPeriods} periods`

    const metrics = row.metrics
    renderMetrics($('accuracyMetrics'), [
      ['MAE', formatMetric(metrics.MAE, 1)],
      ['RMSE', formatMetric(metrics.RMSE, 1)],
      ['MAPE', formatMetric(metrics.MAPE, 2, '%')],
      ['SMAPE', formatMetric(metrics.SMAPE, 2, '%')],
      ['MASE', formatMetric(metrics.MASE, 2)],
    ])
    $('accuracyNote').textContent =
      'MASE below 1 means the model beats simply repeating the same period last season.'

    $('batchAccuracyCard').hidden = true
    $('accuracyDiagnostics').hidden = false
    $('accuracyHistCard').hidden = false

    drawAccuracyCharts(evaluation, row)
    renderMetricExplainer()
  } else {
    $('accuracySub').textContent = `Batch mode · ${targets.length} products · each scored on its own holdout window`

    // Per-product summary of the model each product will actually be forecast with.
    const rows = []
    const mapes = []
    let worst = null
    for (const series of targets) {
      const evaluation = state.evaluations[series.name]
      const row = evaluation?.rows.find((r) => r.key === state.chosen[series.name])
      if (!row || !Number.isFinite(row.metrics.MAPE)) continue
      mapes.push(row.metrics.MAPE)
      if (!worst || row.metrics.MAPE > worst.mape) worst = { name: series.name, mape: row.metrics.MAPE }
      rows.push({
        Product: series.name,
        Model: row.name,
        MAE: formatMetric(row.metrics.MAE, 1),
        RMSE: formatMetric(row.metrics.RMSE, 1),
        MAPE: formatMetric(row.metrics.MAPE, 2, '%'),
        SMAPE: formatMetric(row.metrics.SMAPE, 2, '%'),
        MASE: formatMetric(row.metrics.MASE, 2),
        Rating: ratingBadge('', row.metrics.MAPE),
      })
    }

    renderTable($('batchAccuracyTable'), rows)
    $('batchAccuracyCard').hidden = rows.length === 0
    // The residual diagnostics below are per-series, so they do not apply in batch mode.
    $('accuracyDiagnostics').hidden = true
    $('accuracyHistCard').hidden = true

    const meanMape = mapes.length ? mapes.reduce((a, b) => a + b, 0) / mapes.length : Number.NaN
    renderMetrics($('accuracyMetrics'), [
      ['Products scored', String(rows.length)],
      ['Mean MAPE', formatMetric(meanMape, 2, '%')],
      ['Best MAPE', mapes.length ? formatMetric(Math.min(...mapes), 2, '%') : '—'],
      ['Worst MAPE', worst ? formatMetric(worst.mape, 2, '%') : '—'],
      ['Worst product', worst ? worst.name : '—'],
    ])

    $('accuracyNote').textContent =
      'Switch batch mode off (or select a single product) to see residual diagnostics for one series.'
    renderMetricExplainer()
  }
}

function drawAccuracyCharts(evaluation, row) {
  const actual = evaluation.test
  const predicted = row.fitted
  const labels = actual.map((_, i) => `T${i + 1}`)

  drawChart('accuracyActualChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: actual, borderColor: '#1f77b4', borderWidth: 2, pointRadius: 4, tension: 0.1 },
        { label: 'Predicted', data: predicted, borderColor: '#d62728', borderDash: [5, 4], borderWidth: 2, pointRadius: 4, tension: 0.1 },
      ],
    },
    options: baseOptions(),
  })

  const residuals = actual.map((a, i) => a - predicted[i])
  drawChart('accuracyResidualChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Error (actual − predicted)', data: residuals, backgroundColor: residuals.map((r) => (r < 0 ? '#c0392b' : '#2e9e6b')), borderRadius: 3 }],
    },
    options: baseOptions({ plugins: { legend: { display: false }, tooltip: { padding: 8 } } }),
  })

  // Histogram of residuals
  const min = Math.min(...residuals, 0)
  const max = Math.max(...residuals, 0)
  const bins = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(residuals.length))))
  const width = (max - min) / bins || 1
  const counts = new Array(bins).fill(0)
  const binLabels = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * width
    binLabels.push(`${formatNumber(lo, 0)}`)
    for (const r of residuals) {
      const index = Math.min(bins - 1, Math.floor((r - min) / width))
      counts[index]++
    }
  }
  drawChart('accuracyHistChart', {
    type: 'bar',
    data: { labels: binLabels, datasets: [{ label: 'Periods', data: counts, backgroundColor: '#7f8c8d', borderRadius: 3 }] },
    options: baseOptions({
      plugins: { legend: { display: false }, tooltip: { padding: 8 } },
      scales: {
        x: { grid: { display: false }, title: { display: true, text: 'Error bucket (lower bound)' } },
        y: { grid: GRID, title: { display: true, text: 'Periods' }, ticks: { precision: 0 } },
      },
    }),
  })
}

function renderMetricExplainer() {
  renderTable($('metricExplainer'), [
    { Metric: 'MAE', Meaning: 'Mean absolute error, in the units of your data.', Reading: 'Lower is better; scale depends on volume.' },
    { Metric: 'RMSE', Meaning: 'Root mean squared error — squares the misses first.', Reading: 'Always ≥ MAE; a big gap means a few large errors.' },
    { Metric: 'MAPE', Meaning: 'Mean absolute percentage error.', Reading: 'Primary ranking metric. <10% is good for demand data.' },
    { Metric: 'SMAPE', Meaning: 'Symmetric MAPE — divides by the average of the two values.', Reading: 'Stabler than MAPE when values are small.' },
    { Metric: 'MASE', Meaning: 'MAE scaled by the seasonal-naive in-sample error.', Reading: '<1 beats repeating last season; >1 is worse.' },
  ])
}

// ---------------------------------------------------------------- CSV export

function downloadCsv() {
  const isBatch = state.mode === 'batch'
  const targets = activeSeries().filter((s) => state.forecasts[s.name])
  if (!targets.length) return

  const lines = []
  if (isBatch) {
    const first = state.forecasts[targets[0].name]
    lines.push(['Period', 'Date', ...targets.map((s) => s.name), ...targets.map((s) => `${s.name}_model`)].join(','))
    for (let i = 0; i < state.horizon; i++) {
      lines.push(
        [
          i + 1,
          formatDate(first.dates[i]),
          ...targets.map((s) => (state.forecasts[s.name]?.values[i] ?? '').toString()),
          ...targets.map((s) => `"${MODEL_BY_KEY[state.chosen[s.name]]?.name || ''}"`),
        ].join(','),
      )
    }
  } else {
    const s = targets[0]
    const f = state.forecasts[s.name]
    lines.push('Period,Date,Forecast,Model')
    f.values.forEach((v, i) => lines.push([i + 1, formatDate(f.dates[i]), v, `"${MODEL_BY_KEY[state.chosen[s.name]]?.name || ''}"`].join(',')))
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `forecast_${state.horizon}periods_${state.mode}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- wiring

function toggleMode(batch) {
  state.mode = batch ? 'batch' : 'single'
  $('productField').hidden = batch
  state.evaluations = {}
  state.chosen = {}
  state.forecasts = {}
  $('modelsTiming').textContent = ''
  $('modelsResults').hidden = true
  $('modelsIntro').style.display = 'block'
  $('downloadCsv').disabled = true
  renderHistory()
  renderModels()
  renderForecast()
  renderAccuracy()
}

function bindSlider(id, key, format = (v) => v) {
  const input = $(id)
  const label = $(`${id}Val`)
  input.addEventListener('input', () => {
    state[key] = Number(input.value)
    label.textContent = format(input.value)
    // Settings changes invalidate any computed results.
    state.evaluations = {}
    state.chosen = {}
    state.forecasts = {}
    $('modelsResults').hidden = true
    $('modelsIntro').style.display = 'block'
    $('modelsTiming').textContent = ''
    $('downloadCsv').disabled = true
  })
  label.textContent = format(input.value)
}

function init() {
  // File input / drop zone
  const dropzone = $('dropzone')
  const fileInput = $('fileInput')
  dropzone.addEventListener('click', () => fileInput.click())
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click()
  })
  fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]))
  ;['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (e) => {
      e.preventDefault()
      dropzone.classList.add('dragover')
    }),
  )
  ;['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (e) => {
      e.preventDefault()
      dropzone.classList.remove('dragover')
    }),
  )
  dropzone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]))

  $('loadSingleSample').addEventListener('click', () => loadSample('sample_single_product.xlsx'))
  $('loadMultiSample').addEventListener('click', () => loadSample('sample_multi_product.xlsx'))

  $('batchMode').addEventListener('change', (e) => toggleMode(e.target.checked))
  $('inspectProductSelect').addEventListener('change', (e) => {
    state.inspectProduct = e.target.value
    renderModels()
  })
  $('productSelect').addEventListener('change', (e) => {
    state.selected = e.target.value
    state.forecasts = {}
    renderHistory()
    renderModels()
    renderForecast()
    renderAccuracy()
  })

  bindSlider('testPeriods', 'testPeriods')
  bindSlider('seasonality', 'seasonality')
  bindSlider('horizon', 'horizon')

  document.querySelectorAll('#nav button').forEach((btn) =>
    btn.addEventListener('click', () => showView(btn.dataset.view)),
  )

  $('runModels').addEventListener('click', runAllModels)
  $('useModel').addEventListener('click', () => {
    state.chosen[state.selected] = $('modelPick').value
    state.forecasts = {}
    showView('forecast')
  })
  $('modelPick').addEventListener('change', (e) => {
    state.chosen[state.selected] = e.target.value
    const evaluation = state.evaluations[state.selected]
    const row = evaluation?.rows.find((r) => r.key === e.target.value)
    if (evaluation && row) drawFitChart(seriesByName(state.selected), evaluation, row)
    const model = MODEL_BY_KEY[e.target.value]
    $('modelPickNote').textContent = model ? model.description : ''
  })
  $('runForecast').addEventListener('click', runForecast)
  $('downloadCsv').addEventListener('click', downloadCsv)

  // Fetch the ARIMA bundle now rather than at first use: it is 306 KB, so the
  // download should overlap with the user reading the page instead of stalling
  // their first "Run all models" click.
  const arimaStatus = $('arimaStatus')
  arimaStatus.textContent = 'downloading…'
  loadArima()
    .then(() => {
      arimaStatus.textContent = 'ready'
      arimaStatus.className = 'status ok'
    })
    .catch(() => {
      arimaStatus.textContent = 'unavailable — the other 7 models still work'
      arimaStatus.className = 'status err'
    })

  // Start with navigation disabled and settings hidden, until data is loaded.
  updateNavState()
}

init()
