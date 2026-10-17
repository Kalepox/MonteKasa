import type { TaxEnrichment } from '../../shared/tax-enrichment'
import type { TaxScope } from '../../shared/tax-scope'

export const enrichmentQuestions: Record<
  TaxEnrichment['classification'],
  { explanation: string; value: string }
> = {
  unknown: {
    explanation:
      'You can save what you know now. The activity will remain unclassified until you confirm what happened.',
    value: 'What was the total value in euros, if known?'
  },
  purchase: {
    explanation:
      'Use this for acquiring crypto. Acquisition history and supporting records still need review; this entry does not establish a verified tax cost.',
    value: 'How much did you pay in euros, excluding separately recorded fees?'
  },
  sale: {
    explanation:
      'Use this for disposing of crypto in a sale. This records proceeds, not the gain or the tax due.',
    value: 'What were the total sale proceeds in euros, before separately recorded fees?'
  },
  'own-transfer': {
    explanation:
      'Use this when moving assets between accounts belonging to the same taxpayer. Link the other payment observation if available. A link alone does not prove a tax-free transfer.',
    value:
      'What was the transferred amount worth in euros, if known? This is a reference value, not sale proceeds.'
  },
  'goods-services': {
    explanation:
      'Use this for a payment for goods or services. An invoice request is not proof of payment. VAT treatment and business revenue still need separate review.',
    value: 'What was the total value of the goods or services in euros?'
  },
  income: {
    explanation:
      'Use this for a receipt you identify as income. Its legal classification and recognition date still need review.',
    value: 'What was the gross value received in euros, before separately recorded fees?'
  },
  refund: {
    explanation:
      'Use this for money returned against an earlier transaction. Link the original record if available. A refund is not automatically a deductible expense or a tax adjustment.',
    value: 'What was the total refunded amount worth in euros?'
  }
}

export function relatedRecordCandidates(
  scope: TaxScope,
  records: Set<string>,
  key: string,
  classification: string
): string[] {
  if (!['own-transfer', 'refund'].includes(classification)) return []
  const current = scope.assignments.find((a) => a.recordKey === key)
  if (!current || !records.has(key)) return []
  const owner = scope.accounts.find((a) => a.id === current.accountId)?.taxpayerId
  if (!owner) return []
  return scope.assignments
    .filter(
      (a) =>
        a.recordKey !== key &&
        records.has(a.recordKey) &&
        scope.accounts.some(
          (account) => account.id === a.accountId && account.taxpayerId === owner
        ) &&
        (classification === 'refund' ||
          (key.startsWith('payment:') &&
            a.recordKey.startsWith('payment:') &&
            a.accountId !== current.accountId &&
            a.assetId === current.assetId))
    )
    .map((a) => a.recordKey)
}
