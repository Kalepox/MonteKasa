import type { TaxScopeAPI } from '../shared/tax-scope'
import type { TaxProfileAPI } from '../shared/tax-profile'
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { SecurityAPI } from '../shared/security'
import type { AgentAPI, AgentEvent } from '../shared/agent'

const taxScope: TaxScopeAPI = {
  organise: () => ipcRenderer.invoke('tax-scope:organise'),
  get: () => ipcRenderer.invoke('tax-scope:get'),
  change: (command) => ipcRenderer.invoke('tax-scope:change', command)
}

const taxProfile: TaxProfileAPI = {
  get: () => ipcRenderer.invoke('tax-profile:get'),
  save: (profile) => ipcRenderer.invoke('tax-profile:save', profile)
}

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
  transactionPdf: (nodeIdx: number) => ipcRenderer.invoke('kasa:transactionPdf', nodeIdx),
  createInvoice: (client: string, amount: number | string) =>
    ipcRenderer.invoke('kasa:createInvoice', client, amount),
  receive: (fresh = false, amount?: string | number) =>
    ipcRenderer.invoke('kasa:receive', fresh, amount),
  emailInvoice: (to: string | undefined, subject: string, body: string) =>
    ipcRenderer.invoke('kasa:emailInvoice', to, subject, body),
  send: (invoice: string, amount: number) => ipcRenderer.invoke('kasa:send', invoice, amount),
  approve: (id: string, refundInvoice: string) =>
    ipcRenderer.invoke('kasa:approve', id, refundInvoice),
  dismiss: (id: string) => ipcRenderer.invoke('kasa:dismiss', id),
  mockPay: (recipientId: string, amount: number) =>
    ipcRenderer.invoke('kasa:mockPay', recipientId, amount),
  wallet: (method: string, params?: unknown) => ipcRenderer.invoke('wallet:call', method, params),
  onChanged: (cb: () => void) => {
    const l = (): void => cb()
    ipcRenderer.on('kasa:changed', l)
    return () => {
      ipcRenderer.removeListener('kasa:changed', l)
    }
  },
  onPayment: (cb: (p: { amount: number; client?: string; invoiceId?: string }) => void) => {
    const l = (
      _e: IpcRendererEvent,
      p: { amount: number; client?: string; invoiceId?: string }
    ): void => cb(p)
    ipcRenderer.on('kasa:payment', l)
    return () => {
      ipcRenderer.removeListener('kasa:payment', l)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('taxScope', taxScope)
    contextBridge.exposeInMainWorld('taxProfile', taxProfile)
    contextBridge.exposeInMainWorld('security', security)
    contextBridge.exposeInMainWorld('kasa', kasa)
    contextBridge.exposeInMainWorld('agent', agent)
  } catch (error) {
    console.error(error)
  }
} else {
  window.taxScope = taxScope
  window.taxProfile = taxProfile
  // @ts-ignore (define in dts)
  window.security = security
  // @ts-ignore (define in dts)
  window.kasa = kasa
  ;(window as unknown as { agent: AgentAPI }).agent = agent
}
