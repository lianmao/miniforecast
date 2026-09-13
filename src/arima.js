/**
 * ARIMA (Auto) wrapper around the vendored `arima` package (MIT, an Emscripten
 * port of the ctsa C library).
 *
 * vendor/arima.js is a pre-bundled IIFE that defines `globalThis.ARIMAAsync` as a
 * Promise resolving to the ARIMA constructor. The async build is used because
 * Chrome refuses to synchronously compile WASM modules larger than 4 KB, and this
 * payload is ~210 KB. Keeping the promise means the page can render and train the
 * other seven models while the WASM is still compiling.
 */

let cachedLoad = null

/** True when vendor/arima.js has been included on the page. */
export function arimaAvailable() {
  return typeof globalThis.ARIMAAsync !== 'undefined'
}

/** Resolves to the ARIMA constructor (compiling the WASM on first call). */
export function loadArima() {
  if (!arimaAvailable()) {
    return Promise.reject(
      new Error('ARIMA bundle missing — vendor/arima.js must be loaded before forecasting'),
    )
  }
  if (!cachedLoad) cachedLoad = Promise.resolve(globalThis.ARIMAAsync)
  return cachedLoad
}

/**
 * Fits an auto-selected ARIMA/SARIMA model and forecasts `horizon` steps.
 *
 * A seasonal search is enabled once there are at least two full seasons of
 * history — below that the seasonal terms cannot be identified and the search
 * would just pick noise.
 *
 * @param {number[]} values      historical series, oldest first
 * @param {number} horizon       periods to forecast
 * @param {{seasonality?: number}} [options]
 * @returns {Promise<number[]>}  non-negative forecast values
 */
export async function arimaForecast(values, horizon, options = {}) {
  const seasonality = Math.max(2, Math.floor(options.seasonality ?? 12))
  const series = Array.from(values, Number).filter(Number.isFinite)
  if (series.length < 8) throw new Error('ARIMA needs at least 8 observations')

  const ARIMA = await loadArima()

  const config = { auto: true, verbose: false }
  if (series.length >= seasonality * 2) {
    config.s = seasonality
    config.P = 1
    config.D = 0
    config.Q = 1
  }

  const model = new ARIMA(config)
  model.train(series)
  const [prediction] = model.predict(horizon)
  if (!Array.isArray(prediction) && !ArrayBuffer.isView(prediction)) {
    throw new Error('ARIMA produced no prediction')
  }
  // Demand cannot be negative; the fitted model occasionally overshoots below zero.
  return Array.from(prediction, (v) => Math.max(0, Number(v)))
}
