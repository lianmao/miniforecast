# MiniForecast — Demand Forecasting in the Browser

**Upload an Excel file, get a statistical forecast. No install, no account, no server.**

MiniForecast trains **8 forecasting models** on your demand history, scores them on a
held-out window, picks the winner, and projects the horizon you ask for — with an accuracy
dashboard that shows you how much to trust the result.

Everything runs client-side in the browser. Your file is never uploaded anywhere.

<!-- Replace with your live URL once GitHub Pages is enabled -->
**▶ Live app: https://lianmao.github.io/miniforecast/**

---

## Why it exists

Most forecasting tools are either a black box (upload, receive a number, trust it) or a
script a planner has to maintain. This one is a single static page: anyone with the link
can use it, and every number it shows — including how wrong each model was on the held-out
data — is visible.

## Features

- **8 models, one click** — seasonal naive, moving average, simple exponential smoothing,
  Holt's linear trend, Holt-Winters (additive and multiplicative), ARIMA (auto), linear trend
- **Honest model selection** — each model is trained on the history and scored on a holdout
  window you control (default: last 6 periods), ranked by MAPE
- **Per-product best model** — in batch mode every product gets *its own* winning model
  rather than one compromise model for the whole file
- **Batch mode** — forecast every product column at once, with a combined chart and one CSV
- **Accuracy dashboard** — actual vs predicted, residual plot, error distribution, and
  MAE / RMSE / MAPE / SMAPE / MASE
- **CSV export** — single product or the whole batch
- **Zero backend** — no server, no database, no signup. Deployable as static files.

## Using it

1. Open the app.
2. Drop in an `.xlsx` / `.xls` file (or click one of the sample-data links to try it instantly).
3. Set the holdout window, season length and forecast horizon in the sidebar.
4. On **Model Selection**, hit *Run all models* and look at the comparison table.
5. On **Forecast Results**, generate and download the forecast.
6. On **Accuracy Dashboard**, check whether you should believe it.

### Input format

A date column plus one or more numeric columns. The date column is auto-detected by name
(`date`, `month`, `period`, …) and falls back to whichever column parses as dates.

Single product:

| Date | Sales |
|------|-------|
| 2020-01-01 | 1025 |
| 2020-02-01 | 1102 |

Several products (batch mode):

| Date | Product_A | Product_B | Product_C |
|------|-----------|-----------|-----------|
| 2020-01-01 | 1025 | 508 | 1940 |
| 2020-02-01 | 1102 | 528 | 2302 |

Notes:

- **12 data points minimum** per product; 36+ monthly points is where the seasonal models
  start to earn their keep.
- Monthly data works best. The loader sorts by date, collapses duplicate dates by summing
  them (so plant-level rows roll up cleanly), and infers the period length.
- Models that cannot be identified on the available history degrade gracefully and say so.
  Holt-Winters falls back to damped Holt below two full seasons; multiplicative seasonality
  falls back to additive if the series contains zero or negative values.

## The models

| Model | What it captures | Notes |
|-------|------------------|-------|
| Seasonal Naive | Repeats last season's pattern | The baseline; MASE is measured against it |
| Moving Average (3M) | Level, projected flat | Very stable, ignores trend |
| Simple Exp Smoothing | Level, recent-weighted | No trend or seasonality |
| Holt's Linear Trend | Level + damped trend | Damping prevents runaway extrapolation |
| Holt-Winters (Additive) | Level + trend + constant seasonality | |
| Holt-Winters (Multiplicative) | Level + trend + scaling seasonality | |
| ARIMA (Auto) | Autocorrelation, trend, seasonality | Order chosen by AIC search |
| Linear Regression Trend | Straight-line trend | Good for strong steady trends |

Smoothing parameters are fitted with a **Nelder-Mead simplex** search rather than a coarse
grid, so the accuracy figures reflect a real optimum.

**On ARIMA:** it is a vendored build of the MIT-licensed [`arima`](https://github.com/zemlyansky/arima)
package (an Emscripten port of the `ctsa` C library), bundled with its WASM payload and
loaded asynchronously — Chrome refuses to synchronously compile WASM over 4 KB. If the WASM
fails to load, the other seven models still work.

## Metrics

The last *N* periods (default 6) are held out. Each model is trained on the earlier data,
forecast over the holdout window, and scored:

| Metric | Meaning | How to read it |
|--------|---------|----------------|
| MAE | Mean absolute error | In your data's units; lower is better |
| RMSE | Root mean squared error | ≥ MAE; a large gap means a few big misses |
| MAPE | Mean absolute percentage error | Primary ranking metric; < 10% is good for demand |
| SMAPE | Symmetric MAPE | Stabler than MAPE near zero |
| MASE | MAE scaled by seasonal-naive error | **< 1 beats repeating last season; > 1 is worse** |

## Privacy

There is no backend. The spreadsheet is parsed with SheetJS and forecast with the model
code, both running in your browser tab. Nothing is transmitted, and there is no analytics
beacon. You can verify this by opening DevTools → Network and watching that nothing leaves
the page after load.

## Local development

```bash
git clone https://github.com/lianmao/miniforecast.git
cd miniforecast
npm install                 # only needed to rebuild vendor/ or run tests
npm run serve               # http://localhost:8080
npm test                    # 28 Node test cases across metrics, models and parsing
```

Because the app is plain ES modules with no build step, you can also just open `index.html`
through any static server — there is nothing to compile.

### Vendored libraries

`vendor/` holds the third-party code, committed so the published page has **no CDN
dependency** (jsdelivr and unpkg are unreliable from mainland China, and a CDN outage would
take the tool down). Rebuild it after changing versions in `package.json`:

```bash
node scripts/build-vendor.mjs
```

That copies Chart.js and SheetJS and bundles ARIMA into a browser-safe IIFE with esbuild.
`node_modules/` is not committed.

## Deployment

Hosted on **GitHub Pages** — static files, so no server, no build, no cold starts, no
sleeping instances:

1. Push to `main`.
2. Repository **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
3. The app is live at `https://<user>.github.io/miniforecast/`.

`main` + root means it serves `index.html` directly. `.nojekyll` is included so Pages does
not try to process the files with Jekyll.

## Project structure

```
miniforecast/
├── index.html            # page shell and styles
├── src/
│   ├── app.js            # UI, state, charts, CSV export
│   ├── models.js         # the 8 models + evaluation harness
│   ├── metrics.js        # MAE / RMSE / MAPE / SMAPE / MASE
│   ├── optimize.js       # Nelder-Mead simplex
│   ├── data.js           # spreadsheet parsing, date handling, frequency
│   └── arima.js          # ARIMA wrapper (async WASM load)
├── vendor/               # committed third-party builds (Chart.js, SheetJS, ARIMA)
├── scripts/              # vendor bundler + local static server
├── tests/                # Node test suites
└── sample_data/          # sample workbooks
```

## License

MIT — see [LICENSE](LICENSE). Chart.js (MIT), SheetJS (Apache-2.0) and arima (MIT) are
vendored under their own licences.

---

## 中文说明

**浏览器里的需求预测工具。上传 Excel 就能出预测，无需安装、无需注册、无需服务器。**

上传历史需求数据后，它会自动训练 **8 个预测模型**，用你指定的留出期（默认最近 6 期）
做精度回测、按 MAPE 排序选出最优模型，并生成你指定期数的预测。

要点：

- **数据不出浏览器** —— 解析和计算全部在本地完成，文件不会上传到任何服务器，
  也没有埋点统计。可自行打开开发者工具 Network 面板验证。
- **按产品独立选型** —— 批量模式下每个产品用各自回测最优的模型，而不是一个模型硬套所有产品
- **批量模式** —— 一个文件里所有产品列一次性全部预测，附合并图表与整表导出
- **精度看板** —— 实际 vs 预测、残差图、误差分布，以及 MAE / RMSE / MAPE / SMAPE / MASE；
  其中 **MASE < 1 表示优于"重复去年同期"这个基准**
- **数据要求** —— 每个产品至少 12 个数据点，建议 36 个月以上；月度数据效果最好
- **优雅降级** —— 历史不足两个完整季节时，Holt-Winters 自动退化为阻尼 Holt 并明确标注；
  数据含 0 或负值时，乘法季节自动退化为加法季节
- **ARIMA(Auto)** 使用 AIC 自动定阶，以 WASM 形式内嵌，异步加载；即使它加载失败，
  其余 7 个模型仍可正常使用

本地运行与部署方式见上方英文部分。第三方库全部本地化（`vendor/`），不依赖 CDN。
