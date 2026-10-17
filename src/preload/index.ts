import { contextBridge, ipcRenderer } from 'electron'
import type { SecurityAPI } from '../shared/security'
import type { AgentAPI, AgentEvent } from '../shared/agent'

const agent: AgentAPI = {
  status: () => ipcRenderer.invoke('agent:status'),
  prepare: () => ipcRenderer.invoke('agent:prepare'),
  chat: (message, target) => ipcRenderer.invoke('agent:chat', message, target),
  close: () => ipcRenderer.invoke('agent:close'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  reset: () => ipcRenderer.invoke('agent:reset'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, update: AgentEvent): void =>
      callback(update)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
}

const security: SecurityAPI = {
  review: (intent) => ipcRenderer.invoke('security:review', intent),
  execute: (id, token, verified) => ipcRenderer.invoke('security:execute', id, token, verified),
  snapshot: () => ipcRenderer.invoke('security:snapshot'),
  acknowledge: (id) => ipcRenderer.invoke('security:acknowledge', id)
}

// Kasa API for the renderer – every call goes to an ipcMain.handle in src/main/index.ts
const kasa = {
  status: () => ipcRenderer.invoke('kasa:status'),
  snapshot: () => ipcRenderer.invoke('kasa:snapshot'),
  invoicePdf: (id: string) => ipcRenderer.invoke('kasa:invoicePdf', id),
  createInvoice: (client: string, amount: number | string) =>
    ipcRenderer.invoke('kasa:createInvoice', client, amount),
  receive: (fresh = false) => ipcRenderer.invoke('kasa:receive', fresh),
  send: (invoice: string, amount: number) => ipcRenderer.invoke('kasa:send', invoice, amount),
  approve: (id: string, refundInvoice: string) =>
    ipcRenderer.invoke('kasa:approve', id, refundInvoice),
  dismiss: (id: string) => ipcRenderer.invoke('kasa:dismiss', id),
  mockPay: (recipientId: string, amount: number) =>
    ipcRenderer.invoke('kasa:mockPay', recipientId, amount),
  onChanged: (cb: () => void) => {
    const l = (): void => cb()
    ipcRenderer.on('kasa:changed', l)
    return () => {
      ipcRenderer.removeListener('kasa:changed', l)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('security', security)
    contextBridge.exposeInMainWorld('kasa', kasa)
    contextBridge.exposeInMainWorld('agent', agent)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.security = security
  // @ts-ignore (define in dts)
  window.kasa = kasa
  ;(window as unknown as { agent: AgentAPI }).agent = agent
}
