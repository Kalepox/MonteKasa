import { rgbConfig } from './config'
import { createKaleidoBackend } from './kaleido'
import { createMockBackend } from './mock'


export function createRgb() {
  if (rgbConfig.mock) return createMockBackend()
  return { backend: createKaleidoBackend(), pay: undefined }
}

export { rgbConfig } from './config'
export type * from './types'
