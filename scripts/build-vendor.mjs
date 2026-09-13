/**
 * Vendors the third-party libraries into vendor/ as plain browser scripts.
 *
 *   node scripts/build-vendor.mjs
 *
 * Everything is copied/bundled locally rather than loaded from a CDN, so the
 * published page works offline and doesn't depend on jsdelivr/unpkg reachability
 * (which is unreliable from mainland China, where this tool is used).
 *
 * Re-run this after changing the versions in package.json.
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor')
mkdirSync(vendor, { recursive: true })

const jobs = [
  {
    label: 'Chart.js 4.4.1 (UMD)',
    from: 'node_modules/chart.js/dist/chart.umd.js',
    to: 'vendor/chart.umd.js',
  },
  {
    // The "mini" build reads and writes .xlsx only, and is less than a third the
    // size of the full one (250 KB vs 861 KB). The full build's extras — legacy
    // .xls, ODS, CSV, codepage tables — are not used here, and on the slow
    // GitHub-Pages-from-China path those 600 KB are several seconds of boot.
    label: 'SheetJS xlsx 0.18.5 (mini, minified)',
    from: 'node_modules/xlsx/dist/xlsx.mini.min.js',
    to: 'vendor/xlsx.mini.min.js',
  },
]

for (const job of jobs) {
  copyFileSync(join(root, job.from), join(root, job.to))
  const kb = (statSync(join(root, job.to)).size / 1024).toFixed(0)
  console.log(`  ✓ ${job.label} → ${job.to} (${kb} KB)`)
}

// ARIMA ships as CommonJS + a WASM blob. Bundle it into an IIFE that assigns
// `window.ARIMAAsync` = a Promise resolving to the ARIMA constructor.
// The async build is mandatory in browsers: Chrome refuses to synchronously
// compile WASM modules larger than 4 KB, and this one is ~210 KB.
//
// 'fs'/'path'/'buffer' are aliased to a stub: the Emscripten glue only requires
// them inside `ENVIRONMENT_IS_NODE` branches, which never run in a browser.
await build({
  entryPoints: [join(root, 'scripts/arima-entry.cjs')],
  outfile: join(vendor, 'arima.js'),
  bundle: true,
  format: 'iife',
  globalName: 'ARIMAAsync',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  logLevel: 'warning',
  alias: {
    fs: join(root, 'scripts/stubs/node-only.cjs'),
    path: join(root, 'scripts/stubs/node-only.cjs'),
    buffer: join(root, 'scripts/stubs/node-only.cjs'),
  },
})
const kb = (statSync(join(vendor, 'arima.js')).size / 1024).toFixed(0)
console.log(`  ✓ arima 0.2.8 (async WASM bundle) → vendor/arima.js (${kb} KB)`)

console.log('\nvendor/ ready.')
