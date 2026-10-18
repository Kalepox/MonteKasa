import { currentTaxYear, type TaxProfile } from './tax-profile'

export type TaxCalculationId =
  'personal-gains' | 'holding-tax' | 'business-income' | 'vat' | 'forfettario'

export type TaxPreparationQuestion = {
  id: string
  title: string
  question: string
  help: string
  placeholder: string
}
export type TaxPreparationAnswer = {
  taxpayerId: string
  taxYear: number
  questionId: string
  status: 'unknown' | 'partial' | 'available'
  reference: string
  notes: string
}
export type TaxCalculationQuestions = {
  id: TaxCalculationId
  label: string
  questions: TaxPreparationQuestion[]
}

// These questions collect the availability of supporting information. An answer
// never supplies a verified tax input, changes a ledger record or enables a calculation.
const groups: TaxCalculationQuestions[] = [
  {
    id: 'personal-gains',
    label: 'Personal gains and losses',
    questions: [
      {
        id: 'acquisition-history',
        title: 'Acquisition costs',
        question: 'Do you have records showing when and how you acquired the crypto?',
        help: 'Gather acquisition lots, quantities, dates and documented euro costs, including earlier years and activity outside this app. A payment amount alone does not establish the acquisition cost.',
        placeholder: 'Purchase statements, acquisition ledger or earlier-year records'
      },
      {
        id: 'losses-elections',
        title: 'Earlier losses and elections',
        question: 'Do you have the records for earlier losses and any tax elections?',
        help: 'Keep the relevant returns, carryforward schedules and election documents. Note if you believe none apply; that statement still needs review.',
        placeholder: 'Earlier tax return or loss and election schedule'
      },
      {
        id: 'regime-withholding',
        title: 'Tax already handled',
        question:
          'Do you have statements showing each account’s tax treatment and any tax already withheld?',
        help: 'The saved profile regime is a declaration. Account statements and intermediary reports are needed to check what has already been handled and avoid counting it twice.',
        placeholder: 'Intermediary tax statement or account tax-treatment document'
      }
    ]
  },
  {
    id: 'holding-tax',
    label: 'Annual holding tax',
    questions: [
      {
        id: 'holding-history',
        title: 'Holdings through the year',
        question: 'Do you have records of what you held, for how long, and its euro value?',
        help: 'Gather historical quantities, acquisition and disposal dates, ownership periods and year-end or disposal valuations. Saved payments cannot reconstruct every holding. Account ownership shares remain in your saved account setup.',
        placeholder: 'Dated holdings statements and valuation references'
      },
      {
        id: 'stamp-duty',
        title: 'Duty already paid',
        question: 'Do you have statements showing any stamp duty or holding tax already paid?',
        help: 'Keep the provider statements or payment receipts, including their covered periods. If none was paid or you are unsure, explain that in the notes; it is not a verified exemption.',
        placeholder: 'Annual provider statement or tax payment receipt'
      }
    ]
  },
  {
    id: 'business-income',
    label: 'Business income',
    questions: [
      {
        id: 'accounting-policy',
        title: 'Accounting period and policy',
        question: 'Do you have your business’s fiscal-year dates and accounting policy?',
        help: 'Gather the fiscal period, accounting basis and policy for crypto activity. The saved report uses a calendar year; your accounting period may differ. These documents need review before revenue can be recognised.',
        placeholder: 'Accounting policy and fiscal-period documentation'
      },
      {
        id: 'business-basis',
        title: 'Business records and adjustments',
        question:
          'Do you have the revenue, expense and asset-basis records needed for this business?',
        help: 'Gather euro revenue and expenses, book values, tax bases and supported adjustments. The app already reads its saved payments; these supporting records explain their accounting treatment and any activity outside the app.',
        placeholder: 'General ledger, cost schedules or accountant’s adjustments'
      }
    ]
  },
  {
    id: 'vat',
    label: 'VAT',
    questions: [
      {
        id: 'vat-documents',
        title: 'Fiscal invoices and credit notes',
        question:
          'Do you have the fiscal invoices, invoice lines and credit notes for the underlying activity?',
        help: 'An app payment request is not necessarily a fiscal invoice. Supporting documents are needed to distinguish taxable supplies, adjustments and purchases; payment totals alone do not establish VAT.',
        placeholder: 'Fiscal invoice register and credit-note references'
      },
      {
        id: 'vat-supplies',
        title: 'Supply and customer details',
        question:
          'Do your records identify supply dates, locations, customer status and VAT treatment?',
        help: 'Include the underlying goods or services, customer VAT status, output and input VAT treatment and filing period. Cross-border and exceptional transactions may require a separate review.',
        placeholder: 'Supply register, customer VAT evidence or VAT review'
      }
    ]
  },
  {
    id: 'forfettario',
    label: 'Forfettario',
    questions: [
      {
        id: 'forfettario-eligibility',
        title: 'Eligibility and activity coefficient',
        question: 'Do you have a review of your eligibility and the coefficient for your activity?',
        help: 'Keep the eligibility review, activity classification (ATECO) and applicable coefficient. Selecting forfettario in your profile does not confirm eligibility.',
        placeholder: 'Eligibility review and activity-code documentation'
      },
      {
        id: 'forfettario-receipts',
        title: 'All business receipts',
        question: 'Do you have the full-year receipts records across every payment method?',
        help: 'The app already includes its saved payments. Keep the supporting total-receipts schedule for all business activity, including other accounts and payment methods; a crypto receipt is not automatically business revenue.',
        placeholder: 'Full-year receipts schedule or reconciled accounting records'
      },
      {
        id: 'forfettario-contributions',
        title: 'Mandatory contributions',
        question: 'Do you have records of mandatory contributions paid for the relevant period?',
        help: 'Keep contribution statements and payment receipts for review. Their treatment and applicable period must be checked before any calculation.',
        placeholder: 'Contribution statement and payment receipts'
      }
    ]
  }
]

export function calculationQuestions(profile: TaxProfile): TaxCalculationQuestions[] {
  if (profile.country !== 'IT') return []
  return groups
    .filter(
      (group) =>
        group.id === 'holding-tax' ||
        (profile.userType === 'personal' && group.id === 'personal-gains') ||
        (profile.userType === 'business' &&
          (group.id === 'business-income' ||
            group.id === 'vat' ||
            (group.id === 'forfettario' && profile.businessRegime === 'forfettario')))
    )
    .map((group) => ({ ...group, questions: group.questions.map((question) => ({ ...question })) }))
}

const questionIds = new Set(groups.flatMap((group) => group.questions.map(({ id }) => id)))

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${label} must be text of at most ${limit} characters.`)
  return value.trim()
}

export function validatePreparationAnswer(
  input: unknown,
  taxpayers: readonly { id: string; profile: TaxProfile }[],
  requireCurrentApplicability = true
): TaxPreparationAnswer {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid preparation answer.')
  const answer = input as Record<string, unknown>
  const taxpayerId = text(answer.taxpayerId, 200, 'Profile ID')
  const taxpayer = taxpayers.find((entry) => entry.id === taxpayerId)
  if (!taxpayer) throw new Error('Select an existing profile.')
  const taxYear = answer.taxYear
  if (!Number.isInteger(taxYear) || Number(taxYear) < 2023 || Number(taxYear) > currentTaxYear())
    throw new Error('Invalid preparation tax year.')
  const questionId = text(answer.questionId, 200, 'Question ID')
  if (!questionIds.has(questionId)) throw new Error('Unknown preparation question.')
  if (
    requireCurrentApplicability &&
    (taxYear !== taxpayer.profile.taxYear ||
      !calculationQuestions(taxpayer.profile).some((group) =>
        group.questions.some((question) => question.id === questionId)
      ))
  )
    throw new Error(
      'This question or tax year no longer matches the saved profile. Reload before saving.'
    )
  if (
    typeof answer.status !== 'string' ||
    !['unknown', 'partial', 'available'].includes(answer.status)
  )
    throw new Error('Invalid preparation answer status.')
  const reference = text(answer.reference, 500, 'Supporting reference')
  const notes = text(answer.notes, 2000, 'Notes')
  if (answer.status === 'available' && !reference)
    throw new Error('Add a supporting reference when records are available.')
  return {
    taxpayerId,
    taxYear: Number(taxYear),
    questionId,
    status: answer.status as TaxPreparationAnswer['status'],
    reference,
    notes
  }
}

export function preparationAnswerKey(
  answer: Pick<TaxPreparationAnswer, 'taxpayerId' | 'taxYear' | 'questionId'>
): string {
  return JSON.stringify([answer.taxpayerId, answer.taxYear, answer.questionId])
}
