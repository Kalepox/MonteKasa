import { rgbConfig } from './config'
import type { RgbBackend } from './types'
import { createKaleidoBackend } from './kaleido'
import { createMockBackend } from './mock'
import { createWdkBackend } from './wdk'

export function createRgb(): {
  backend: RgbBackend
  pay?: (recipientId: string, amountRaw: number) => void
} {
  if (rgbConfig.mock) return createMockBackend()
  if (rgbConfig.backend === 'wdk') return { backend: createWdkBackend() }
  return { backend: createKaleidoBackend(), pay: undefined }
}

export { rgbConfig } from './config'
export type * from './types'
