/**
 * Stub for Node-only builtins ('fs', 'path', 'buffer') referenced by the
 * arima Emscripten glue, aliased in by scripts/build-vendor.mjs.
 *
 * The glue only touches these inside `if (ENVIRONMENT_IS_NODE)` branches, which
 * never execute in a browser. The base64 WASM payload in arima/wrapper/native.bin.js
 * decodes via the browser's `atob` path, so the `require('buffer')` fallback on the
 * next line is dead code in this context — it only needs to *resolve*, not work.
 */
module.exports = {
  Buffer: {
    from() {
      throw new Error('buffer shim: node-only path reached in a browser build')
    },
  },
}
