import type { SecurityTarget } from '../../shared/agent'
import './agent.css'

const root = document.createElement('section')
root.id = 'agent-panel'
root.innerHTML = `
  <button id="agent-toggle" aria-expanded="false" aria-controls="agent-chat">✦ Ask AI</button>
  <section id="agent-chat" aria-label="Kasa Assistant" hidden>
    <header><div><strong>Kasa Assistant</strong><small>Qwen3.5 2B · local AI</small></div>
      <button id="agent-clear" type="button">New chat</button>
      <button id="agent-close" type="button" aria-label="Close assistant">Close assistant</button></header>
    <p class="agent-security-note">AI explanations can be wrong. Recorded checks remain authoritative. AI cannot approve payments or override warnings.</p>
    <div id="agent-messages" role="log" aria-label="Conversation"></div>
    <p id="agent-status" role="status">Checking the assistant connection…</p>
    <button id="agent-prepare" type="button" disabled>Prepare AI model · 1.28 GB</button>
    <form id="agent-form"><label for="agent-input">Message</label>
      <textarea id="agent-input" rows="2" maxlength="4000" placeholder="Prepare the model to start chatting" disabled required></textarea>
      <div><button id="agent-stop" type="button" disabled>Stop</button><button id="agent-send" type="submit" disabled>Send</button></div>
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
let modelReady = false
let installed = false
let closing = false
const stop = element<HTMLButtonElement>('agent-stop')
const clear = element<HTMLButtonElement>('agent-clear')
const status = element<HTMLElement>('agent-status')
const messages = element<HTMLElement>('agent-messages')
let reply: HTMLElement | undefined
let busy = false
const show = (open: boolean): void => {
  panel.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
  if (open) (modelReady ? input : prepare).focus()
}
const close = async (): Promise<void> => {
  if (closing) return
  closing = true
  toggle.disabled = true
  show(false)
  try {
    await window.agent.close()
    modelReady = false
    status.textContent = 'Assistant closed. Downloaded model files remain on this device.'
  } catch (error) {
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
  else void close()
}
element('agent-close').onclick = () => {
  void close()
}
root.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.hidden) {
    event.preventDefault()
    void close()
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
  send.disabled = input.disabled = busy || closing || !modelReady
  clear.disabled = busy || closing || !modelReady
  prepare.disabled = busy || closing
  prepare.hidden = modelReady
  prepare.textContent = installed ? 'Start assistant' : 'Download AI model · 1.28 GB'
  stop.disabled = !busy
  if (modelReady) input.placeholder = 'How can I help?'
}
window.addEventListener('kasa:explain-security', ((event: CustomEvent<SecurityTarget>) => {
  if (busy || closing) {
    show(true)
    return
  }
  securityTarget = event.detail
  input.value = `Explain this ${securityTarget.kind} (${securityTarget.id}): what was observed, why it matters, and what should I check next?`
  show(true)
  status.textContent = modelReady
    ? 'Selected security record. Send to explain using current recorded evidence.'
    : 'Start the assistant, then send to explain this security record.'
}) as EventListener)
clear.disabled = true
if (!window.agent) {
  status.textContent = 'Open the desktop app to use the local assistant.'
  send.disabled = true
} else if (!window.agent.status || !window.agent.prepare) {
  status.textContent =
    'Restart the desktop app with npm run dev from the repository root to load the updated assistant.'
} else {
  void window.agent
    .status()
    .then((state) => {
      modelReady = state.ready
      installed = state.installed
      updateControls()
      status.textContent = modelReady
        ? 'Model ready. Ask anything.'
        : installed
          ? 'Model saved on this device. Start the assistant to chat.'
          : 'Download the model once to chat locally. Files are kept when you close the assistant or app.'
    })
    .catch((error) => {
      status.textContent = errorText(error)
    })
  prepare.onclick = async () => {
    busy = true
    updateControls()
    status.textContent = 'Preparing model…'
    try {
      await window.agent.prepare()
      modelReady = true
      installed = true
      status.textContent = 'Model ready. You can start chatting.'
    } catch (error) {
      status.textContent = errorText(error)
      prepare.textContent = 'Retry model setup'
    } finally {
      busy = false
      updateControls()
      if (modelReady && !panel.hidden) input.focus()
    }
  }
  const unsubscribe = window.agent.onEvent((event) => {
    if (!busy) return
    if (event.type === 'evidence') {
      const facts = add('Recorded facts · authoritative', event.text)
      if (reply) messages.insertBefore(facts.parentElement!, reply.parentElement!)
    } else if (event.type === 'status') status.textContent = event.text
    else if (reply) {
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
      await window.agent.reset()
      securityTarget = undefined
      messages.replaceChildren()
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
    if (!text || busy || closing || !modelReady) return
    busy = true
    updateControls()
    add('You', text)
    reply = add('AI explanation · may be wrong', '')
    input.value = ''
    status.textContent = 'Starting…'
    try {
      reply.textContent = await window.agent.chat(text, securityTarget)
      status.textContent = 'Ready · replies stay on this device.'
    } catch (error) {
      status.textContent = errorText(error)
      if (!reply.textContent) reply.textContent = 'No reply completed.'
      input.value = text
    } finally {
      busy = false
      updateControls()
      reply = undefined
      if (!panel.hidden) input.focus()
    }
  }
}
