import type { SecurityFinding } from '../../shared/security'

export function visibleSecurityFindings(
  findings: SecurityFinding[],
  showResolved: boolean
): SecurityFinding[] {
  return findings
    .filter((finding) => showResolved || !finding.resolvedAt)
    .sort((a, b) => b.lastSeen - a.lastSeen || a.id.localeCompare(b.id))
}
