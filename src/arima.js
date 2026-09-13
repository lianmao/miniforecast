/**
 * ARIMA (Auto) wrapper around the vendored `arima` package (MIT, an Emscripten
 * port of the ctsa C library).
 *
 * vendor/arima.js is a pre-bundled IIFE that defines `globalThis.ARIMAAsync` as a
 * Promise resolving to the ARIMA constructor. Two deliberate choices:
 *
 *  1. It is loaded *on demand* rather than via a <script> tag. It is 306 KB and
 *     nothing else needs it, so paying for it on first paint — which on GitHub
 *     Pages from mainland China is the difference between a ~2s and a ~7s boot —
 *     is a bad trade. app.js kicks the download off right after init, so in
 *     practice it has arrived before anyone clicks "Run all models".
 *  2. It uses the package's *async* build, because Chrome refuses to synchronously
 *     compile WASM modules larger than 4 KB and this payload is ~210 KB.
 */

const SCRIPT_URL = 'vendor/arima.js'
const SCRIPT_MARKER = 'data-miniforecast-arima'

let cachedLoad = null

/** True when vendor/arima.js has already been fetched and executed. */
export function arimaAvailable() {
  return typeof globalThis.ARIMAAsync !== 'undefined'
}

function injectScript() {
  return new Promise((resolve, reject) => {
    // Reuse a script tag that is already in flight, if there is one.
    const existing = document.querySelector(`script[${SCRIPT_MARKER}]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`could not load ${SCRIPT_URL}`)), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.setAttribute(SCRIPT_MARKER, 'true')
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`could not load ${SCRIPT_URL}`)), { once: true })
    document.head.appendChild(script)
  })
}

/**
 * Resolves to the ARIMA constructor, downloading and compiling the WASM bundle
 * on first call. Failures are not cached, so a flaky network can be retried.
 */
export function loadArima() {
  if (cachedLoad) return cachedLoad

  if (!arimaAvailable() && typeof document === 'undefined') {
    // Node context (the test harness loads the bundle explicitly).
    return Promise.reject(new Error('ARIMA bundle missing — vendor/arima.js must be loaded before forecasting'))
  }

  cachedLoad = (arimaAvailable() ? Promise.resolve() : injectScript()).then(() => {
    if (!arimaAvailable()) throw new Error('ARIMA bundle loaded but exposed no runtime')
    return globalThis.ARIMAAsync
  })

  cachedLoad.catch(() => {
    cachedLoad = null
  })

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
