/**
 * Reading uploaded spreadsheets into forecastable series.
 *
 * Uses the vendored SheetJS build (`globalThis.XLSX`, from vendor/xlsx.full.min.js).
 * Everything happens in the browser — the file never leaves the user's machine.
 */

const DATE_HINTS = ['date', 'time', 'month', 'year', 'period', 'day', 'week']

/**
 * Excel's day-zero in the 1900 date system: serial 43831 = 2020-01-01.
 * (Excel wrongly treats 1900 as a leap year, which is already baked into this
 * anchor for all dates from 1900-03-01 onward — i.e. every realistic input.)
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86400000

/**
 * Excel serial date -> local-midnight Date.
 *
 * Deliberately hand-rolled instead of using SheetJS's `cellDates: true`. On the
 * sample workbooks SheetJS returns 2019-12-31T15:59:17Z for a cell holding
 * 2020-01-01 — a timezone/rounding artefact that silently shifts every period by
 * a day. Converting the raw serial with UTC arithmetic and then rebuilding the
 * date in local time keeps the calendar day intact regardless of the viewer's
 * timezone.
 */
function serialToDate(serial) {
  const whole = Math.floor(serial)
  if (whole < 1 || whole > 200000) return null
  const utc = new Date(EXCEL_EPOCH_UTC + whole * MS_PER_DAY)
  if (Number.isNaN(utc.getTime())) return null
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
}

function parseDate(value) {
  if (value == null || value === '') return null

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    // ISO-typed cells ("d") arrive UTC-anchored, so read them back in UTC.
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Plausible Excel serial date (1954-10-03 .. 2447-06-21).
    return value > 20000 && value < 80000 ? serialToDate(value) : null
  }

  const text = String(value).trim()
  if (!text) return null

  // Month-only forms like 2020-01 or 2020/01 — anchor to the first of the month.
  const monthOnly = /^(\d{4})[-/.](\d{1,2})$/.exec(text)
  if (monthOnly) return new Date(Number(monthOnly[1]), Number(monthOnly[2]) - 1, 1)

  const yearOnly = /^(\d{4})$/.exec(text)
  if (yearOnly) return new Date(Number(yearOnly[1]), 0, 1)

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // Tolerate thousands separators and stray currency symbols from pasted data.
  const cleaned = String(value).replace(/[,\s\u00a0]/g, '').replace(/[^\d.eE+-]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Works out which column holds dates.
 * Prefers a column whose *name* looks like a date, falls back to whichever
 * column parses most successfully as dates.
 */
function detectDateColumn(headers, rows) {
  const score = (index) => {
    let hits = 0
    for (const row of rows) if (parseDate(row[index])) hits++
    return hits
  }

  const named = []
  const unnamed = []
  headers.forEach((raw, index) => {
    const label = String(raw ?? '').toLowerCase()
    const hitRate = score(index) / Math.max(1, rows.length)
    // A numeric measure column will never parse as a date, so this is safe.
    if (hitRate < 0.5) return
    if (DATE_HINTS.some((hint) => label.includes(hint))) named.push(index)
    else unnamed.push({ index, hitRate })
  })

  if (named.length) {
    // Among date-named columns, take the one that parses most cleanly.
    return named.sort((a, b) => score(b) - score(a))[0]
  }
  if (unnamed.length) return unnamed.sort((a, b) => b.hitRate - a.hitRate)[0].index
  return -1
}

/**
 * Reads the first worksheet of a workbook into per-column series.
 *
 * @param {ArrayBuffer} arrayBuffer  raw uploaded file bytes
 * @returns {{
 *   ok: boolean, message: string, sheetName: string, dateColumn: string,
 *   series: Array<{name: string, points: number, dates: Date[], values: number[]}>,
 *   skipped: Array<{name: string, reason: string}>
 * }}
 */
export function parseWorkbook(arrayBuffer, options = {}) {
  const XLSX = globalThis.XLSX
  if (!XLSX) {
    return { ok: false, message: 'Spreadsheet library not loaded (vendor/xlsx.full.min.js missing).' }
  }

  let workbook
  try {
    // cellDates stays OFF: SheetJS's Date conversion shifts calendar days (see
    // serialToDate above). Raw serials are converted deterministically instead.
    workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: false })
  } catch (err) {
    return { ok: false, message: `Could not read the file: ${err.message}` }
  }

  const sheetName = options.sheetName || workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return { ok: false, message: 'The workbook has no worksheets.' }

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null })
  if (!matrix.length) return { ok: false, message: `Sheet "${sheetName}" is empty.` }

  const headers = matrix[0].map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h).trim()))
  const rows = matrix.slice(1).filter((row) => row.some((cell) => cell != null && cell !== ''))
  if (!rows.length) return { ok: false, message: `Sheet "${sheetName}" has a header row but no data rows.` }

  const dateIndex = detectDateColumn(headers, rows)
  if (dateIndex < 0) {
    return {
      ok: false,
      message: 'Could not find a date column. Include a column of dates (named e.g. "Date" or "Month").',
    }
  }

  // Build one series per numeric column, pairing each value with its date.
  const series = []
  const skipped = []

  headers.forEach((name, index) => {
    if (index === dateIndex) return

    const paired = []
    for (const row of rows) {
      const date = parseDate(row[dateIndex])
      const value = toNumber(row[index])
      if (date && value != null) paired.push({ date, value })
    }

    if (!paired.length) {
      skipped.push({ name, reason: 'no numeric values' })
      return
    }
    if (paired.length < 12) {
      skipped.push({ name, reason: `only ${paired.length} usable points (12 needed)` })
      return
    }

    paired.sort((a, b) => a.date - b.date)

    // Collapse duplicate dates (e.g. plant-level rows rolled up into a total).
    const collapsed = []
    for (const point of paired) {
      const last = collapsed[collapsed.length - 1]
      if (last && last.date.getTime() === point.date.getTime()) last.value += point.value
      else collapsed.push({ ...point })
    }

    series.push({
      name,
      dates: collapsed.map((p) => p.date),
      values: collapsed.map((p) => p.value),
      points: collapsed.length,
    })
  })

  if (!series.length) {
    const detail = skipped.length ? ` (${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : ''
    return { ok: false, message: `No usable numeric columns found${detail}.` }
  }

  return {
    ok: true,
    message: `Loaded ${series.length} series from "${sheetName}" (${rows.length} rows).`,
    sheetName,
    dateColumn: headers[dateIndex],
    series,
    skipped,
  }
}

/** Median spacing in days — used to guess whether data is monthly, weekly, etc. */
export function inferFrequency(dates) {
  if (dates.length < 3) return { label: 'unknown', days: null, regular: false }
  const gaps = []
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / MS_PER_DAY)
  }
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  const spread = gaps[gaps.length - 1] - gaps[0]

  const bands = [
    { max: 1.5, label: 'daily', days: 1 },
    { max: 9, label: 'weekly', days: 7 },
    { max: 45, label: 'monthly', days: 30.44 },
    { max: 120, label: 'quarterly', days: 91.3 },
    { max: 400, label: 'yearly', days: 365.25 },
  ]
  const band = bands.find((b) => median <= b.max) || bands[bands.length - 1]

  return {
    label: band.label,
    days: band.days,
    regular: spread <= Math.max(2, median * 0.25),
  }
}

/** Advances a date by `steps` periods, preserving month-end anchoring. */
export function addPeriods(date, steps, frequency) {
  const d = new Date(date.getTime())
  if (frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly') {
    const months = frequency === 'monthly' ? steps : frequency === 'quarterly' ? steps * 3 : steps * 12
    const day = d.getDate()
    d.setDate(1)
    d.setMonth(d.getMonth() + months)
    // Snap to the last day of the target month when the source was month-end,
    // so a 31st-of-the-month series doesn't drift into the next month.
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    d.setDate(Math.min(day, daysInMonth))
  } else if (frequency === 'weekly') {
    d.setDate(d.getDate() + steps * 7)
  } else {
    d.setDate(d.getDate() + steps)
  }
  return d
}

/** Builds the future date axis for a horizon. */
export function futureDates(lastDate, horizon, frequency) {
  return Array.from({ length: horizon }, (_, i) => addPeriods(lastDate, i + 1, frequency))
}

/** Formats a date as YYYY-MM-DD (local time, no UTC shift). */
export function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Formats a number with thousands separators. */
export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
