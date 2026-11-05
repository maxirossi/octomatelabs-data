export interface UsageEvent {
  source: string
  external_id: string
  occurred_at: string
  session_id?: string | null
  model?: string | null
  project?: string | null
  git_branch?: string | null
  client?: string | null
  is_subagent: boolean
  agent_name?: string | null
  tools?: string[] | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  thinking_tokens: number
  duration_ms?: number | null
  request_text?: string | null
  response_text?: string | null
  raw?: Record<string, unknown> | null
}

export interface FileState {
  offset: number
  lastPrompt?: string
  lastPromptAt?: string
  /** Copilot: se relee el archivo completo (delta log), así que se recuerdan los requests ya enviados. */
  mtimeMs?: number
  done?: string[]
}

export interface State {
  initializedAt?: string
  files: Record<string, FileState>
}
