// Wallet panel: create, back up, restore and unlock the in-app WDK wallet from the UI.
// Lives at the top of the Wallet page (sidebar → Wallet); the rest of the app stays usable while locked.
// Only active with RGB_BACKEND=wdk: with other backends the `wallet:call` IPC doesn't exist.
import QRCode from 'qrcode'
import './wallet-gate.css'

type WalletState = 'none' | 'locked' | 'unlocked'

const FAUCET = 'https://faucet.mutinynet.com'
const MIN_PASSWORD = 8

const call = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
  window.kasa.wallet(method, params) as Promise<T>

// IPC errors arrive as "Error invoking remote method 'wallet:call': Error: <message>"
const message = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

async function walletState(): Promise<WalletState | null> {
  try {
    return (await call<{ state: WalletState }>('state')).state
  } catch {
    return null // not the WDK backend, or the wallet service isn't up yet
  }
}

// ---------- DOM ----------

const root = document.createElement('div')
root.id = 'wallet-gate'
root.hidden = true
// top of the Wallet page, above the balance; falls back to the page body if the layout changes
const walletPage = document.querySelector('#view-dashboard .vb') ?? document.getElementById('view-dashboard')
;(walletPage ?? document.body).prepend(root)

let busy = false // a view is mid-action: don't let the poller replace it

function render(html: string): void {
  root.innerHTML = `<div class="wg-card"><div class="wg-brand">MonteKasa · self-custodial wallet</div>${html}</div>`
  root.hidden = false
  // only take focus when the Wallet page is the one on screen
  if (document.getElementById('view-dashboard')?.classList.contains('on'))
    root.querySelector<HTMLInputElement>('input, textarea')?.focus()
}

const $ = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!
const setError = (text: string): void => {
  $('.wg-error').textContent = text
}

function close(): void {
  root.hidden = true
  root.innerHTML = '' // drops any password or recovery words from the DOM
  window.dispatchEvent(new Event('wallet-unlocked')) // kasa.ts refreshes balances right away
}

// run an action with the buttons disabled; errors appear in the card
async function act(button: HTMLButtonElement, label: string, work: () => Promise<void>): Promise<void> {
  if (busy) return
  busy = true
  const original = button.textContent
  root.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true))
  button.textContent = label
  try {
    setError('')
    await work()
  } catch (e) {
    setError(message(e))
    root.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = false))
    button.textContent = original
  } finally {
    busy = false
  }
}

function onEnter(handler: () => void): void {
  root.querySelectorAll('input').forEach((i) =>
    i.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') handler()
    })
  )
}

function checkNewPassword(): string {
  const pw = $<HTMLInputElement>('#wg-pw').value
  const pw2 = $<HTMLInputElement>('#wg-pw2').value
  if (pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`)
  if (pw !== pw2) throw new Error('The two passwords do not match.')
  return pw
}

// ---------- views ----------

function viewUnlock(): void {
  render(`
    <h2>Unlock your wallet</h2>
    <p>Your keys are encrypted on this device. Enter your password to unlock them.</p>
    <div class="wg-field"><label for="wg-pw">Password</label><input id="wg-pw" type="password" autocomplete="current-password"/></div>
    <div class="wg-error"></div>
    <div class="wg-actions"><button class="btn btn-p" id="wg-go">Unlock</button></div>`)
  const go = $<HTMLButtonElement>('#wg-go')
  const submit = (): void =>
    void act(go, 'Unlocking…', async () => {
      const password = $<HTMLInputElement>('#wg-pw').value
      if (!password) throw new Error('Enter your password.')
      await call('unlock', { password })
      close()
    })
  go.onclick = submit
  onEnter(submit)
}

function viewWelcome(): void {
  render(`
    <h2>Set up your wallet</h2>
    <p>MonteKasa keeps your money in a self-custodial wallet on this device. Nobody else holds your keys — not even us.</p>
    <div class="wg-actions">
      <button class="btn btn-p" id="wg-create">Create a new wallet</button>
    </div>
    <button class="wg-link" id="wg-restore">I already have recovery words</button>`)
  $<HTMLButtonElement>('#wg-create').onclick = viewCreate
  $<HTMLButtonElement>('#wg-restore').onclick = viewRestore
}

function viewCreate(): void {
  render(`
    <h2>Choose a password</h2>
    <p>It unlocks the wallet on this device. It can't be recovered, but your recovery words can always restore the wallet.</p>
    <div class="wg-field"><label for="wg-pw">Password (${MIN_PASSWORD}+ characters)</label><input id="wg-pw" type="password" autocomplete="new-password"/></div>
    <div class="wg-field"><label for="wg-pw2">Repeat password</label><input id="wg-pw2" type="password" autocomplete="new-password"/></div>
    <div class="wg-error"></div>
    <div class="wg-actions"><button class="btn" id="wg-back">Back</button><button class="btn btn-p" id="wg-go">Create wallet</button></div>`)
  $<HTMLButtonElement>('#wg-back').onclick = viewWelcome
  const go = $<HTMLButtonElement>('#wg-go')
  const submit = (): void =>
    void act(go, 'Creating…', async () => {
      const { mnemonic } = await call<{ mnemonic: string }>('create', { password: checkNewPassword() })
      viewBackup(mnemonic)
    })
  go.onclick = submit
  onEnter(submit)
}

function viewBackup(mnemonic: string): void {
  const words = mnemonic
    .split(' ')
    .map((w, i) => `<span><b>${i + 1}</b>${w}</span>`)
    .join('')
  render(`
    <h2>Write down your recovery words</h2>
    <div class="wg-warn">These 12 words are the only way to recover your wallet. Write them on paper, in order. Never share them or store them in a chat, email or screenshot.</div>
    <div class="wg-words">${words}</div>
    <label class="wg-check"><input type="checkbox" id="wg-ok"/> I have written down all 12 words in order.</label>
    <div class="wg-error"></div>
    <div class="wg-actions"><button class="btn btn-p" id="wg-go" disabled>Continue</button></div>`)
  const go = $<HTMLButtonElement>('#wg-go')
  $<HTMLInputElement>('#wg-ok').onchange = (e) => (go.disabled = !(e.target as HTMLInputElement).checked)
  go.onclick = () => void viewFund() // the words leave the DOM with the next render
}

function viewRestore(): void {
  render(`
    <h2>Restore your wallet</h2>
    <p>Enter your 12 recovery words, separated by spaces, and choose a password for this device.</p>
    <div class="wg-field"><label for="wg-words">Recovery words</label><textarea id="wg-words" autocomplete="off" spellcheck="false"></textarea></div>
    <div class="wg-field"><label for="wg-pw">New password (${MIN_PASSWORD}+ characters)</label><input id="wg-pw" type="password" autocomplete="new-password"/></div>
    <div class="wg-field"><label for="wg-pw2">Repeat password</label><input id="wg-pw2" type="password" autocomplete="new-password"/></div>
    <div class="wg-error"></div>
    <div class="wg-actions"><button class="btn" id="wg-back">Back</button><button class="btn btn-p" id="wg-go">Restore</button></div>`)
  $<HTMLButtonElement>('#wg-back').onclick = viewWelcome
  const go = $<HTMLButtonElement>('#wg-go')
  go.onclick = () =>
    void act(go, 'Restoring…', async () => {
      const mnemonic = $<HTMLTextAreaElement>('#wg-words').value.trim().toLowerCase().split(/\s+/).join(' ')
      if (mnemonic.split(' ').length !== 12) throw new Error('Enter exactly 12 words.')
      await call('restore', { mnemonic, password: checkNewPassword() })
      await viewFund()
    })
}

// new wallets need test BTC (for fees) and UTXOs (to receive RGB assets)
async function viewFund(): Promise<void> {
  const { address } = await call<{ address: string }>('address')
  const qr = await QRCode.toDataURL(address, { margin: 1, width: 320 })
  render(`
    <h2>Add test BTC</h2>
    <p>Your wallet needs a little Bitcoin to pay network fees. On Mutinynet it's free: send some from the faucet to this address.</p>
    <div class="wg-address"><img src="${qr}" alt="Wallet address QR code"/><code>${address}</code></div>
    <div class="wg-actions">
      <button class="btn" id="wg-copy">Copy address</button>
      <a class="btn" href="${FAUCET}" target="_blank" rel="noreferrer">Open faucet</a>
    </div>
    <div class="wg-status" id="wg-bal">Waiting for BTC…</div>
    <div class="wg-error"></div>
    <div class="wg-actions">
      <button class="btn" id="wg-skip">Later</button>
      <button class="btn btn-p" id="wg-go" disabled>Prepare wallet</button>
    </div>`)
  $<HTMLButtonElement>('#wg-copy').onclick = () => void navigator.clipboard.writeText(address)
  $<HTMLButtonElement>('#wg-skip').onclick = close
  const go = $<HTMLButtonElement>('#wg-go')
  go.onclick = () =>
    void act(go, 'Preparing…', async () => {
      await call('createUtxos', { num: 10 })
      close()
    })

  // poll the BTC balance until the faucet payment arrives
  const poll = async (): Promise<void> => {
    if (root.hidden || !root.contains(go)) return
    try {
      const st = await window.kasa.status()
      if (st.btcSats > 0) {
        $('#wg-bal').textContent = `${st.btcSats.toLocaleString('en-US')} sats received`
        if (!busy) go.disabled = false
        return
      }
    } catch {
      /* try again */
    }
    setTimeout(() => void poll(), 10_000)
  }
  void poll()
}

// ---------- keep the gate in sync with the wallet ----------

let shown: WalletState | null = null

async function sync(): Promise<void> {
  if (busy) return
  const state = await walletState()
  if (state === null || state === 'unlocked') {
    if (state === 'unlocked' && shown && shown !== 'unlocked' && !root.hidden && !busy) {
      // unlocked elsewhere (or a view finished): keep the fund view if it's open
      if (!root.querySelector('#wg-bal')) close()
    }
    shown = state
    return
  }
  if (state === shown && !root.hidden) return // the right view is already open
  shown = state
  if (state === 'none') viewWelcome()
  else viewUnlock()
}

void sync()
setInterval(() => void sync(), 5_000) // also catches the wallet locking itself (e.g. service restart)
