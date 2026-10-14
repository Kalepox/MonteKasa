import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Kasa API for the renderer – every call goes to an ipcMain.handle in src/main/index.ts
const kasa = {
  status: () => ipcRenderer.invoke('kasa:status'),
  snapshot: () => ipcRenderer.invoke('kasa:snapshot'),
  createInvoice: (client: string, amount: number) => ipcRenderer.invoke('kasa:createInvoice', client, amount),
  receive: () => ipcRenderer.invoke('kasa:receive'),
  send: (invoice: string, amount: number) => ipcRenderer.invoke('kasa:send', invoice, amount),
  approve: (id: string, refundInvoice: string) => ipcRenderer.invoke('kasa:approve', id, refundInvoice),
  dismiss: (id: string) => ipcRenderer.invoke('kasa:dismiss', id),
  mockPay: (recipientId: string, amount: number) => ipcRenderer.invoke('kasa:mockPay', recipientId, amount),
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
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('kasa', kasa)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.kasa = kasa
}
