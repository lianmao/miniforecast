/**
 * Loads the vendored browser bundles into the Node test process so the exact
 * same library code the page uses is what gets tested.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** SheetJS ships a UMD bundle — take its CommonJS branch and expose it globally. */
export function loadXlsx() {
  if (globalThis.XLSX) return globalThis.XLSX
  const code = readFileSync(join(root, 'vendor/xlsx.mini.min.js'), 'utf8')
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(module, module.exports, () => ({}))
  globalThis.XLSX = module.exports
  return globalThis.XLSX
}

/**
 * vendor/arima.js is an esbuild IIFE that opens with `var ARIMAAsync = (() => ...)`.
 * Evaluating it inside a Function scope keeps that `var` local, so we copy it onto
 * globalThis — mirroring what the <script> tag does in the browser.
 *
 * `process` is shadowed with undefined on purpose. The Emscripten glue branches on
 * `typeof process == "object"` to detect Node, and that branch touches __dirname and
 * the real filesystem. Hiding `process` forces the browser path, so these tests
 * exercise exactly the code the page runs.
 */
export function loadArimaBundle() {
  if (globalThis.ARIMAAsync) return globalThis.ARIMAAsync
  const code = readFileSync(join(root, 'vendor/arima.js'), 'utf8')
  const init = new Function(
    'process',
    'require',
    'module',
    'exports',
    '__dirname',
    `${code}\n;globalThis.ARIMAAsync = ARIMAAsync;`,
  )
  init(undefined, undefined, undefined, undefined, undefined)
  return globalThis.ARIMAAsync
}

export function readFixture(name) {
  const buf = readFileSync(join(root, 'sample_data', name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
