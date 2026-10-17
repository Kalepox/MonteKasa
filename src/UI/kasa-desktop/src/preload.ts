import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  sendFunds: (amount: number, address: string) => ipcRenderer.invoke('send-funds', amount, address),
  extractInvoice: () => ipcRenderer.invoke('extract-invoice'),
  issueRgb: () => ipcRenderer.invoke('issue-rgb')
})
