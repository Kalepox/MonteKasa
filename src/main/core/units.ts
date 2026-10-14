import { rgbConfig } from '../rgb'

const FACTOR = 10 ** rgbConfig.precision

export const toRaw = (usdt: number): number => Math.round(usdt * FACTOR)
export const toUsdt = (raw: number): number => raw / FACTOR
