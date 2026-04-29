/**
 * Comfy-AI bridge wire protocol — v1
 *
 * JSON-encoded text frames over WebSocket. Two endpoint paths on the
 * daemon: /spa for browser SPA tabs, /ctl for local CLI clients. A small
 * /pair/<code> HTTP endpoint claims a one-shot pairing code that the SPA
 * generated, and binds the CLI to a specific browser tab.
 *
 * Versioned from day one: every envelope carries `v: 1`. Receivers MUST
 * reject mismatched versions.
 */

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 7437
export const DEFAULT_HOST = '127.0.0.1'

export type SessionId = string

/** Common envelope shape — every message has at least `v` and `type`. */
export interface Envelope {
  v: typeof PROTOCOL_VERSION
  type: string
}

// ---------- SPA → daemon ----------

export interface SpaHello extends Envelope {
  type: 'hello'
  sessionId: SessionId
  title?: string
}

/** Wraps any user-visible event the SPA produced (delta, tool, message). */
export interface SpaEvent extends Envelope {
  type: 'event'
  /** Subtype: "delta" | "tool" | "message" | "user" | "system" | "clear" */
  payload: SpaEventPayload
}

export type SpaEventPayload =
  | { kind: 'delta'; role: 'assistant'; text: string }
  | { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string }
  | {
      kind: 'tool'
      script: string
      stdout: string
      stderr?: string
      exitCode: number
    }
  | { kind: 'state'; isStreaming: boolean }
  | { kind: 'clear' }

export interface SpaEvalResult extends Envelope {
  type: 'evalResult'
  opId: string
  stdout: string
  stderr?: string
  exitCode: number
}

export interface SpaPairRequest extends Envelope {
  type: 'pair-request'
  /** Short code shown in the SPA's pairing modal. */
  code: string
  /** TTL in milliseconds for the pairing window. Defaults to 5 minutes. */
  ttlMs?: number
}

export interface SpaPong extends Envelope {
  type: 'pong'
}

export type SpaToDaemon =
  | SpaHello
  | SpaEvent
  | SpaEvalResult
  | SpaPairRequest
  | SpaPong

// ---------- daemon → SPA ----------

/** Request the SPA accept a user-typed prompt as if entered in its panel. */
export interface DaemonSend extends Envelope {
  type: 'send'
  text: string
  /** Annotates origin so the SPA can render with a "via comfy-ai" badge. */
  source: 'local' | 'remote'
}

/** Run a shell command in the SPA's runtime; SPA replies with evalResult. */
export interface DaemonEval extends Envelope {
  type: 'eval'
  opId: string
  script: string
}

export interface DaemonAbort extends Envelope {
  type: 'abort'
}

/** Confirms a pending pair-request was claimed by a CLI. */
export interface DaemonPaired extends Envelope {
  type: 'paired'
  code: string
}

export interface DaemonPing extends Envelope {
  type: 'ping'
}

export type DaemonToSpa =
  | DaemonSend
  | DaemonEval
  | DaemonAbort
  | DaemonPaired
  | DaemonPing

// ---------- CLI ↔ daemon (/ctl) ----------

export interface CliList extends Envelope {
  type: 'list'
}

export interface CliSubscribe extends Envelope {
  type: 'subscribe'
  sessionId: SessionId
}

export interface CliSend extends Envelope {
  type: 'send'
  sessionId: SessionId
  text: string
}

export interface CliEval extends Envelope {
  type: 'eval'
  sessionId: SessionId
  script: string
  opId: string
}

export interface CliAbort extends Envelope {
  type: 'abort'
  sessionId: SessionId
}

export type CliToDaemon = CliList | CliSubscribe | CliSend | CliEval | CliAbort

export interface DaemonSessions extends Envelope {
  type: 'sessions'
  sessions: { id: SessionId; title?: string; openedAt: number }[]
}

export interface DaemonCtlEvent extends Envelope {
  type: 'event'
  sessionId: SessionId
  payload: SpaEventPayload
}

export interface DaemonCtlEvalResult extends Envelope {
  type: 'evalResult'
  sessionId: SessionId
  opId: string
  stdout: string
  stderr?: string
  exitCode: number
}

export interface DaemonError extends Envelope {
  type: 'error'
  message: string
  /** Optional opId echoed when the error is tied to a specific request. */
  opId?: string
}

export type DaemonToCli =
  | DaemonSessions
  | DaemonCtlEvent
  | DaemonCtlEvalResult
  | DaemonError

// ---------- HTTP /pair/:code response ----------

export interface PairResponse {
  ok: true
  sessionId: SessionId
  title?: string
  token: string
}

export interface PairError {
  ok: false
  error: string
}
