export type AgentEvent = { type: 'status' | 'token' | 'evidence'; text: string }

export type SecurityTarget = { kind: 'finding' | 'operation'; id: string }

export interface AgentAPI {
  status(): Promise<{ ready: boolean; installed: boolean }>
  prepare(): Promise<void>
  chat(message: string, target?: SecurityTarget): Promise<string>
  close(): Promise<void>
  stop(): Promise<void>
  reset(): Promise<void>
  onEvent(callback: (event: AgentEvent) => void): () => void
}
