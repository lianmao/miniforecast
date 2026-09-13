import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeAll,
  formatMetric,
  inSampleScale,
  mae,
  mape,
  mase,
  ratingFromMape,
  rmse,
  smape,
} from '../src/metrics.js'

const close = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tol, `expected ${expected}, got ${actual}`)

test('mae / rmse / mape / smape match hand-computed values', () => {
  const actual = [10, 20, 30]
  const predicted = [12, 18, 33]

  close(mae(actual, predicted), 7 / 3)
  close(rmse(actual, predicted), Math.sqrt(17 / 3))
  close(mape(actual, predicted), ((0.2 + 0.1 + 0.1) / 3) * 100)
  close(smape(actual, predicted), ((2 * 2) / 22 + (2 * 2) / 38 + (2 * 3) / 63) / 3 * 100)
})

test('numeric edge cases', () => {
  close(mae([5, 5], [5, 5]), 0)
  assert.equal(mae([], []), Number.NaN, 'empty input yields NaN')
  assert.ok(Number.isNaN(mape([0, 0], [1, 2])), 'all-zero actuals yield NaN, not Infinity')
  close(mape([0, 10], [5, 10]), 0, 1e-9)
  assert.equal(smape([0], [0]), Number.NaN, 'zero/zero pair is skipped')
  close(smape([0, 100], [0, 100]), 0, 1e-9)
})

test('mismatched lengths compare on the overlapping prefix', () => {
  close(mae([1, 2, 3, 4], [1, 2]), 0)
})

test('MASE scales against the seasonal-naive in-sample error', () => {
  const inSample = [10, 20, 30, 40, 50, 60, 70, 80]
  const scale = inSampleScale(inSample, 4)
  // Four seasonal lags, each 40 apart: (|50-10| + |60-20| + |70-30| + |80-40|) / 4
  close(scale, 40)

  const perfect = mase(inSample, inSample, inSample, 4)
  close(perfect, 0, 1e-9)

  // A model averaging 15 absolute error against that scale scores MAE/scale.
  close(mase([10, 20], [20, 40], inSample, 4), 15 / scale, 1e-6)
})

test('inSampleScale falls back to first differences when history < one season', () => {
  close(inSampleScale([10, 12, 15], 12), (2 + 3) / 2)
  assert.ok(Number.isNaN(inSampleScale([5], 12)))
})

test('computeAll returns every metric', () => {
  const m = computeAll([10, 20, 30], [12, 18, 33], [10, 20, 30, 40, 50, 60, 70, 80], 4)
  assert.deepEqual(Object.keys(m), ['MAE', 'RMSE', 'MAPE', 'SMAPE', 'MASE'])
  for (const [key, value] of Object.entries(m)) {
    assert.ok(Number.isFinite(value), `${key} should be finite, got ${value}`)
  }
})

test('display helpers tolerate NaN', () => {
  assert.equal(formatMetric(Number.NaN, 2, '%'), '—')
  assert.equal(formatMetric(3.14159, 2, '%'), '3.14%')
  assert.equal(ratingFromMape(3).label, 'Excellent')
  assert.equal(ratingFromMape(7).label, 'Good')
  assert.equal(ratingFromMape(15).label, 'Fair')
  assert.equal(ratingFromMape(25).label, 'Poor')
  assert.equal(ratingFromMape(50).label, 'Very poor')
  assert.equal(ratingFromMape(Number.NaN).label, 'n/a')
})
