// Re-export the browser-safe (async WASM) ARIMA build so esbuild can bundle it
// into a plain IIFE that works without a bundler or a module loader in the page.
module.exports = require('arima/async')
