export function accountDate(seconds: unknown) {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toLocaleString() : '—'
}

export function accountBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index += 1 }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${units[index]}`
}

export function centsFromInput(value: string): number | null {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) return null
  const [whole, decimals = ''] = value.trim().replace(',', '.').split('.')
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function accountMoney(cents: unknown, symbol = '¥') {
  const value = Number(cents)
  return Number.isSafeInteger(value) ? `${symbol}${(value / 100).toFixed(2)}` : '—'
}

export const flag = (value: unknown) => value === true || value === 1 || value === '1'

export function trafficValues(row: { u: number | string; d: number | string; server_rate?: number | string | null }) {
  const upload = Number(row.u)
  const download = Number(row.d)
  const rate = row.server_rate == null ? NaN : Number(row.server_rate)
  return {
    billed: upload + download,
    rate: Number.isFinite(rate) && rate >= 0 ? rate : null,
    upload: Number.isFinite(rate) && rate > 0 ? upload / rate : null,
    download: Number.isFinite(rate) && rate > 0 ? download / rate : null,
  }
}
