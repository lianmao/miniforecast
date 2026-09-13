/**
 * Forecast accuracy metrics.
 *
 * Every function takes plain arrays of numbers and returns a number (or NaN when
 * the metric is undefined for the given data, e.g. MAPE when every actual is 0).
 */

const num = (x) => (Number.isFinite(x) ? x : NaN)

/** Mean absolute error — in the same units as the data. */
export function mae(actual, predicted) {
  const pairs = zipPairs(actual, predicted)
  if (!pairs.length) return NaN
  return pairs.reduce((s, [a, p]) => s + Math.abs(a - p), 0) / pairs.length
}

/** Root mean squared error — penalises large misses more than MAE. */
export function rmse(actual, predicted) {
  const pairs = zipPairs(actual, predicted)
  if (!pairs.length) return NaN
  return Math.sqrt(pairs.reduce((s, [a, p]) => s + (a - p) ** 2, 0) / pairs.length)
}

/**
 * Mean absolute percentage error, in percent.
 * Periods where the actual is 0 are skipped (the ratio is undefined there);
 * if every actual is 0 this returns NaN rather than Infinity.
 */
export function mape(actual, predicted) {
  const pairs = zipPairs(actual, predicted).filter(([a]) => a !== 0)
  if (!pairs.length) return NaN
  return (pairs.reduce((s, [a, p]) => s + Math.abs((a - p) / a), 0) / pairs.length) * 100
}

/**
 * Symmetric MAPE, in percent. Better behaved than MAPE when values approach zero
 * because it divides by the average of actual and predicted.
 */
export function smape(actual, predicted) {
  const pairs = zipPairs(actual, predicted).filter(([a, p]) => Math.abs(a) + Math.abs(p) !== 0)
  if (!pairs.length) return NaN
  return (pairs.reduce((s, [a, p]) => s + (2 * Math.abs(a - p)) / (Math.abs(a) + Math.abs(p)), 0) /
    pairs.length) * 100
}

/**
 * Mean absolute scaled error: MAE divided by the in-sample seasonal-naive error.
 * A value below 1 beats the seasonal-naive baseline; above 1 means worse than
 * simply repeating last season.
 */
export function mase(actual, predicted, inSample, seasonality = 12) {
  const scale = inSampleScale(inSample, seasonality)
  if (!Number.isFinite(scale) || scale === 0) return NaN
  const m = mae(actual, predicted)
  return Number.isFinite(m) ? m / scale : NaN
}

/** Mean absolute error of the seasonal-naive forecast over the in-sample series. */
export function inSampleScale(inSample, seasonality = 12) {
  const values = asNumbers(inSample)
  const m = Math.max(1, Math.floor(seasonality))
  if (values.length <= m) {
    // Not enough history for a seasonal baseline — fall back to first differences.
    if (values.length < 2) return NaN
    let sum = 0
    for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1])
    return sum / (values.length - 1)
  }
  let sum = 0
  for (let i = m; i < values.length; i++) sum += Math.abs(values[i] - values[i - m])
  return sum / (values.length - m)
}

/** All metrics in one object. */
export function computeAll(actual, predicted, inSample = [], seasonality = 12) {
  return {
    MAE: num(mae(actual, predicted)),
    RMSE: num(rmse(actual, predicted)),
    MAPE: num(mape(actual, predicted)),
    SMAPE: num(smape(actual, predicted)),
    MASE: num(mase(actual, predicted, inSample, seasonality)),
  }
}

/**
 * Sorting key for ranking models. Models that failed to produce a usable MAPE
 * (non-finite, or absurdly large) sort last instead of poisoning the ranking.
 */
export function rankingScore(metrics) {
  if (!Number.isFinite(metrics.MAPE)) return Number.POSITIVE_INFINITY
  return metrics.MAPE
}

/** Formats a metric for display, tolerating NaN. */
export function formatMetric(value, digits = 2, suffix = '') {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(digits) + suffix
}

/**
 * Human rating band for a MAPE value — used for the colour-coded badges.
 * Thresholds follow the usual demand-planning rule of thumb.
 */
export function ratingFromMape(mapeValue) {
  if (!Number.isFinite(mapeValue)) return { label: 'n/a', tone: 'neutral' }
  if (mapeValue < 5) return { label: 'Excellent', tone: 'good' }
  if (mapeValue < 10) return { label: 'Good', tone: 'good' }
  if (mapeValue < 20) return { label: 'Fair', tone: 'warn' }
  if (mapeValue < 30) return { label: 'Poor', tone: 'warn' }
  return { label: 'Very poor', tone: 'bad' }
}

// ---- helpers ----

function asNumbers(arr) {
  return (arr || []).map(Number).filter(Number.isFinite)
}

function zipPairs(actual, predicted) {
  const a = arr(actual)
  const p = arr(predicted)
  const n = Math.min(a.length, p.length)
  const out = []
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(p[i])) out.push([a[i], p[i]])
  }
  return out
}

function arr(x) {
  if (!Array.isArray(x) && !ArrayBuffer.isView(x)) return []
  return Array.from(x, Number)
}
