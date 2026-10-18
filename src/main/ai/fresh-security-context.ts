import type { SecurityTarget } from '../../shared/agent'
import type { SecuritySnapshot } from '../../shared/security'
import { bounded } from '../security/network'
import { securityContext } from './security-context'

export async function freshSecurityContext(
  security: { monitor(): Promise<void>; snapshot(): SecuritySnapshot },
  target?: SecurityTarget,
  query?: string,
  timeoutMs = 15000
): Promise<string> {
  let unavailable = false
  try {
    await bounded(security.monitor(), timeoutMs)
  } catch {
    unavailable = true
  }
  const context = JSON.parse(securityContext(security.snapshot(), target, query))
  if (unavailable) context.monitoring = { ...context.monitoring, unavailable: true }
  return JSON.stringify(context)
}
