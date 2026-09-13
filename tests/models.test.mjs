import { test, before } from 'node:test'
import assert from 'node:assert/strict'

import { loadArimaBundle } from './helpers.mjs'
import {
  MODELS,
  MODEL_BY_KEY,
  evaluateAll,
  forecastBest,
  forecastWith,
  holtWintersMultiplicative,
  linearRegressionTrend,
  movingAverage,
  seasonalNaive,
} from '../src/models.js'

const HORIZON = 18

/** 60 months of level + steady trend + a clean 12-month seasonal shape. */
function syntheticSeries(n = 60) {
  return Array.from({ length: n }, (_, i) => 1000 + 12 * i + 220 * Math.sin((2 * Math.PI * i) / 12))
}

before(async () => {
  // Compile the ARIMA WASM once — in the browser this happens while the page paints.
  await loadArimaBundle()
})

test('registry exposes eight uniquely-keyed models', () => {
  assert.equal(MODELS.length, 8)
  assert.equal(new Set(MODELS.map((m) => m.key)).size, 8)
  for (const model of MODELS) {
    assert.ok(model.name && model.description, `${model.key} needs a name and description`)
    assert.equal(typeof model.run, 'function')
  }
  assert.deepEqual(Object.keys(MODEL_BY_KEY).sort(), MODELS.map((m) => m.key).sort())
})

test('every model forecasts the requested horizon with finite, non-negative values', async () => {
  const values = syntheticSeries()
  for (const model of MODELS) {
    const { values: forecast } = await model.run(values, HORIZON, { seasonality: 12 })
    assert.equal(forecast.length, HORIZON, `${model.key} returned ${forecast.length} points`)
    assert.ok(forecast.every(Number.isFinite), `${model.key} produced non-finite values`)
    assert.ok(forecast.every((v) => v >= 0), `${model.key} produced a negative demand forecast`)
  }
})

test('seasonal naive repeats the last season exactly', async () => {
  const { values } = await seasonalNaive([1, 2, 3, 4, 5, 6, 7, 8], 6, { seasonality: 4 })
  assert.deepEqual(values, [5, 6, 7, 8, 5, 6])
})

test('seasonal naive degrades when history is shorter than one season', async () => {
  const { values, note } = await seasonalNaive([1, 2, 3], 4, { seasonality: 12 })
  assert.deepEqual(values, [3, 3, 3, 3])
  assert.match(note, /shorter than one season/)
})

test('moving average projects the trailing window flat', async () => {
  const { values } = await movingAverage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, { window: 3 })
  assert.deepEqual(values, [9, 9, 9])
})

test('linear regression recovers an exact straight line', async () => {
  const line = Array.from({ length: 24 }, (_, i) => 2 * i + 5)
  const { values } = await linearRegressionTrend(line, 5)
  // Next values after i = 23 are 53, 55, 57, 59, 61.
  values.forEach((v, i) => assert.ok(Math.abs(v - (53 + 2 * i)) < 1e-9, `step ${i}: ${v}`))
})

test('Holt-Winters multiplicative falls back to additive on non-positive data', async () => {
  const values = syntheticSeries().slice(0, 36)
  values[3] = 0
  const { note } = await holtWintersMultiplicative(values, 6, { seasonality: 12 })
  assert.match(note, /additive seasonality instead/)
})

test('Holt-Winters falls back to damped Holt below two full seasons', async () => {
  const { note } = await MODELS.find((m) => m.key === 'hw_add').run(syntheticSeries(18), 6, {
    seasonality: 12,
  })
  assert.match(note, /needs 24 points/)
})

test('smoothing fitted on a seasonal series tracks the seasonal shape', async () => {
  const values = syntheticSeries(60)
  const { values: forecast } = await MODELS.find((m) => m.key === 'hw_add').run(values, 12, {
    seasonality: 12,
  })
  // Peaks should recur 12 months later: compare each forecast point to the value
  // one season earlier, allowing for the upward trend.
  for (let i = 0; i < 12; i++) {
    const sameSeasonLastYear = values[values.length - 12 + i]
    const drift = Math.abs(forecast[i] - sameSeasonLastYear)
    assert.ok(drift < 700, `month ${i}: forecast ${forecast[i].toFixed(0)} vs last year ${sameSeasonLastYear.toFixed(0)}`)
  }
})

test('evaluateAll scores all eight models and ranks them', async () => {
  const values = syntheticSeries(60)
  const { rows, train, test } = await evaluateAll(values, { testPeriods: 6, seasonality: 12 })

  assert.equal(rows.length, 8)
  assert.equal(train.length, 54)
  assert.equal(test.length, 6)

  const usable = rows.filter((r) => !r.error)
  assert.ok(usable.length >= 6, `expected most models to succeed, got ${usable.length}`)

  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].score <= rows[i].score, 'rows must be sorted by ascending score')
  }
  for (const row of usable) {
    assert.ok(Number.isFinite(row.metrics.MAPE), `${row.key} should report a finite MAPE`)
    assert.equal(row.fitted.length, 6, `${row.key} should return one prediction per test period`)
  }

  const arima = rows.find((r) => r.key === 'arima')
  assert.ok(arima, 'ARIMA must be present in the comparison')
  assert.equal(arima.error, null, `ARIMA failed: ${arima.error}`)
  console.log(
    '      ranking: ' +
      rows
        .map((r) => `${r.name}=${Number.isFinite(r.metrics.MAPE) ? r.metrics.MAPE.toFixed(2) : 'n/a'}%`)
        .join('  '),
  )
})

test('reported runtimes reflect real work rather than concurrency stalls', async () => {
  const { rows } = await evaluateAll(syntheticSeries(60), { testPeriods: 6, seasonality: 12 })

  // These models are a handful of arithmetic operations. If the harness ever goes
  // back to evaluating models in parallel, they inherit ARIMA's WASM stall and
  // start reporting hundreds of milliseconds — which is what this guards against.
  for (const key of ['linear_trend', 'seasonal_naive', 'moving_average']) {
    const row = rows.find((r) => r.key === key)
    assert.ok(
      row.elapsedMs < 100,
      `${row.name} is trivial arithmetic but reported ${row.elapsedMs}ms`,
    )
  }
})

/**
 * On a slow or filtered network the ARIMA bundle may never arrive. The run must
 * still produce a full comparison with ARIMA marked as failed, rather than
 * quietly vanishing from the table or taking the whole page down.
 */
test('a model that fails to load is reported, not silently dropped', async () => {
  const arima = MODELS.find((m) => m.key === 'arima')
  const original = arima.run
  arima.run = async () => {
    throw new Error('simulated network failure')
  }
  try {
    const { rows } = await evaluateAll(syntheticSeries(60), { testPeriods: 6, seasonality: 12 })
    assert.equal(rows.length, 8, 'the failed model must still occupy a row')

    const failed = rows.find((r) => r.key === 'arima')
    assert.match(failed.error, /simulated network failure/)
    assert.equal(failed.score, Number.POSITIVE_INFINITY)
    assert.equal(failed.fitted, null)
    assert.equal(rows.at(-1).key, 'arima', 'the failed model sorts last')

    assert.equal(rows.filter((r) => !r.error).length, 7, 'the other seven models still run')
  } finally {
    arima.run = original
  }
})

test('evaluateAll rejects series that are too short to hold out from', async () => {
  await assert.rejects(
    () => evaluateAll([1, 2, 3, 4, 5, 6], { testPeriods: 6 }),
    /need more than 8 data points/,
  )
})

test('forecastWith rejects an unknown model key', async () => {
  await assert.rejects(() => forecastWith('nope', syntheticSeries(), 6), /unknown model/)
})

test('forecastBest selects the top-ranked model end to end', async () => {
  const values = syntheticSeries(60)
  const result = await forecastBest(values, HORIZON, { testPeriods: 6, seasonality: 12 })

  assert.equal(result.values.length, HORIZON)
  assert.equal(result.key, result.evaluation.rows.find((r) => !r.error).key)
  assert.equal(result.bestRow.metrics.MAPE, Math.min(...result.evaluation.rows.map((r) => r.score)))
})
