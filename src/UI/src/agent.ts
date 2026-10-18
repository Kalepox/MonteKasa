import { taxScopeKey } from '../../shared/tax-selection'
import type { SecurityTarget } from '../../shared/agent'
import './agent.css'

const root = document.createElement('section')
root.id = 'agent-panel'
root.innerHTML = `
  <button id="agent-toggle" aria-expanded="false" aria-controls="agent-chat">✦ Ask AI</button>
  <section id="agent-chat" aria-label="Kasa Assistant" hidden>
    <header><div><strong id="agent-title">Kasa Assistant</strong><small>Qwen3.5 2B · <span id="agent-power-state">Checking…</span></small></div>
      <button id="agent-clear" type="button">New chat</button>
      <button id="agent-close" type="button" aria-label="Hide agent">Hide agent</button></header>
    <div class="agent-selector" role="group" aria-label="Choose assistant">
      <button id="agent-security-mode" type="button" aria-pressed="true">Kasa Assistant</button>
      <button id="agent-tax-mode" type="button" aria-pressed="false">Commercialista</button>
    </div>
    <p id="agent-note" class="agent-security-note">Payment summaries use recorded checks. AI explanations may be imperfect. Sending funds always requires your confirmation.</p>
    <div id="agent-messages" role="log" aria-label="Conversation"></div>
    <p id="agent-status" role="status">Checking the assistant connection…</p>
    <button id="agent-prepare" type="button" disabled>Prepare AI model · 1.28 GB</button>
    <form id="agent-form"><label for="agent-input">Message</label>
      <textarea id="agent-input" rows="2" maxlength="4000" placeholder="Prepare the model to start chatting" disabled required></textarea>
      <div><button id="agent-off" type="button" disabled>Turn off agent</button><button id="agent-stop" type="button" disabled>Stop</button><button id="agent-send" type="submit" disabled>Send</button></div>
    </form>
  </section>`
document.body.append(root)
const element = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!
const panel = element<HTMLElement>('agent-chat')
const toggle = element<HTMLButtonElement>('agent-toggle')
const input = element<HTMLTextAreaElement>('agent-input')
const send = element<HTMLButtonElement>('agent-send')
const prepare = element<HTMLButtonElement>('agent-prepare')
let securityTarget: SecurityTarget | undefined
let finishEvents: (() => void) | undefined
let modelReady = false
let installed = false
let checking = true
let setupError = false
let preparing = false
const taxStatus = document.getElementById('tax-ai-status')!
const taxPrepare = document.getElementById('tax-ai-prepare') as HTMLButtonElement
const taxClose = document.getElementById('tax-ai-close') as HTMLButtonElement
const available = ['status', 'prepare', 'close'].every(
  (method) => typeof window.agent?.[method as 'status' | 'prepare' | 'close'] === 'function'
)
let closing = false
const stop = element<HTMLButtonElement>('agent-stop')
const clear = element<HTMLButtonElement>('agent-clear')
const status = element<HTMLElement>('agent-status')
const messages = element<HTMLElement>('agent-messages')
let reply: HTMLElement | undefined
let busy = false
let mode: 'security' | 'tax' = 'security'
let taxKey: string | null = null
let selectionRevision = 0
let selectionRequest = 0
let taxSelectionVerified = false
let selectionLabel = ''
let suppressReply = false
const securityNote = element('agent-note').textContent
const taxAvailable = typeof window.agent?.commercialistaChat === 'function'
const taxSelectionBusy = (): boolean => {
  const view = document.getElementById('view-tax')
  return view?.dataset?.scopeBusy === 'true' || view?.dataset?.appProfileBusy === 'true'
}

// Conversations are session-only UI state. A model is shared, but drafts and
// transcripts are not. Tax conversations are additionally isolated by saved scope.
type Conversation = { draft: string; nodes: Node[]; status: string }
const conversations = new Map<string, Conversation>()
let conversationKey = 'security'
function saveConversation(): void {
  conversations.set(conversationKey, {
    draft: input.value,
    nodes: Array.from(messages.childNodes),
    status: status.textContent ?? ''
  })
}
function displayConversation(key: string): void {
  if (key === conversationKey) return
  saveConversation()
  conversationKey = key
  const saved = conversations.get(key)
  messages.replaceChildren(...(saved?.nodes ?? []))
  input.value = saved?.draft ?? ''
  status.textContent = saved?.status ?? 'New conversation. Ask a question to begin.'
}
function taxNote(): void {
  if (mode !== 'tax') return
  element('agent-note').textContent = taxKey
    ? `${selectionLabel}. Saved database data only. Each question is independent; check app results in Reports. This conversation stays separate from Kasa Assistant.`
    : 'Choose an app profile and complete or link its tax setup first. Your draft is kept here.'
}
function checkingTaxSelection(): void {
  ++selectionRequest
  taxSelectionVerified = false
  // A refresh is not a change of identity. Keep the editor, caret and transcript.
  updateControls()
}
async function loadTaxSelection(): Promise<void> {
  const request = ++selectionRequest
  taxSelectionVerified = false
  updateControls()
  if (taxSelectionBusy()) return
  try {
    const scope = await window.taxScope.get()
    if (request !== selectionRequest) return
    const nextKey = scope.appProfileId ? taxScopeKey(scope) : null
    const taxpayer = scope.taxpayers.find((entry) => entry.id === scope.activeTaxpayerId)
    const changed = nextKey !== taxKey
    if (changed) {
      ++selectionRevision
      if (busy && !preparing && mode === 'tax') {
        suppressReply = true
        if (reply) reply.textContent = 'Reply stopped because the selected profile or year changed.'
        status.textContent = 'Reply stopped after a selection change. Ask again for this scope.'
        void window.agent.stop().catch(() => {})
      }
      taxKey = nextKey
      if (mode === 'tax') displayConversation(`tax:${taxKey ?? 'unselected'}`)
    }
    selectionLabel = taxKey && taxpayer ? `${taxpayer.label} · ${taxpayer.profile.taxYear}` : ''
    taxSelectionVerified = true
    taxNote()
  } catch (error) {
    if (request === selectionRequest && mode === 'tax')
      status.textContent = `${errorText(error)} Your draft is kept. Reopen Commercialista to retry.`
  } finally {
    if (request === selectionRequest) updateControls()
  }
}
function switchMode(next: 'security' | 'tax'): void {
  if (mode === next) return
  displayConversation(next === 'security' ? 'security' : `tax:${taxKey ?? 'unselected'}`)
  mode = next
  suppressReply = false
  input.maxLength = next === 'tax' ? 1000 : 4000
  element('agent-title').textContent = next === 'tax' ? 'Commercialista' : 'Kasa Assistant'
  panel.setAttribute('aria-label', next === 'tax' ? 'Commercialista' : 'Kasa Assistant')
  element('agent-security-mode').setAttribute('aria-pressed', String(next === 'security'))
  element('agent-tax-mode').setAttribute('aria-pressed', String(next === 'tax'))
  element('agent-note').textContent = securityNote
  taxNote()
}
async function openTax(): Promise<void> {
  if (busy || closing) {
    show(true)
    return
  }
  switchMode('tax')
  show(true)
  if (!taxAvailable) {
    status.textContent = 'Restart the desktop app to load Commercialista explanations.'
    updateControls()
    return
  }
  await loadTaxSelection()
  if (mode === 'tax' && !panel.hidden && !input.disabled) input.focus()
}
const show = (open: boolean): void => {
  panel.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
  if (open) (modelReady ? input : prepare).focus()
}
const turnOff = async (): Promise<void> => {
  if (closing || checking || !available) return
  closing = true
  updateControls()
  status.textContent = 'Turning off agent…'
  try {
    await window.agent.close()
    modelReady = false
    setupError = false
    status.textContent = 'Agent is off. Downloaded model files remain on this device.'
  } catch (error) {
    setupError = true
    status.textContent = errorText(error)
    show(true)
  } finally {
    closing = false
    toggle.disabled = false
    updateControls()
    if (panel.hidden) toggle.focus()
  }
}
toggle.onclick = () => {
  if (panel.hidden) show(true)
  else show(false)
}
element('agent-close').onclick = () => {
  show(false)
  toggle.focus()
}
element('agent-off').onclick = () => {
  void turnOff()
}
root.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.hidden) {
    event.preventDefault()
    show(false)
    toggle.focus()
  }
})
const add = (role: string, text: string): HTMLElement => {
  const message = document.createElement('div')
  const label = document.createElement('strong')
  const content = document.createElement('p')
  label.textContent = role
  content.textContent = text
  message.append(label, content)
  messages.append(message)
  messages.scrollTop = messages.scrollHeight
  return content
}
const errorText = (error: unknown): string => {
  const message = String(error instanceof Error ? error.message : error)
  if (message.includes('No handler registered'))
    return 'The desktop backend is outdated. Quit the app completely and restart npm run dev from the repository root. Reloading this window is not enough.'
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
const updateControls = (): void => {
  input.disabled = busy || closing || checking || setupError || !modelReady
  send.disabled =
    busy ||
    closing ||
    checking ||
    setupError ||
    !modelReady ||
    (mode === 'tax' && (!taxKey || !taxAvailable || !taxSelectionVerified || taxSelectionBusy()))
  clear.disabled = busy || closing || checking || setupError || !modelReady
  prepare.disabled = busy || closing || checking || !available
  prepare.hidden = modelReady && !setupError
  prepare.textContent = !available
    ? 'AI unavailable'
    : checking
      ? 'Checking…'
      : setupError
        ? 'Retry AI status'
        : installed
          ? 'Turn on agent'
          : 'Download AI model · 1.28 GB'
  toggle.disabled = false
  element<HTMLButtonElement>('agent-security-mode').disabled = busy || closing
  element<HTMLButtonElement>('agent-tax-mode').disabled = busy || closing
  for (const id of ['tax-ai-open', 'tax-dashboard-explain'])
    (document.getElementById(id) as HTMLButtonElement).disabled = busy || closing
  element<HTMLButtonElement>('agent-close').disabled = false
  const power = !available
    ? 'Unavailable'
    : checking
      ? 'Checking…'
      : closing
        ? 'Turning off…'
        : setupError
          ? 'Check status'
          : preparing
            ? 'Starting…'
            : modelReady
              ? 'On'
              : 'Off'
  element('agent-power-state').textContent = power
  toggle.textContent = `✦ Ask AI · ${power}`
  element<HTMLButtonElement>('agent-off').disabled =
    checking || closing || preparing || !available || (!modelReady && !busy)
  taxPrepare.hidden = prepare.hidden
  taxPrepare.disabled = prepare.disabled
  taxPrepare.textContent = prepare.textContent
  taxClose.disabled = checking || closing || preparing || !available || (!modelReady && !busy)
  taxStatus.textContent = !available
    ? 'Local AI is unavailable. Open or restart the desktop app.'
    : checking
      ? 'Checking local AI…'
      : closing
        ? 'Turning off AI for both sections…'
        : setupError
          ? status.textContent
          : preparing
            ? status.textContent
            : busy
              ? `AI is answering a question in ${mode === 'tax' ? 'Commercialista' : 'Kasa Assistant'}.`
              : modelReady
                ? 'Local AI is running. Ask Commercialista to explain the selected profile and year.'
                : installed
                  ? 'AI is installed on this device. Turn it on for explanations.'
                  : 'Download the model once to use local AI. Automatic summaries remain available.'
  stop.disabled = !busy
  input.placeholder = modelReady
    ? mode === 'tax'
      ? 'Ask about saved activity, estimates or missing details'
      : 'How can I help?'
    : 'Turn on the agent to start chatting'
}
window.addEventListener('kasa:explain-security', ((event: CustomEvent<SecurityTarget>) => {
  if (busy || closing) {
    show(true)
    return
  }
  switchMode('security')
  updateControls()
  securityTarget = event.detail
  input.value = `Explain this ${securityTarget.kind} (${securityTarget.id}): what was observed, why it matters, and what should I check next?`
  show(true)
  status.textContent = modelReady
    ? 'Selected security record. Send to explain using current recorded evidence.'
    : 'Start the assistant, then send to explain this security record.'
}) as EventListener)
const checkStatus = async (): Promise<void> => {
  if (!available || busy || closing) return
  checking = true
  updateControls()
  try {
    const state = await window.agent.status()
    modelReady = state.ready
    installed = state.installed
    setupError = false
    status.textContent = modelReady
      ? 'Model ready.'
      : installed
        ? 'Model saved on this device. Turn on agent to chat.'
        : 'Download the model once. Files are kept when you turn off the agent or quit the app.'
  } catch (error) {
    setupError = true
    status.textContent = errorText(error)
  } finally {
    checking = false
    updateControls()
  }
}
clear.disabled = true
updateControls()
if (!available) {
  status.textContent = 'Local AI is unavailable. Open or restart the desktop app.'
} else {
  void checkStatus()
  prepare.onclick = async () => {
    if (busy || closing || checking) return
    if (setupError) {
      await checkStatus()
      return
    }
    busy = true
    preparing = true
    updateControls()
    status.textContent = installed ? 'Loading model from this device…' : 'Preparing model download…'
    updateControls()
    try {
      await window.agent.prepare()
      modelReady = true
      installed = true
      status.textContent = 'Model ready. You can start chatting.'
    } catch (error) {
      status.textContent = errorText(error)
      setupError = true
    } finally {
      preparing = false
      busy = false
      updateControls()
      if (modelReady && !panel.hidden) input.focus()
    }
  }
  const unsubscribe = window.agent.onEvent((event) => {
    if (event.type === 'turn-end') {
      finishEvents?.()
      return
    }
    if (!busy || (suppressReply && !preparing)) return
    if (event.type === 'evidence') {
      const facts = add(
        mode === 'tax' ? 'Saved tax summary · app results' : 'Payment details',
        event.text
      )
      facts.parentElement?.classList.add('agent-facts')
      if (reply) messages.insertBefore(facts.parentElement!, reply.parentElement!)
    } else if (event.type === 'evidence-details') {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = 'Technical details and evidence scope'
      const body = document.createElement('pre')
      body.style.whiteSpace = 'pre-wrap'
      body.textContent = event.text
      details.append(summary, body)
      messages.insertBefore(details, reply?.parentElement ?? null)
    } else if (event.type === 'status') {
      status.textContent = event.text
      updateControls()
    } else if (reply) {
      reply.textContent += event.text
      status.textContent = 'Replying…'
      messages.scrollTop = messages.scrollHeight
    }
  })
  window.addEventListener('beforeunload', () => {
    unsubscribe()
    void window.agent.stop().catch(() => {})
  })
  clear.onclick = async () => {
    try {
      if (mode === 'security') {
        await window.agent.reset()
        securityTarget = undefined
      }
      messages.replaceChildren()
      input.value = ''
      conversations.delete(conversationKey)
      status.textContent = 'New conversation started.'
      if (!panel.hidden) input.focus()
    } catch (error) {
      status.textContent = errorText(error)
    }
  }
  stop.onclick = async () => {
    stop.disabled = true
    status.textContent = 'Stopping…'
    try {
      await window.agent.stop()
    } catch (error) {
      status.textContent = errorText(error)
      stop.disabled = false
    }
  }
  element<HTMLFormElement>('agent-form').onsubmit = async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (
      !text ||
      busy ||
      closing ||
      checking ||
      setupError ||
      !modelReady ||
      (mode === 'tax' && (!taxKey || !taxAvailable || !taxSelectionVerified || taxSelectionBusy()))
    )
      return
    busy = true
    suppressReply = false
    const turnMode = mode
    const revision = selectionRevision
    const scopeKey = taxKey
    updateControls()
    add('You', text)
    const turnReply = add('Explanation', '')
    reply = turnReply
    input.value = ''
    status.textContent = 'Starting…'
    try {
      const eventsDone = new Promise<void>((resolve) => {
        finishEvents = resolve
      })
      const answer =
        turnMode === 'tax'
          ? await window.agent.commercialistaChat(text, scopeKey!)
          : await window.agent.chat(text, securityTarget)
      await eventsDone
      if (turnMode === 'tax' && revision !== selectionRevision) return
      turnReply.textContent = answer
      status.textContent =
        turnMode === 'tax'
          ? `Ready · ${selectionLabel} · saved data only`
          : 'Ready · replies stay on this device.'
    } catch (error) {
      if (turnMode === 'tax' && revision !== selectionRevision) return
      status.textContent = errorText(error)
      if (!turnReply.textContent) turnReply.textContent = 'No reply completed.'
      input.value = text
    } finally {
      busy = false
      updateControls()
      reply = undefined
      finishEvents = undefined
      if (!panel.hidden) input.focus()
    }
  }
}

// Both surfaces use the same handlers and lifecycle state; no second model is loaded.
taxPrepare.onclick = () => prepare.click()
taxClose.onclick = () => {
  void turnOff()
}

for (const id of ['tax-ai-open', 'tax-dashboard-explain'])
  document.getElementById(id)!.onclick = () => void openTax()
element('agent-security-mode').onclick = () => {
  if (busy || closing) return
  switchMode('security')
  updateControls()
}
element('agent-tax-mode').onclick = () => void openTax()
for (const event of ['kasa:tax-scope-busy', 'kasa:app-profile-busy'])
  window.addEventListener(event, () => {
    if (mode === 'tax') {
      if (event === 'kasa:app-profile-busy' && !taxSelectionBusy()) void loadTaxSelection()
      else checkingTaxSelection()
    }
  })
for (const event of [
  'kasa:tax-scope-idle',
  'kasa:tax-scope-updated',
  'kasa:app-profile-updated',
  'kasa:tax-activity-updated',
  'kasa:tax-profile-saved'
])
  window.addEventListener(event, () => {
    if (mode === 'tax') void loadTaxSelection()
  })
