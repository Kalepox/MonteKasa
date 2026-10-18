// Security page (sidebar → Security): the wallet itself. Lock it, show the recovery words again,
// change the password, and see unlock attempts. Payment checks live on the Fraud Check page.
// Uses the wallet service through `wallet:call`; recovery words and passwords never stay in the DOM.
import './wallet-gate.css'
import './wallet-security.css'

type WalletState = 'none' | 'locked' | 'unlocked' | 'unavailable'
interface SecurityEvent {
  type: string
  at: number
}
interface SecurityLog {
  events: SecurityEvent[]
  pausedUntil: number | null
  failLimit: number
}

const MIN_PASSWORD = 8
const HIDE_WORDS_AFTER_MS = 60_000

const call = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
  window.kasa.wallet(method, params) as Promise<T>
const message = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

const EVENT_LABELS: Record<string, [string, 'ok' | 'bad' | 'info']> = {
  created: ['Wallet created', 'info'],
  restored: ['Wallet restored from recovery words', 'info'],
  unlock: ['Unlocked', 'ok'],
  'unlock-failed': ['Unlock failed – wrong password', 'bad'],
  lock: ['Locked', 'info'],
  reveal: ['Recovery words shown', 'info'],
  'reveal-failed': ['Show recovery words failed – wrong password', 'bad'],
  'password-changed': ['Password changed', 'ok'],
  'password-change-failed': ['Password change failed – wrong password', 'bad'],
  paused: ['Too many wrong passwords – paused for 30 s', 'bad']
}

const root = document.getElementById('walletsec-root')
const view = document.getElementById('view-walletsec')
const $ = <T extends HTMLElement>(sel: string): T => root!.querySelector<T>(sel)!

let hideTimer: ReturnType<typeof setTimeout> | undefined

function render(): void {
  if (!root) return
  root.innerHTML = `
    <section class="wg-card ws-card">
      <div class="wg-brand">Wallet</div>
      <h2 id="ws-state">…</h2>
      <p id="ws-state-text">Checking the wallet…</p>
      <div class="wg-actions"><button class="btn" id="ws-lock" disabled>Lock now</button></div>
    </section>

    <section class="wg-card ws-card">
      <div class="wg-brand">Recovery words</div>
      <h2>Show recovery words</h2>
      <p>The 12 words restore this wallet on any device. Anyone who sees them can take your funds.</p>
      <div id="ws-words-box">
        <div class="wg-field"><label for="ws-reveal-pw">Password</label><input id="ws-reveal-pw" type="password" autocomplete="current-password"/></div>
        <div class="wg-actions"><button class="btn btn-p" id="ws-reveal">Show words</button></div>
      </div>
      <div class="wg-error" id="ws-reveal-error"></div>
    </section>

    <section class="wg-card ws-card">
      <div class="wg-brand">Password</div>
      <h2>Change password</h2>
      <p>The password unlocks the wallet on this device. Your recovery words stay the same.</p>
      <div class="wg-field"><label for="ws-pw-old">Current password</label><input id="ws-pw-old" type="password" autocomplete="current-password"/></div>
      <div class="wg-field"><label for="ws-pw-new">New password (${MIN_PASSWORD}+ characters)</label><input id="ws-pw-new" type="password" autocomplete="new-password"/></div>
      <div class="wg-field"><label for="ws-pw-new2">Repeat new password</label><input id="ws-pw-new2" type="password" autocomplete="new-password"/></div>
      <div class="wg-error" id="ws-pw-error"></div>
      <div class="wg-actions"><button class="btn btn-p" id="ws-pw-go">Change password</button></div>
    </section>

    <section class="wg-card ws-card ws-wide">
      <div class="wg-brand">Activity</div>
      <h2>Unlock attempts and security events</h2>
      <p id="ws-log-summary">Loading…</p>
      <table class="ws-log"><thead><tr><th>When</th><th>Event</th></tr></thead><tbody id="ws-log-rows"></tbody></table>
    </section>`
  $<HTMLButtonElement>('#ws-lock').onclick = () => void lockNow()
  $<HTMLButtonElement>('#ws-reveal').onclick = () => void reveal()
  $<HTMLInputElement>('#ws-reveal-pw').onkeydown = (e) => {
    if (e.key === 'Enter') void reveal()
  }
  $<HTMLButtonElement>('#ws-pw-go').onclick = () => void changePassword()
}

async function busy(
  button: HTMLButtonElement,
  label: string,
  work: () => Promise<void>
): Promise<void> {
  const original = button.textContent
  button.disabled = true
  button.textContent = label
  try {
    await work()
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

async function lockNow(): Promise<void> {
  await busy($('#ws-lock'), 'Locking…', async () => {
    await call('lock')
  }).catch(() => {})
  await refresh()
}

async function reveal(): Promise<void> {
  const err = $('#ws-reveal-error')
  err.textContent = ''
  const input = $<HTMLInputElement>('#ws-reveal-pw')
  await busy($('#ws-reveal'), 'Checking…', async () => {
    try {
      const { mnemonic } = await call<{ mnemonic: string }>('revealMnemonic', {
        password: input.value
      })
      showWords(mnemonic)
    } catch (e) {
      err.textContent = message(e)
    }
  })
  input.value = ''
  void refreshLog()
}

function showWords(mnemonic: string): void {
  const box = $('#ws-words-box')
  const words = mnemonic
    .split(' ')
    .map((w, i) => `<span><b>${i + 1}</b>${w}</span>`)
    .join('')
  box.innerHTML = `
    <div class="wg-warn">Write these down on paper, in order. Never share them or put them in a chat, email or screenshot.</div>
    <div class="wg-words">${words}</div>
    <div class="wg-actions"><button class="btn" id="ws-hide">Hide words</button></div>
    <p class="wg-status">Hidden automatically after 60 seconds.</p>`
  $<HTMLButtonElement>('#ws-hide').onclick = hideWords
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hideWords, HIDE_WORDS_AFTER_MS)
}

// puts the password form back, which also removes the words from the DOM
function hideWords(): void {
  clearTimeout(hideTimer)
  if (!root) return
  const box = root.querySelector('#ws-words-box')
  if (!box) return
  box.innerHTML = `
    <div class="wg-field"><label for="ws-reveal-pw">Password</label><input id="ws-reveal-pw" type="password" autocomplete="current-password"/></div>
    <div class="wg-actions"><button class="btn btn-p" id="ws-reveal">Show words</button></div>`
  $<HTMLButtonElement>('#ws-reveal').onclick = () => void reveal()
  $<HTMLInputElement>('#ws-reveal-pw').onkeydown = (e) => {
    if (e.key === 'Enter') void reveal()
  }
}

async function changePassword(): Promise<void> {
  const err = $('#ws-pw-error')
  err.textContent = ''
  const old = $<HTMLInputElement>('#ws-pw-old')
  const pw = $<HTMLInputElement>('#ws-pw-new')
  const pw2 = $<HTMLInputElement>('#ws-pw-new2')
  if (pw.value.length < MIN_PASSWORD) {
    err.textContent = `New password must be at least ${MIN_PASSWORD} characters.`
    return
  }
  if (pw.value !== pw2.value) {
    err.textContent = 'The two new passwords do not match.'
    return
  }
  await busy($('#ws-pw-go'), 'Saving…', async () => {
    try {
      await call('changePassword', { password: old.value, newPassword: pw.value })
      old.value = pw.value = pw2.value = ''
      err.textContent = ''
      ;(window as unknown as { toast?: (...a: string[]) => void }).toast?.(
        'ws-pw',
        '✓',
        'Password changed',
        'Use the new password next time you unlock.',
        'green'
      )
    } catch (e) {
      err.textContent = message(e)
    }
  })
  void refreshLog()
}

const when = (t: number): string =>
  new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

async function refreshLog(): Promise<void> {
  if (!root) return
  let log: SecurityLog
  try {
    log = await call<SecurityLog>('securityLog')
  } catch {
    $('#ws-log-summary').textContent = 'The wallet service is not running.'
    return
  }
  const dayAgo = Date.now() - 86_400_000
  const failed = log.events.filter((e) => e.type.endsWith('-failed') && e.at > dayAgo).length
  const paused = log.pausedUntil
    ? ` Password checks are paused until ${new Date(log.pausedUntil).toLocaleTimeString()}.`
    : ''
  $('#ws-log-summary').textContent =
    `${failed} failed password attempt${failed === 1 ? '' : 's'} in the last 24 hours. ` +
    `After ${log.failLimit} wrong passwords in a row, checks pause for 30 seconds.${paused}`
  $('#ws-log-rows').innerHTML =
    log.events
      .slice(0, 50)
      .map((e) => {
        const [label, tone] = EVENT_LABELS[e.type] ?? [e.type, 'info']
        return `<tr class="ws-${tone}"><td class="mono">${when(e.at)}</td><td>${label}</td></tr>`
      })
      .join('') || '<tr><td colspan="2" class="ws-empty">No events yet</td></tr>'
}

async function refreshState(): Promise<void> {
  if (!root) return
  let state: WalletState
  try {
    state = (await call<{ state: WalletState }>('state')).state
  } catch {
    state = 'unavailable'
  }
  const [title, text] = {
    unlocked: ['Unlocked', 'The wallet is open on this device. Lock it when you step away.'],
    locked: ['Locked', 'Unlock it on the Wallet page to send or receive.'],
    none: ['No wallet yet', 'Create or restore a wallet on the Wallet page.'],
    unavailable: [
      'Wallet unavailable',
      'The in-app wallet is not running (start with RGB_BACKEND=wdk).'
    ]
  }[state]
  $('#ws-state').textContent = title
  $('#ws-state-text').textContent = text
  $<HTMLButtonElement>('#ws-lock').disabled = state !== 'unlocked'
}

async function refresh(): Promise<void> {
  await Promise.all([refreshState(), refreshLog()])
}

render()
// refresh when the page is opened, and every 10 s while it's on screen
if (view)
  new MutationObserver(() => {
    if (view.classList.contains('on')) void refresh()
    else hideWords() // leaving the page hides the recovery words
  }).observe(view, { attributes: true, attributeFilter: ['class'] })
setInterval(() => {
  if (view?.classList.contains('on')) void refresh()
}, 10_000)
