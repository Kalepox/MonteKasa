import './commercialista.css'

const root = document.getElementById('view-tax')!
const pages = {
  overview: ['Your tax overview', 'See what is saved and what needs your attention.'],
  activity: [
    'Review your activity',
    'Work with payments already recorded in the app. Add only the missing context.'
  ],
  reports: [
    'Reports & supporting records',
    'Review calculation requirements and export records for your accountant.'
  ],
  profile: [
    'Your tax profiles',
    'Keep personal and business activity organised, with a clear tax year for each profile.'
  ]
} as const
type Page = keyof typeof pages

function closeSetup(): boolean {
  if (root.dataset.setupActive !== 'true') return true
  document.getElementById('tax-profile-cancel')!.click()
  return root.dataset.setupActive !== 'true'
}

function showPage(page: Page, focus = false): void {
  // Leaving setup saves the draft, so hidden wizard state cannot obscure other profile tools.
  if (page !== 'profile' && !closeSetup()) return
  root.dataset.taxPage = page
  for (const panel of root.querySelectorAll<HTMLElement>('[data-tax-panel]'))
    panel.hidden = panel.dataset.taxPanel !== page
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-tax-page]')) {
    if (button.dataset.taxPage === page) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  const title = document.getElementById('tax-page-title')!
  title.textContent = pages[page][0]
  document.getElementById('tax-page-description')!.textContent = pages[page][1]
  if (focus) title.focus({ preventScroll: true })
}

for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tax-page], [data-tax-open]')) {
  button.addEventListener('click', () => {
    const page = button.dataset.taxPage ?? button.dataset.taxOpen
    if (page && page in pages) showPage(page as Page, true)
  })
}

window.addEventListener('kasa:tax-profiles-loaded', (event) => {
  const { hasProfiles } = (event as CustomEvent<{ hasProfiles: boolean }>).detail
  showPage(hasProfiles ? 'overview' : 'profile')
})
window.addEventListener('kasa:tax-profiles-load-failed', () => showPage('profile'))
window.addEventListener('kasa:tax-setup-opened', () => {
  root.dataset.setupActive = 'true'
  showPage('profile')
})
window.addEventListener('kasa:tax-setup-closed', () => {
  delete root.dataset.setupActive
  if (root.dataset.taxPage === 'profile') {
    const resume = document.getElementById('tax-profile-resume') as HTMLButtonElement
    if (!resume.hidden && !resume.disabled) resume.focus()
    else document.getElementById('tax-page-title')!.focus({ preventScroll: true })
  }
})
window.addEventListener('kasa:tax-profile-created', () => {
  delete root.dataset.setupActive
  showPage('overview', true)
})

window.addEventListener('kasa:tax-profile-select', (event) => {
  const selector = document.getElementById('scope-taxpayer') as HTMLSelectElement
  const status = document.getElementById('tax-navigation-status')!
  if (selector.disabled || selector.closest('fieldset')?.disabled) {
    status.textContent =
      root.dataset.enrichmentDirty === 'true'
        ? 'Save or discard your record edits in Activity before changing profiles.'
        : root.dataset.activityEditing === 'true'
          ? 'Finish or cancel source ownership in Activity before changing profiles.'
          : 'Please wait for the saved profiles to finish loading.'
    status.hidden = false
    return
  }
  const { taxpayerId } = (event as CustomEvent<{ taxpayerId: string }>).detail
  if (![...selector.options].some((option) => option.value === taxpayerId)) return
  status.hidden = true
  selector.value = taxpayerId
  selector.dispatchEvent(new Event('change'))
  showPage('overview', true)
})

// Checklist actions must reveal their destination before the scope controller focuses it.
window.addEventListener('kasa:tax-navigate', (event) => {
  const target = document.getElementById((event as CustomEvent<{ target: string }>).detail.target)
  const page = target?.closest<HTMLElement>('[data-tax-panel]')?.dataset.taxPanel
  if (page && page in pages && closeSetup()) showPage(page as Page)
})
window.addEventListener('kasa:tax-enrichment-dirty', (event) => {
  const status = document.getElementById('tax-navigation-status')!
  status.hidden = !(event as CustomEvent<{ dirty: boolean }>).detail.dirty
  status.textContent =
    'You have unsaved record details in Activity. Save or discard them before changing profiles.'
})
showPage('overview')
