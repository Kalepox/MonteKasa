import { rgbConfig } from './config'
import type { RgbBackend } from './types'
import { createKaleidoBackend } from './kaleido'
import { createMockBackend } from './mock'

export function createRgb(): {
  backend: RgbBackend
  pay?: (recipientId: string, amountRaw: number) => void
} {
  if (rgbConfig.mock) return createMockBackend()
  return { backend: createKaleidoBackend(), pay: undefined }
}

export { rgbConfig } from './config'
export type * from './types'
