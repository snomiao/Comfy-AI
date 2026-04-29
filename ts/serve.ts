/**
 * Comfy-AI bridge daemon — a Bun.serve()-based WebSocket relay between
 * browser SPA tabs (path /spa) and local CLI clients (path /ctl).
 *
 * It deliberately doesn't run any agent logic itself. The browser SPA is
 * the source of truth + execution sandbox; the daemon relays messages
 * and tracks pairing state between the two.
 *
 * Design notes:
 * - Bind to localhost only by default. Trust boundary == this machine.
 * - Sessions are owned by SPA tabs; closing the tab ends the session.
 * - Pairing is session-scoped: a CLI is bound to one tab via a one-shot
 *   short code that the SPA generates and shows to the user.
 * - Tokens returned by /pair are opaque random UUIDs. CLI presents them
 *   as `?token=<...>` on /ctl WS upgrades.
 */
import type { ServerWebSocket } from 'bun'

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  type CliToDaemon,
  type DaemonToCli,
  type DaemonToSpa,
  type PairError,
  type PairResponse,
  type SessionId,
  type SpaToDaemon
} from './protocol'

interface SpaWsData {
  kind: 'spa'
  sessionId: SessionId | null
  title?: string
  openedAt: number
}

interface CtlWsData {
  kind: 'ctl'
  sessionId: SessionId | null
  /** Sessions whose events should be forwarded to this CLI. */
  subscriptions: Set<SessionId>
  /** Pending eval requests, keyed by opId. */
  pendingEvals: Set<string>
}

type WsData = SpaWsData | CtlWsData

interface SessionRecord {
  id: SessionId
  title?: string
  openedAt: number
  spa: ServerWebSocket<SpaWsData>
  /** Tokens that authenticate as this session. */
  tokens: Set<string>
}

interface PendingPair {
  code: string
  sessionId: SessionId
  expiresAt: number
}

const PAIR_DEFAULT_TTL_MS = 5 * 60_000

function uuid(): string {
  return crypto.randomUUID()
}

export interface ServeOptions {
  port?: number
  host?: string
  verbose?: boolean
}

export async function serve(opts: ServeOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT
  const host = opts.host ?? DEFAULT_HOST
  const log = (...a: unknown[]) =>
    opts.verbose ? console.error('[comfy-ai]', ...a) : undefined

  const sessions = new Map<SessionId, SessionRecord>()
  const pendingPairs = new Map<string, PendingPair>()
  const ctlSockets = new Set<ServerWebSocket<CtlWsData>>()

  const fanout = (sessionId: SessionId, payload: unknown): void => {
    for (const cli of ctlSockets) {
      if (!cli.data.subscriptions.has(sessionId)) continue
      cli.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'event',
          sessionId,
          payload
        } satisfies DaemonToCli)
      )
    }
  }

  const sendToCli = (
    ws: ServerWebSocket<CtlWsData>,
    msg: DaemonToCli
  ): void => {
    ws.send(JSON.stringify(msg))
  }
  const sendToSpa = (
    ws: ServerWebSocket<SpaWsData>,
    msg: DaemonToSpa
  ): void => {
    ws.send(JSON.stringify(msg))
  }

  const purgeExpiredPairs = (): void => {
    const now = Date.now()
    for (const [code, p] of pendingPairs) {
      if (p.expiresAt < now) pendingPairs.delete(code)
    }
  }

  const server = Bun.serve<WsData, unknown>({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname.startsWith('/pair/')) {
        purgeExpiredPairs()
        const code = url.pathname.slice('/pair/'.length).trim()
        if (!code) {
          return Response.json(
            { ok: false, error: 'missing code' } satisfies PairError,
            { status: 400 }
          )
        }
        const entry = pendingPairs.get(code)
        if (!entry) {
          return Response.json(
            {
              ok: false,
              error: 'unknown or expired pairing code'
            } satisfies PairError,
            { status: 404 }
          )
        }
        const session = sessions.get(entry.sessionId)
        if (!session) {
          pendingPairs.delete(code)
          return Response.json(
            {
              ok: false,
              error: 'session for this code is no longer open'
            } satisfies PairError,
            { status: 410 }
          )
        }
        const token = uuid()
        session.tokens.add(token)
        pendingPairs.delete(code)
        sendToSpa(session.spa, {
          v: PROTOCOL_VERSION,
          type: 'paired',
          code
        })
        return Response.json({
          ok: true,
          sessionId: session.id,
          title: session.title,
          token
        } satisfies PairResponse)
      }

      if (url.pathname === '/spa') {
        const ok = server.upgrade(req, {
          data: {
            kind: 'spa',
            sessionId: null,
            openedAt: Date.now()
          } satisfies SpaWsData
        })
        if (!ok) return new Response('upgrade failed', { status: 400 })
        return undefined
      }

      if (url.pathname === '/ctl') {
        const token = url.searchParams.get('token') ?? null
        let bound: SessionId | null = null
        if (token) {
          for (const s of sessions.values()) {
            if (s.tokens.has(token)) {
              bound = s.id
              break
            }
          }
          if (!bound) {
            return new Response('invalid token', { status: 401 })
          }
        }
        const ok = server.upgrade(req, {
          data: {
            kind: 'ctl',
            sessionId: bound,
            subscriptions: new Set(bound ? [bound] : []),
            pendingEvals: new Set()
          } satisfies CtlWsData
        })
        if (!ok) return new Response('upgrade failed', { status: 400 })
        return undefined
      }

      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          version: PROTOCOL_VERSION,
          sessions: sessions.size
        })
      }

      return new Response(
        `comfy-ai bridge daemon (v${PROTOCOL_VERSION})\n` +
          `sessions: ${sessions.size}\n` +
          `endpoints: ws://${host}:${port}/spa  ws://${host}:${port}/ctl  GET /pair/:code  GET /health\n`,
        { headers: { 'Content-Type': 'text/plain' } }
      )
    },
    websocket: {
      message(ws, raw) {
        let msg: unknown
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        } catch {
          return
        }
        if (
          !msg ||
          typeof msg !== 'object' ||
          (msg as { v?: number }).v !== PROTOCOL_VERSION
        ) {
          return
        }
        if (ws.data.kind === 'spa') {
          handleSpaMessage(ws as ServerWebSocket<SpaWsData>, msg as SpaToDaemon)
        } else {
          handleCtlMessage(ws as ServerWebSocket<CtlWsData>, msg as CliToDaemon)
        }
      },
      close(ws) {
        if (ws.data.kind === 'spa') {
          const id = ws.data.sessionId
          if (id) {
            sessions.delete(id)
            log('session closed', id)
            for (const cli of ctlSockets) cli.data.subscriptions.delete(id)
          }
        } else {
          ctlSockets.delete(ws as ServerWebSocket<CtlWsData>)
          log('cli disconnected')
        }
      }
    }
  })

  function handleSpaMessage(
    ws: ServerWebSocket<SpaWsData>,
    msg: SpaToDaemon
  ): void {
    switch (msg.type) {
      case 'hello': {
        if (!msg.sessionId) return
        ws.data.sessionId = msg.sessionId
        ws.data.title = msg.title
        sessions.set(msg.sessionId, {
          id: msg.sessionId,
          title: msg.title,
          openedAt: ws.data.openedAt,
          spa: ws,
          tokens: new Set()
        })
        log('session opened', msg.sessionId, msg.title ?? '')
        return
      }
      case 'event': {
        const id = ws.data.sessionId
        if (!id) return
        fanout(id, msg.payload)
        return
      }
      case 'evalResult': {
        const id = ws.data.sessionId
        if (!id) return
        for (const cli of ctlSockets) {
          if (!cli.data.subscriptions.has(id)) continue
          if (!cli.data.pendingEvals.has(msg.opId)) continue
          sendToCli(cli, {
            v: PROTOCOL_VERSION,
            type: 'evalResult',
            sessionId: id,
            opId: msg.opId,
            stdout: msg.stdout,
            stderr: msg.stderr,
            exitCode: msg.exitCode
          })
          cli.data.pendingEvals.delete(msg.opId)
        }
        return
      }
      case 'pair-request': {
        const id = ws.data.sessionId
        if (!id) return
        const ttl = msg.ttlMs ?? PAIR_DEFAULT_TTL_MS
        pendingPairs.set(msg.code, {
          code: msg.code,
          sessionId: id,
          expiresAt: Date.now() + ttl
        })
        log('pair-request', msg.code, '→', id)
        return
      }
      case 'pong':
        return
    }
  }

  function handleCtlMessage(
    ws: ServerWebSocket<CtlWsData>,
    msg: CliToDaemon
  ): void {
    if (!ctlSockets.has(ws)) ctlSockets.add(ws)

    switch (msg.type) {
      case 'list': {
        const list = [...sessions.values()].map((s) => ({
          id: s.id,
          title: s.title,
          openedAt: s.openedAt
        }))
        sendToCli(ws, { v: PROTOCOL_VERSION, type: 'sessions', sessions: list })
        return
      }
      case 'subscribe': {
        if (!sessions.has(msg.sessionId)) {
          sendToCli(ws, {
            v: PROTOCOL_VERSION,
            type: 'error',
            message: `unknown session: ${msg.sessionId}`
          })
          return
        }
        ws.data.subscriptions.add(msg.sessionId)
        return
      }
      case 'send': {
        const session = sessions.get(msg.sessionId)
        if (!session) {
          sendToCli(ws, {
            v: PROTOCOL_VERSION,
            type: 'error',
            message: `unknown session: ${msg.sessionId}`
          })
          return
        }
        sendToSpa(session.spa, {
          v: PROTOCOL_VERSION,
          type: 'send',
          text: msg.text,
          source: 'remote'
        })
        return
      }
      case 'eval': {
        const session = sessions.get(msg.sessionId)
        if (!session) {
          sendToCli(ws, {
            v: PROTOCOL_VERSION,
            type: 'error',
            message: `unknown session: ${msg.sessionId}`,
            opId: msg.opId
          })
          return
        }
        ws.data.pendingEvals.add(msg.opId)
        ws.data.subscriptions.add(msg.sessionId)
        sendToSpa(session.spa, {
          v: PROTOCOL_VERSION,
          type: 'eval',
          opId: msg.opId,
          script: msg.script
        })
        return
      }
      case 'abort': {
        const session = sessions.get(msg.sessionId)
        if (!session) return
        sendToSpa(session.spa, { v: PROTOCOL_VERSION, type: 'abort' })
        return
      }
    }
  }

  console.error(
    `comfy-ai bridge listening on http://${server.hostname}:${server.port}`
  )
  console.error(`  SPA endpoint   : ws://${server.hostname}:${server.port}/spa`)
  console.error(`  CLI endpoint   : ws://${server.hostname}:${server.port}/ctl`)
  console.error(
    `  Pair endpoint  : http://${server.hostname}:${server.port}/pair/<code>`
  )
  console.error('Press Ctrl+C to stop.')

  await new Promise(() => {})
}
