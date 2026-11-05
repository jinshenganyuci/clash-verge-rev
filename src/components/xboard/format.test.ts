import { describe, expect, it } from 'vitest'

import { centsFromInput, trafficValues } from './format'

describe('account monetary amounts', () => {
  it('converts decimal amounts into integer cents without floating-point rounding', () => {
    expect(centsFromInput('1.01')).toBe(101)
    expect(centsFromInput('0.29')).toBe(29)
    expect(centsFromInput('12,3')).toBe(1230)
  })

  it('rejects amounts that cannot be safely submitted to the panel', () => {
    for (const input of ['0', '-1', '1.234', '1e3', 'NaN', '9007199254740992']) {
      expect(centsFromInput(input)).toBeNull()
    }
  })
})

describe('panel traffic accounting', () => {
  it('reconstructs actual traffic from billed counters and the rate', () => {
    expect(trafficValues({ u: 200, d: 600, server_rate: 2 })).toEqual({
      billed: 800, rate: 2, upload: 100, download: 300,
    })
  })

  it('does not report zero actual traffic when a free or unknown rate prevents reconstruction', () => {
    expect(trafficValues({ u: 0, d: 0, server_rate: 0 }).upload).toBeNull()
    expect(trafficValues({ u: 10, d: 20 }).download).toBeNull()
  })
})
