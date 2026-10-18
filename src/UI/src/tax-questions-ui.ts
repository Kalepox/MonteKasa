import type { KasaSnapshot } from '../../preload/index.d'
import type { TaxScope } from '../../shared/tax-scope'
import {
  calculationQuestions,
  type TaxCalculationId,
  type TaxPreparationAnswer
} from '../../shared/tax-questions'
import { buildTaxQuestionReview, type TaxQuestionReview } from './tax-question-review'
import { buildTaxReport, type TaxReport } from './tax-report'

const el = (id: string): HTMLElement => document.getElementById(id)!
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement
const root = el('view-tax')
const status = el('tax-questions-status')
type Context = { scope: TaxScope; snapshot: KasaSnapshot; report: TaxReport }
type Question = TaxQuestionReview['preparationQuestions'][number]
let context: Context | null = null
let calculation: TaxCalculationId = 'personal-gains'
let review: TaxQuestionReview | null = null
let questionId = ''
let active: Question | undefined
let draftKey = ''
let originalAnswer = ''
let dirty = false
let saving = false
let disposed = false
let includeSaved = false

const signature = (answer: TaxPreparationAnswer | undefined): string =>
  JSON.stringify(answer ?? null)
const externalEdit = (): boolean =>
  ['scopeBusy', 'enrichmentDirty', 'activityEditing', 'taxBasisDirty'].some(
    (key) => root.dataset[key] === 'true'
  )
function currentReview(): TaxQuestionReview | null {
  return context
    ? buildTaxQuestionReview(context.scope, context.snapshot, context.report, calculation)
    : null
}
function stale(): boolean {
  if (!context || !active || context.report.scopeKey !== draftKey) return true
  const { scope } = context
  const taxpayer = scope.taxpayers.find((item) => item.id === scope.activeTaxpayerId)
  if (
    !taxpayer ||
    JSON.stringify([scope.databaseId, taxpayer.id, taxpayer.profile.taxYear]) !== draftKey
  )
    return true
  const applicable = calculationQuestions(taxpayer.profile).some(
    (group) =>
      group.id === calculation && group.questions.some((question) => question.id === active!.id)
  )
  const saved = scope.preparationAnswers?.find(
    (answer) =>
      answer.taxpayerId === taxpayer.id &&
      answer.taxYear === taxpayer.profile.taxYear &&
      answer.questionId === active!.id
  )
  // Typing in a note checks only small metadata, never scans payment history.
  return !applicable || signature(saved) !== originalAnswer
}
function pendingQuestions(): Question[] {
  return (
    review?.preparationQuestions.filter((q) => includeSaved || q.answer?.status !== 'available') ??
    []
  )
}
function controls(): void {
  const blocked = saving || externalEdit()
  input('tax-questions-calculation').disabled = blocked || dirty || !context
  input('tax-question-show-saved').disabled = blocked || dirty || !context
  ;(el('tax-question-fields') as HTMLFieldSetElement).disabled = blocked || !active || !context
  input('tax-question-save').disabled = blocked || !active || stale()
  input('tax-question-discard').disabled = saving || !dirty
  const questions = pendingQuestions()
  const index = questions.findIndex((q) => q.id === active?.id)
  input('tax-question-previous').disabled = blocked || dirty || index <= 0
  input('tax-question-next').disabled =
    blocked || dirty || index < 0 || index >= questions.length - 1
  for (const button of el('tax-question-records').querySelectorAll<HTMLButtonElement>('button'))
    button.disabled = blocked || dirty || !context
}
function setDirty(value: boolean): void {
  dirty = value
  const locked = String(dirty || saving)
  if (root.dataset.taxQuestionsDirty !== locked) {
    root.dataset.taxQuestionsDirty = locked
    window.dispatchEvent(
      new CustomEvent('kasa:tax-questions-dirty', { detail: { dirty: dirty || saving } })
    )
  }
  controls()
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}
function render(): void {
  if (!context || dirty || saving) return
  const groups = calculationQuestions(context.report.taxpayer.profile)
  if (!groups.some((group) => group.id === calculation))
    calculation = groups[0]?.id ?? 'personal-gains'
  review = currentReview()
  const selector = el('tax-questions-calculation') as HTMLSelectElement
  selector.replaceChildren(
    ...groups.map((group) => {
      const option = node('option', group.label)
      option.value = group.id
      return option
    })
  )
  selector.value = calculation
  el('tax-questions-content').hidden = !review
  if (!review) {
    active = undefined
    status.textContent =
      'Questions for Italian tax calculations are not supported for this country. Saved records remain available in Reports.'
    controls()
    return
  }
  el('tax-questions-context').textContent =
    `${context.report.taxpayer.label} · ${review.taxYear} · ${review.calculation.label}. Record questions cover this year and assigned undated records; supporting history may include earlier years.`
  const cards = review.recordQuestions.map((question) => {
    const card = node('article', '')
    const button = node('button', 'Review first record')
    button.type = 'button'
    button.className = 'btn btn-s'
    button.onclick = () => {
      if (saving || dirty || externalEdit() || !context || !review) return
      window.dispatchEvent(
        new CustomEvent('kasa:tax-review-record', {
          detail: {
            taxpayerId: review.taxpayerId,
            recordKey: question.recordKeys[0],
            section: question.section
          }
        })
      )
    }
    card.append(
      node('h4', `${question.title} · ${question.recordKeys.length}`),
      node('p', question.question),
      node('p', question.help),
      button
    )
    return card
  })
  el('tax-question-records').replaceChildren(...cards)
  if (!cards.length)
    el('tax-question-records').textContent =
      'No further questions were found in these saved record fields. This does not verify the records or make a tax estimate ready.'
  el('tax-question-warnings').replaceChildren(
    ...review.warnings.map((warning) => node('li', warning))
  )
  const questions = pendingQuestions()
  active = questions.find((q) => q.id === questionId) ?? questions[0]
  questionId = active?.id ?? ''
  draftKey = review.scopeKey
  originalAnswer = signature(active?.answer)
  el('tax-question-form').hidden = !active
  const available = review.preparationQuestions.length - review.missingPreparation
  el('tax-question-progress').textContent = active
    ? `Question ${questions.indexOf(active) + 1} of ${questions.length} in this view · ${available} of ${review.preparationQuestions.length} topics have a saved supporting reference. These are preparation answers, not a completeness score.`
    : 'All preparation topics have saved supporting references. They remain unverified; numerical inputs and professional review are still required. Include saved questions to review or change an answer.'
  if (active) {
    el('tax-question-title').textContent = active.title
    el('tax-question-prompt').textContent = active.question
    el('tax-question-help').textContent = active.help
    input('tax-question-reference').placeholder = active.placeholder
    input('tax-question-answer').value = active.answer?.status ?? 'unknown'
    input('tax-question-reference').value = active.answer?.reference ?? ''
    input('tax-question-notes').value = active.answer?.notes ?? ''
    input('tax-question-reference').required = input('tax-question-answer').value === 'available'
  }
  status.textContent =
    'Answer what you know. Unknown or partial answers keep the question open; no tax calculation is enabled by these answers.'
  controls()
}

// Called only by the shared database-backed Reports loader; no extra reads on render.
export function updateTaxQuestions(
  scope: TaxScope,
  snapshot: KasaSnapshot,
  report: TaxReport
): void {
  if (disposed) return
  context = { scope, snapshot, report }
  if (dirty || saving) {
    status.textContent = stale()
      ? 'The saved profile, year or answer changed. Your draft is retained. Discard it to load the current questions; saving this draft is blocked.'
      : 'Your unsaved answer is retained. Save or discard it before moving to another question.'
    controls()
    return
  }
  render()
}
export function clearTaxQuestions(): void {
  context = null
  if (!dirty && !saving) {
    review = null
    active = undefined
    el('tax-questions-content').hidden = true
    el('tax-question-records').replaceChildren()
    el('tax-question-warnings').replaceChildren()
  }
  status.textContent =
    dirty || saving
      ? 'Waiting for the saved selection. Your draft is retained and saving is disabled until its context is confirmed.'
      : 'Select a saved profile, or refresh its saved records, to see focused questions.'
  controls()
}

el('tax-question-form').addEventListener('input', () => {
  if (!active || saving || !context || externalEdit()) return
  input('tax-question-reference').required = input('tax-question-answer').value === 'available'
  setDirty(true)
  status.textContent =
    'Unsaved answer. Save or discard edits before switching questions or profiles.'
})
el('tax-question-answer').onchange = () => {
  if (!active || saving || !context || externalEdit()) return
  input('tax-question-reference').required = input('tax-question-answer').value === 'available'
  setDirty(true)
}
el('tax-question-discard').onclick = () => {
  if (saving) return
  setDirty(false)
  if (context) render()
  else clearTaxQuestions()
}
el('tax-questions-calculation').onchange = () => {
  if (dirty || saving || externalEdit()) {
    input('tax-questions-calculation').value = calculation
    return
  }
  calculation = input('tax-questions-calculation').value as TaxCalculationId
  questionId = ''
  render()
}
el('tax-question-show-saved').onchange = () => {
  if (dirty || saving || externalEdit()) {
    input('tax-question-show-saved').checked = includeSaved
    return
  }
  includeSaved = input('tax-question-show-saved').checked
  questionId = ''
  render()
}
for (const [id, direction] of [
  ['previous', -1],
  ['next', 1]
] as const)
  el(`tax-question-${id}`).onclick = () => {
    if (dirty || saving || externalEdit()) return
    const questions = pendingQuestions()
    questionId =
      questions[questions.findIndex((q) => q.id === active?.id) + direction]?.id ?? questionId
    render()
  }

;(el('tax-question-form') as HTMLFormElement).onsubmit = async (event) => {
  event.preventDefault()
  if (saving || !context || !review || !active || externalEdit() || stale()) return
  const answer: TaxPreparationAnswer = {
    taxpayerId: review.taxpayerId,
    taxYear: review.taxYear,
    questionId: active.id,
    status: input('tax-question-answer').value as TaxPreparationAnswer['status'],
    reference: input('tax-question-reference').value.trim(),
    notes: input('tax-question-notes').value.trim()
  }
  if (answer.status === 'available' && !answer.reference) {
    status.textContent = 'Add a supporting reference before marking these records available.'
    input('tax-question-reference').focus()
    return
  }
  const expectedKey = draftKey
  const expectedAnswer = originalAnswer
  saving = true
  setDirty(dirty)
  status.textContent = 'Saving this taxpayer’s preparation answer…'
  try {
    const fresh = await window.taxScope.get()
    const taxpayer = fresh.taxpayers.find((item) => item.id === fresh.activeTaxpayerId)
    const saved = fresh.preparationAnswers?.find(
      (item) =>
        item.taxpayerId === answer.taxpayerId &&
        item.taxYear === answer.taxYear &&
        item.questionId === answer.questionId
    )
    if (disposed) return
    if (
      !taxpayer ||
      JSON.stringify([fresh.databaseId, taxpayer.id, taxpayer.profile.taxYear]) !== expectedKey ||
      signature(saved) !== expectedAnswer ||
      !context ||
      stale()
    )
      throw new Error(
        'The saved profile, year or answer changed. Discard this draft and review the current questions.'
      )
    const next = await window.taxScope.change({ kind: 'preparation-answer', answer })
    if (disposed) return
    saving = false
    setDirty(false)
    if (context?.report.scopeKey === expectedKey) {
      const nextReport = buildTaxReport(next, context.snapshot)
      if (nextReport?.scopeKey === expectedKey)
        updateTaxQuestions(next, context.snapshot, nextReport)
      else clearTaxQuestions()
    }
    status.textContent =
      'Preparation answer saved locally. The original ledger is unchanged; evidence and numerical tax inputs still need review.'
    window.dispatchEvent(new CustomEvent('kasa:tax-scope-updated', { detail: { scope: next } }))
  } catch (error) {
    if (!disposed)
      status.textContent = `Could not save: ${error instanceof Error ? error.message : String(error)} Your edits are retained.`
  } finally {
    saving = false
    if (!disposed) setDirty(dirty)
  }
}
window.addEventListener('kasa:tax-open-questions', (event) => {
  if (dirty || saving || externalEdit() || !context) return
  const id = (event as CustomEvent<{ calculationId: TaxCalculationId }>).detail.calculationId
  if (!calculationQuestions(context.report.taxpayer.profile).some((group) => group.id === id))
    return
  calculation = id
  questionId = ''
  render()
  window.dispatchEvent(
    new CustomEvent('kasa:tax-navigate', { detail: { target: 'tax-questions-title' } })
  )
  el('tax-questions-title').scrollIntoView({ block: 'start' })
  el('tax-questions-title').focus({ preventScroll: true })
})
for (const name of [
  'kasa:tax-scope-busy',
  'kasa:tax-scope-idle',
  'kasa:tax-enrichment-dirty',
  'kasa:tax-activity-editing',
  'kasa:tax-basis-dirty'
])
  window.addEventListener(name, controls)
window.addEventListener('beforeunload', () => {
  disposed = true
})
clearTaxQuestions()
