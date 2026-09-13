/**
 * The forecasting models.
 *
 * Every model exposes:
 *   run(values: number[], horizon: number, opts) -> Promise<{ values: number[], note?: string }>
 *
 * They are all async so the UI can treat them uniformly — only ARIMA actually
 * awaits anything (the WASM compile), the rest resolve immediately.
 *
 * Design notes:
 *  - Smoothing parameters are fitted with Nelder-Mead (see optimize.js) rather
 *    than a coarse grid, so the reported accuracy reflects a real optimum.
 *  - Models that cannot be identified on the available history degrade
 *    gracefully (Holt-Winters falls back to damped Holt below two full seasons)
 *    and say so via `note`, instead of silently emitting a bad number.
 *  - Forecasts are floored at zero: demand cannot be negative.
 */

import { arimaForecast } from './arima.js'
import { computeAll, rankingScore } from './metrics.js'
import { optimizeSmoothing } from './optimize.js'

// ---------------------------------------------------------------- helpers

const positives = (values) => values.every((v) => v > 0)

function flat(value, horizon) {
  return new Array(horizon).fill(Math.max(0, value))
}

/** Sum of squared one-step-ahead errors — the objective the fitters minimise. */
function oneStepError(values, stepPredictor) {
  let sum = 0
  for (let t = 1; t < values.length; t++) {
    const pred = stepPredictor(t)
    if (!Number.isFinite(pred)) return Number.POSITIVE_INFINITY
    sum += (values[t] - pred) ** 2
  }
  return sum
}

/** Initial level/trend/seasonal components for Holt-Winters (Hyndman's scheme). */
function hwInitialState(values, m) {
  const n = values.length
  const meanOf = (from, to) => {
    let s = 0
    for (let i = from; i < to; i++) s += values[i]
    return s / (to - from)
  }
  const level = meanOf(0, m)
  const trend = (meanOf(m, 2 * m) - level) / m
  const seasonal = []
  for (let i = 0; i < m; i++) seasonal.push(values[i] - level)
  // Normalise so the seasonal components sum to zero (additive convention).
  const mean = seasonal.reduce((a, b) => a + b, 0) / m
  return { level, trend, seasonal: seasonal.map((s) => s - mean) }
}

// ---------------------------------------------------------------- models

/**
 * Seasonal naive — repeats the last full season. The standard baseline every
 * other model has to beat, and the reference point for MASE.
 */
export async function seasonalNaive(values, horizon, opts = {}) {
  const m = Math.max(1, Math.floor(opts.seasonality ?? 12))
  const n = values.length
  if (n < m) {
    return { values: flat(values[n - 1], horizon), note: 'history shorter than one season — repeated the last value' }
  }
  const lastSeason = values.slice(-m)
  const out = Array.from({ length: horizon }, (_, i) => lastSeason[i % m])
  return { values: out.map((v) => Math.max(0, v)) }
}

/** Trailing moving average, projected flat. */
export async function movingAverage(values, horizon, opts = {}) {
  const k = Math.min(values.length, Math.max(1, Math.floor(opts.window ?? 3)))
  const mean = values.slice(-k).reduce((a, b) => a + b, 0) / k
  return { values: flat(mean, horizon) }
}

/** Simple exponential smoothing — level only. */
export async function simpleExpSmoothing(values, horizon, opts = {}) {
  const alpha = opts.alpha ?? fitSes(values).alpha
  let level = values[0]
  for (let i = 1; i < values.length; i++) level = alpha * values[i] + (1 - alpha) * level
  return { values: flat(level, horizon) }
}

function fitSes(values) {
  const objective = ([a]) => {
    let level = values[0]
    return oneStepError(values, (t) => {
      const pred = level
      level = a * values[t] + (1 - a) * level
      return pred
    })
  }
  const { params } = optimizeSmoothing(objective, [0.5])
  return { alpha: params[0] }
}

/**
 * Holt's linear trend with damping. Damping stops a fitted trend extrapolating
 * a straight line forever, which is the usual failure mode on real demand data.
 */
export async function holtLinear(values, horizon, opts = {}) {
  const fitted = fitHolt(values)
  const alpha = opts.alpha ?? fitted.alpha
  const beta = opts.beta ?? fitted.beta
  const phi = opts.phi ?? fitted.phi

  let level = values[0]
  let trend = values.length > 1 ? values[1] - values[0] : 0
  for (let i = 1; i < values.length; i++) {
    const prevLevel = level
    level = alpha * values[i] + (1 - alpha) * (level + phi * trend)
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend
  }

  let damping = 0
  const out = []
  for (let h = 1; h <= horizon; h++) {
    damping += phi ** h
    out.push(level + damping * trend)
  }
  return { values: out.map((v) => Math.max(0, v)), note: `α=${alpha.toFixed(2)} β=${beta.toFixed(2)} φ=${phi.toFixed(2)}` }
}

function fitHolt(values) {
  const objective = ([a, b, p]) => {
    let level = values[0]
    let trend = values.length > 1 ? values[1] - values[0] : 0
    return oneStepError(values, (t) => {
      const pred = level + p * trend
      const prevLevel = level
      level = a * values[t] + (1 - a) * (level + p * trend)
      trend = b * (level - prevLevel) + (1 - b) * p * trend
      return pred
    })
  }
  const { params } = optimizeSmoothing(objective, [0.5, 0.2, 0.9])
  return { alpha: params[0], beta: params[1], phi: params[2] }
}

/** Holt-Winters, additive seasonality. */
export async function holtWintersAdditive(values, horizon, opts = {}) {
  return holtWinters(values, horizon, opts, 'add')
}

/** Holt-Winters, multiplicative seasonality. */
export async function holtWintersMultiplicative(values, horizon, opts = {}) {
  return holtWinters(values, horizon, opts, 'mul')
}

async function holtWinters(values, horizon, opts, mode) {
  const m = Math.max(2, Math.floor(opts.seasonality ?? 12))
  const n = values.length

  if (n < 2 * m) {
    const fallback = await holtLinear(values, horizon, opts)
    return {
      values: fallback.values,
      note: `needs ${2 * m} points for seasonality, has ${n} — used damped Holt instead`,
    }
  }
  if (mode === 'mul' && !positives(values)) {
    const fallback = await holtWintersAdditive(values, horizon, opts)
    return { values: fallback.values, note: 'non-positive values — used additive seasonality instead' }
  }

  const state = hwInitialState(values, m)
  const fitted = fitHoltWinters(values, m, mode, state)
  const alpha = fitted.alpha
  const beta = fitted.beta
  const gamma = fitted.gamma

  let level = state.level
  let trend = state.trend
  const seasonal = state.seasonal.slice()

  for (let t = 1; t < n; t++) {
    const si = seasonal[t % m]
    const prevLevel = level
    if (mode === 'add') {
      level = alpha * (values[t] - si) + (1 - alpha) * (level + trend)
    } else {
      level = alpha * (values[t] / si) + (1 - alpha) * (level + trend)
    }
    trend = beta * (level - prevLevel) + (1 - beta) * trend
    seasonal[t % m] = mode === 'add'
      ? gamma * (values[t] - level) + (1 - gamma) * si
      : gamma * (values[t] / level) + (1 - gamma) * si
  }

  const out = []
  for (let h = 1; h <= horizon; h++) {
    const si = seasonal[(n + h - 1) % m]
    const base = level + h * trend
    out.push(mode === 'add' ? base + si : base * si)
  }
  return {
    values: out.map((v) => Math.max(0, v)),
    note: `α=${alpha.toFixed(2)} β=${beta.toFixed(2)} γ=${gamma.toFixed(2)}`,
  }
}

function fitHoltWinters(values, m, mode, state) {
  const objective = ([a, b, g]) => {
    let level = state.level
    let trend = state.trend
    const seasonal = state.seasonal.slice()
    return oneStepError(values, (t) => {
      const si = seasonal[t % m]
      const pred = mode === 'add' ? level + trend + si : (level + trend) * si
      const prevLevel = level
      if (mode === 'add') {
        level = a * (values[t] - si) + (1 - a) * (level + trend)
      } else {
        level = a * (values[t] / si) + (1 - a) * (level + trend)
      }
      trend = b * (level - prevLevel) + (1 - b) * trend
      seasonal[t % m] = mode === 'add'
        ? g * (values[t] - level) + (1 - g) * si
        : g * (values[t] / level) + (1 - g) * si
      return pred
    })
  }
  const { params } = optimizeSmoothing(objective, [0.3, 0.1, 0.2])
  return { alpha: params[0], beta: params[1], gamma: params[2] }
}

/** Ordinary least squares on the time index, extrapolated. */
export async function linearRegressionTrend(values, horizon) {
  const n = values.length
  const meanX = (n - 1) / 2
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (values[i] - meanY)
    sxx += (i - meanX) ** 2
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = meanY - slope * meanX
  const out = Array.from({ length: horizon }, (_, i) => intercept + slope * (n + i))
  return { values: out.map((v) => Math.max(0, v)), note: `slope=${slope.toFixed(2)}/period` }
}

/** ARIMA / SARIMA with automatic order selection by AIC. */
export async function arimaAuto(values, horizon, opts = {}) {
  const out = await arimaForecast(values, horizon, { seasonality: opts.seasonality })
  return { values: out.map((v) => Math.max(0, v)) }
}

// ---------------------------------------------------------------- registry

export const MODELS = [
  {
    key: 'seasonal_naive',
    name: 'Seasonal Naive',
    description: 'Repeats the last full season. The baseline that everything else must beat.',
    run: seasonalNaive,
  },
  {
    key: 'moving_average',
    name: 'Moving Average (3M)',
    description: 'Projects the trailing 3-period average flat. Very stable, ignores trend.',
    run: movingAverage,
  },
  {
    key: 'ses',
    name: 'Simple Exp Smoothing',
    description: 'Level only, exponentially weighted toward recent periods.',
    run: simpleExpSmoothing,
  },
  {
    key: 'holt',
    name: "Holt's Linear Trend",
    description: 'Level plus a damped trend — damping avoids runaway projections.',
    run: holtLinear,
  },
  {
    key: 'hw_add',
    name: 'Holt-Winters (Additive)',
    description: 'Level, trend and constant seasonality. Best when seasonal swings are steady.',
    run: holtWintersAdditive,
  },
  {
    key: 'hw_mul',
    name: 'Holt-Winters (Multiplicative)',
    description: 'Level, trend and seasonality that scales with the level.',
    run: holtWintersMultiplicative,
  },
  {
    key: 'arima',
    name: 'ARIMA (Auto)',
    description: 'Auto-selected ARIMA/SARIMA by AIC. Captures autocorrelation and seasonality.',
    run: arimaAuto,
  },
  {
    key: 'linear_trend',
    name: 'Linear Regression Trend',
    description: 'Straight line fitted through history. Good for strong, steady trends.',
    run: linearRegressionTrend,
  },
]

export const MODEL_BY_KEY = Object.fromEntries(MODELS.map((m) => [m.key, m]))

// ---------------------------------------------------------------- harness

/**
 * Trains every model on the series minus its last `testPeriods` values, then
 * scores the held-out window. Returns one row per model, best (lowest MAPE) first.
 *
 * Models that throw are reported with an `error` string rather than being dropped,
 * so a failure is visible instead of silently shrinking the comparison table.
 */
export async function evaluateAll(values, options = {}) {
  const series = Array.from(values, Number).filter(Number.isFinite)
  const testPeriods = Math.max(1, Math.floor(options.testPeriods ?? 6))
  const seasonality = Math.max(2, Math.floor(options.seasonality ?? 12))

  if (series.length <= testPeriods + 2) {
    throw new Error(
      `need more than ${testPeriods + 2} data points to hold out ${testPeriods} for testing (got ${series.length})`,
    )
  }

  const cut = series.length - testPeriods
  const train = series.slice(0, cut)
  const test = series.slice(cut)

  // Evaluated sequentially on purpose. Running these in parallel is marginally
  // faster, but ARIMA's WASM work occupies the main thread, so every other
  // model's measured time ends up including that stall — and a "Time" column
  // that reports fiction is worse than no column at all.
  const rows = []
  for (const model of MODELS) {
    const started = now()
    try {
      const { values: predicted, note } = await model.run(train, testPeriods, { seasonality })
      const metrics = computeAll(test, predicted, train, seasonality)
      rows.push({
        key: model.key,
        name: model.name,
        metrics,
        score: rankingScore(metrics),
        fitted: predicted,
        note,
        elapsedMs: Math.round(now() - started),
        error: null,
      })
    } catch (err) {
      rows.push({
        key: model.key,
        name: model.name,
        metrics: { MAE: NaN, RMSE: NaN, MAPE: NaN, SMAPE: NaN, MASE: NaN },
        score: Number.POSITIVE_INFINITY,
        fitted: null,
        note: null,
        elapsedMs: Math.round(now() - started),
        error: err?.message || String(err),
      })
    }
  }

  return {
    rows: rows.slice().sort((a, b) => a.score - b.score),
    train,
    test,
    testPeriods,
    seasonality,
  }
}

/** Forecasts `horizon` periods with one model over the full series. */
export async function forecastWith(key, values, horizon, options = {}) {
  const model = MODEL_BY_KEY[key]
  if (!model) throw new Error(`unknown model: ${key}`)
  const series = Array.from(values, Number).filter(Number.isFinite)
  const seasonality = Math.max(2, Math.floor(options.seasonality ?? 12))
  const result = await model.run(series, Math.max(1, Math.floor(horizon)), { seasonality })
  return { key, name: model.name, values: result.values, note: result.note }
}

/** Picks the best model and forecasts with it in one call. */
export async function forecastBest(values, horizon, options = {}) {
  const evaluation = await evaluateAll(values, options)
  const best = evaluation.rows.find((r) => !r.error)
  if (!best) throw new Error('every model failed on this series')
  const forecast = await forecastWith(best.key, values, horizon, options)
  return { ...forecast, evaluation, bestRow: best }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
