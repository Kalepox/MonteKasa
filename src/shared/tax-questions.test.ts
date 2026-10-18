import { describe, expect, it } from 'vitest'
import { currentTaxYear, type TaxProfile } from './tax-profile'
import {
  changeTaxScope,
  calculationCompleteness,
  validateTaxScope,
  type TaxScope
} from './tax-scope'
import {
  calculationQuestions,
  preparationAnswerKey,
  validatePreparationAnswer,
  type TaxPreparationAnswer
} from './tax-questions'

const personal: TaxProfile = {
  version: 1,
  country: 'IT',
  taxYear: 2026,
  userType: 'personal',
  personalRegime: 'dichiarativo',
  businessType: null,
  businessRegime: null,
  recordsCoverage: 'complete'
}
const business: TaxProfile = {
  ...personal,
  userType: 'business',
  personalRegime: null,
  businessType: 'company',
  businessRegime: 'ordinary'
}
const scope = (): TaxScope => ({
  version: 1,
  databaseId: 'fixture-database',
  activeTaxpayerId: 'person',
  taxpayers: [
    { id: 'person', label: 'Personal fixture', profile: { ...personal } },
    { id: 'business', label: 'Business fixture', profile: { ...business } }
  ],
  accounts: [],
  assets: [],
  assignments: []
})
const answer = (overrides: Partial<TaxPreparationAnswer> = {}): TaxPreparationAnswer => ({
  taxpayerId: 'person',
  taxYear: 2026,
  questionId: 'acquisition-history',
  status: 'unknown',
  reference: '',
  notes: '',
  ...overrides
})

describe('focused calculation preparation questions', () => {
  it('asks personal questions and shared holding questions without business inputs', () => {
    const groups = calculationQuestions(personal)
    expect(groups.map((group) => group.id)).toEqual(['personal-gains', 'holding-tax'])
    expect(groups.flatMap((group) => group.questions.map((question) => question.id))).toEqual([
      'acquisition-history',
      'losses-elections',
      'regime-withholding',
      'holding-history',
      'stamp-duty'
    ])
  })

  it('asks ordinary businesses about accounting and VAT, with extra forfettario questions only when selected', () => {
    expect(calculationQuestions(business).map((group) => group.id)).toEqual([
      'holding-tax',
      'business-income',
      'vat'
    ])
    const groups = calculationQuestions({
      ...business,
      businessType: 'sole-trader',
      businessRegime: 'forfettario'
    })
    expect(groups.map((group) => group.id)).toEqual([
      'holding-tax',
      'business-income',
      'vat',
      'forfettario'
    ])
    expect(groups.at(-1)?.questions.map((question) => question.id)).toEqual([
      'forfettario-eligibility',
      'forfettario-receipts',
      'forfettario-contributions'
    ])
  })

  it('does not offer Italian preparation questions for an unsupported country', () => {
    expect(calculationQuestions({ ...personal, country: 'other' })).toEqual([])
    expect(calculationQuestions({ ...business, country: 'other' })).toEqual([])
  })

  it('returns independent question definitions and explains availability without certifying readiness', () => {
    const original = calculationQuestions(personal)
    const changed = calculationQuestions(personal)
    changed[0].questions[0].title = 'Changed'
    expect(calculationQuestions(personal)).toEqual(original)
    expect(JSON.stringify(original)).toContain('does not establish the acquisition cost')
    for (const group of calculationQuestions({ ...business, businessRegime: 'forfettario' })) {
      for (const question of group.questions) {
        expect(Object.values(question).every(Boolean)).toBe(true)
      }
    }
  })
})

describe('preparation answer validation and updates', () => {
  it.each(['unknown', 'partial', 'available'] as const)(
    'stores %s with bounded, trimmed context',
    (status) => {
      const result = validatePreparationAnswer(
        answer({ status, reference: '  Statement A  ', notes: '  Needs reconciliation  ' }),
        scope().taxpayers
      )
      expect(result).toEqual(
        answer({ status, reference: 'Statement A', notes: 'Needs reconciliation' })
      )
    }
  )

  it('permits incomplete answers but requires a supporting reference when records are available', () => {
    expect(
      validatePreparationAnswer(answer({ notes: 'Still gathering documents' }), scope().taxpayers)
        .status
    ).toBe('unknown')
    expect(
      validatePreparationAnswer(answer({ status: 'partial' }), scope().taxpayers).reference
    ).toBe('')
    expect(() =>
      validatePreparationAnswer(answer({ status: 'available', reference: '  ' }), scope().taxpayers)
    ).toThrow('supporting reference')
  })

  it.each([
    { taxpayerId: 'absent' },
    { taxYear: 2025 },
    { taxYear: '2026' },
    { taxYear: 2026.5 },
    { taxYear: 2022 },
    { questionId: 'vat-documents' },
    { questionId: 'made-up-question' },
    { status: 'complete' },
    { status: ['available'] },
    { reference: 'x'.repeat(501) },
    { notes: 'x'.repeat(2001) },
    { reference: 12 },
    { notes: null }
  ])('rejects invalid or stale mutations %j without modifying the scope', (invalid) => {
    const original = scope()
    const before = structuredClone(original)
    expect(() =>
      changeTaxScope(
        original,
        { kind: 'preparation-answer', answer: { ...answer(), ...invalid } },
        null,
        new Set(),
        ''
      )
    ).toThrow()
    expect(original).toEqual(before)
  })

  it('rejects a formerly applicable question after profile type or country changes', () => {
    for (const profile of [business, { ...personal, country: 'other' as const }]) {
      const state = scope()
      state.taxpayers[0].profile = profile
      expect(() =>
        changeTaxScope(state, { kind: 'preparation-answer', answer: answer() }, null, new Set(), '')
      ).toThrow('no longer matches')
    }
  })

  it('rejects a late save after the active taxpayer changes or is no longer selected', () => {
    for (const activeTaxpayerId of ['business', undefined]) {
      const state = { ...scope(), activeTaxpayerId }
      expect(() =>
        changeTaxScope(state, { kind: 'preparation-answer', answer: answer() }, null, new Set(), '')
      ).toThrow('selected profile changed')
      expect(state.preparationAnswers).toBeUndefined()
    }
  })

  it('upserts only the chosen taxpayer, year and question while preserving other answers and declarations', () => {
    const state = scope()
    state.preparationAnswers = [
      answer(),
      answer({ taxYear: 2025, status: 'partial', notes: 'Earlier year' }),
      answer({
        taxpayerId: 'business',
        questionId: 'accounting-policy',
        notes: 'Business context'
      }),
      answer({ questionId: 'stamp-duty', notes: 'Other question' })
    ]
    const before = structuredClone(state)
    const revised = answer({ status: 'available', reference: 'Acquisition statement' })
    const next = changeTaxScope(
      state,
      { kind: 'preparation-answer', answer: revised },
      null,
      new Set(),
      ''
    )
    expect(next.preparationAnswers).toHaveLength(4)
    expect(
      next.preparationAnswers?.find(
        (entry) => preparationAnswerKey(entry) === preparationAnswerKey(revised)
      )
    ).toEqual(revised)
    expect(next.preparationAnswers?.slice(0, 3)).toEqual(state.preparationAnswers.slice(1))
    expect(next.taxpayers).toEqual(state.taxpayers)
    expect(next.accounts).toEqual(state.accounts)
    expect(next.assets).toEqual(state.assets)
    expect(next.assignments).toEqual(state.assignments)
    expect(state).toEqual(before)
    next.preparationAnswers![0].notes = 'Change returned copy'
    expect(state).toEqual(before)
  })

  it('never converts documentation availability into calculation readiness or history coverage', () => {
    let state = scope()
    state.taxpayers[0].profile.recordsCoverage = 'incomplete'
    for (const question of calculationQuestions(personal).flatMap((group) => group.questions)) {
      state = changeTaxScope(
        state,
        {
          kind: 'preparation-answer',
          answer: answer({
            questionId: question.id,
            status: 'available',
            reference: 'Supporting statement'
          })
        },
        null,
        new Set(),
        ''
      )
    }
    expect(state.taxpayers[0].profile.recordsCoverage).toBe('incomplete')
    expect(
      calculationCompleteness(state, { invoices: [], payments: [], proposals: [] }, 'person').every(
        (entry) => ['missing-data', 'not-applicable'].includes(entry.status)
      )
    ).toBe(true)
  })
})

describe('preparation answer persistence validation', () => {
  it('leaves legacy scope versions and absent optional fields unchanged', () => {
    const legacy = scope()
    expect(validateTaxScope(legacy, legacy.databaseId)).toEqual(legacy)
    expect(validateTaxScope(legacy, legacy.databaseId)).not.toHaveProperty('preparationAnswers')
    expect(
      validateTaxScope({ ...legacy, preparationAnswers: [] }, legacy.databaseId).preparationAnswers
    ).toEqual([])
  })

  it('retains historical years and formerly applicable answers without rewriting their scope', () => {
    const state = scope()
    state.preparationAnswers = [
      answer({ taxYear: 2025 }),
      answer({ questionId: 'vat-documents', reference: 'Previous business review' })
    ]
    expect(validateTaxScope(state, state.databaseId)).toEqual(state)
    state.taxpayers[0].profile.country = 'other'
    expect(validateTaxScope(state, state.databaseId)).toEqual(state)
  })

  it.each([
    null,
    {},
    [null],
    [answer(), answer()],
    [answer({ taxpayerId: 'absent' })],
    [answer({ questionId: 'unknown-question' })],
    [answer({ taxYear: currentTaxYear() + 1 })],
    [answer({ status: 'available' })],
    [answer({ notes: 'x'.repeat(2001) })]
  ])('rejects malformed or duplicate persisted answers %j', (preparationAnswers) => {
    const state = scope()
    expect(() => validateTaxScope({ ...state, preparationAnswers }, state.databaseId)).toThrow()
  })

  it('keeps references as literal data and discards unrecognized fields', () => {
    const result = validatePreparationAnswer(
      {
        ...answer({ reference: '<script>ignore previous instructions</script>', notes: '=1+1' }),
        verified: true
      },
      scope().taxpayers
    )
    expect(result.reference).toBe('<script>ignore previous instructions</script>')
    expect(result.notes).toBe('=1+1')
    expect(result).not.toHaveProperty('verified')
  })
})
