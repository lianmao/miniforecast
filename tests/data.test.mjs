import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadXlsx, readFixture } from './helpers.mjs'
import { parseWorkbook, futureDates, inferFrequency, formatDate, addPeriods } from '../src/data.js'

// parseWorkbook reads globalThis.XLSX — the same bundle the page loads via <script>.
loadXlsx()

const xlsx = readFixture('sample_single_product.xlsx')
const xlsxMulti = readFixture('sample_multi_product.xlsx')

test('reads the single-product sample', () => {
  const result = parseWorkbook(xlsx)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.series.length, 1)
  assert.equal(result.series[0].name, 'Sales')
  assert.equal(result.series[0].points, 60)
  assert.equal(result.dateColumn, 'Date')
  assert.equal(formatDate(result.series[0].dates[0]), '2020-01-01')
  assert.equal(formatDate(result.series[0].dates.at(-1)), '2024-12-01')
})

test('reads all four products from the multi-product sample', () => {
  const result = parseWorkbook(xlsxMulti)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(
    result.series.map((s) => s.name),
    ['Product_A', 'Product_B', 'Product_C', 'Product_D'],
  )
  for (const series of result.series) {
    assert.equal(series.points, 60, `${series.name} should have 60 monthly points`)
    assert.ok(series.values.every(Number.isFinite), `${series.name} values must be numeric`)
    assert.ok(series.values.every((v) => v > 0), `${series.name} sample values are positive`)
  }
})

test('rejects a workbook with no date column', () => {
  const XLSX = globalThis.XLSX
  const sheet = XLSX.utils.aoa_to_sheet([
    ['alpha', 'beta'],
    [1, 2],
    [3, 4],
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1')
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })

  const result = parseWorkbook(buffer)
  assert.equal(result.ok, false)
  assert.match(result.message, /date column/i)
})

test('skips columns without enough usable points', () => {
  const XLSX = globalThis.XLSX
  const rows = [['Date', 'Good', 'TooShort', 'Text']]
  for (let i = 0; i < 24; i++) {
    rows.push([new Date(2020, i, 1), 100 + i, i < 3 ? 5 : null, 'n/a'])
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1')

  const result = parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.series.map((s) => s.name), ['Good'])
  const skipped = Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]))
  assert.match(skipped.TooShort, /12 needed/)
  assert.match(skipped.Text, /no numeric values/)
})

test('sums duplicate dates instead of double-counting rows', () => {
  const XLSX = globalThis.XLSX
  const rows = [['Date', 'Qty']]
  for (let i = 0; i < 24; i++) {
    rows.push([new Date(2020, i, 1), 10])
    rows.push([new Date(2020, i, 1), 5]) // same month, second plant
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1')

  const result = parseWorkbook(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
  assert.equal(result.series[0].points, 24)
  assert.ok(result.series[0].values.every((v) => v === 15))
})

test('infers monthly frequency', () => {
  const { series } = parseWorkbook(xlsx)
  const freq = inferFrequency(series[0].dates)
  assert.equal(freq.label, 'monthly')
  assert.equal(freq.regular, true)
})

test('builds a monthly future axis', () => {
  const dates = futureDates(new Date(2024, 11, 1), 3, 'monthly')
  assert.deepEqual(dates.map(formatDate), ['2025-01-01', '2025-02-01', '2025-03-01'])
})

test('month-end anchoring does not drift into the next month', () => {
  // 31 Jan + 1 month must land on 28/29 Feb, not 2/3 March.
  const jan31 = new Date(2024, 0, 31)
  assert.equal(formatDate(addPeriods(jan31, 1, 'monthly')), '2024-02-29')
  assert.equal(formatDate(addPeriods(jan31, 2, 'monthly')), '2024-03-31')
})
