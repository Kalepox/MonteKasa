import { expect, it } from 'vitest'
import type { SecurityFinding } from '../../shared/security'
import { visibleSecurityFindings } from './security-filter'

const finding = (id: string, lastSeen: number, resolvedAt?: number): SecurityFinding => ({
  id,
  lastSeen,
  resolvedAt,
  firstSeen: 1,
  rule: 'review-failed',
  version: 1,
  subject: id,
  severity: 'block',
  message: 'Notice',
  evidence: {}
})
it('hides resolved notices and orders active notices newest first without altering records', () => {
  const records = [finding('old', 2), finding('resolved', 10, 11), finding('new', 5)]
  expect(visibleSecurityFindings(records, false).map((f) => f.id)).toEqual(['new', 'old'])
  expect(records.map((f) => f.id)).toEqual(['old', 'resolved', 'new'])
})
it('mixes active and resolved notices by last detection, newest first', () => {
  const records = [
    finding('resolved-old', 9, 10),
    finding('active', 1),
    finding('resolved-new', 5, 12)
  ]
  expect(visibleSecurityFindings(records, true).map((f) => f.id)).toEqual([
    'resolved-old',
    'resolved-new',
    'active'
  ])
})
it('handles empty, all-resolved, and newly resolved snapshots', () => {
  expect(visibleSecurityFindings([], false)).toEqual([])
  const records = [finding('notice', 1)]
  expect(visibleSecurityFindings(records, false)).toHaveLength(1)
  records[0].resolvedAt = 2
  expect(visibleSecurityFindings(records, false)).toEqual([])
  expect(visibleSecurityFindings(records, true)).toHaveLength(1)
})
