#!/usr/bin/env bun
/**
 * comfy-ai — bridge between local agents and the in-browser ComfyAI SPA.
 *
 * Subcommands:
 *   serve              start the bridge daemon
 *   pair <url>         claim a pairing code shown in the SPA modal
 *   list               list active SPA tabs
 *   tail [id]          stream session events (read-only)
 *   attach [id]        bidirectional REPL — stdin → SPA, events → stdout
 *   send <text> [-s]   one-shot user message
 *   eval <script>      one-shot shell exec in the SPA, prints stdout/stderr
 *   kill [id]          abort the current stream / close session
 *   logout             clear locally stored pairing state
 */
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { clearState, readState, writeState } from './config'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  type CliToDaemon,
  type DaemonToCli,
  type PairResponse,
  type SessionId,
  type SpaEventPayload
} from './protocol'
import { serve } from './serve'

const DEFAULT_DAEMON = (() => {
  const env = process.env.COMFY_AI_DAEMON
  if (!env) return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  return env.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
})()

function deriveWsUrl(httpUrl: string, token?: string): string {
  const u = new URL(httpUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ctl'
  if (token) u.searchParams.set('token', token)
  return u.toString()
}

async function resolveSession(
  override: string | undefined
): Promise<{ daemonUrl: string; sessionId: SessionId; token?: string }> {
  if (override) {
    const state = await readState()
    return {
      daemonUrl: state.daemonUrl ?? DEFAULT_DAEMON,
      sessionId: override,
      token: state.token
    }
  }
  const state = await readState()
  if (!state.sessionId) {
    throw new Error(
      'no paired session — run `comfy-ai pair <url>` first, or pass --session <id>.'
    )
  }
  return {
    daemonUrl: state.daemonUrl ?? DEFAULT_DAEMON,
    sessionId: state.sessionId,
    token: state.token
  }
}

function openCtl(daemonUrl: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(deriveWsUrl(daemonUrl, token))
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener(
      'error',
      () =>
        reject(
          new Error(
            `cannot reach daemon at ${daemonUrl} — is \`comfy-ai serve\` running?`
          )
        ),
      { once: true }
    )
  })
}

function send(ws: WebSocket, msg: CliToDaemon): void {
  ws.send(JSON.stringify(msg))
}

function parseDaemonMsg(raw: string): DaemonToCli | null {
  try {
    const parsed = JSON.parse(raw) as DaemonToCli
    if (parsed.v !== PROTOCOL_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function formatEvent(payload: SpaEventPayload): string {
  switch (payload.kind) {
    case 'message':
      return `[${payload.role}] ${payload.text}`
    case 'delta':
      return payload.text
    case 'tool': {
      const head = `$ ${payload.script}`
      const body = [payload.stdout, payload.stderr ? `[stderr] ${payload.stderr}` : '']
        .filter(Boolean)
        .join('\n')
      const tail = `(exit ${payload.exitCode})`
      return [head, body, tail].filter(Boolean).join('\n')
    }
    case 'state':
      return payload.isStreaming ? '(streaming…)' : '(idle)'
    case 'clear':
      return '--- session cleared ---'
  }
}

// ---------------- subcommands ----------------

async function cmdPair(url: string): Promise<void> {
  const target = url.trim()
  if (!target.startsWith('http')) {
    throw new Error(`expected an http(s) URL, got: ${target}`)
  }
  const res = await fetch(target, { method: 'GET' })
  const body = (await res.json()) as PairResponse | { ok: false; error: string }
  if (!res.ok || !body.ok) {
    const reason = 'error' in body ? body.error : `HTTP ${res.status}`
    throw new Error(`pairing failed: ${reason}`)
  }
  const u = new URL(target)
  u.pathname = ''
  u.search = ''
  await writeState({
    sessionId: body.sessionId,
    token: body.token,
    daemonUrl: u.toString().replace(/\/$/, ''),
    title: body.title,
    pairedAt: Date.now()
  })
  console.log(`Paired with session "${body.title ?? body.sessionId}".`)
  console.log(`Try: comfy-ai send "hello"`)
}

async function cmdList(daemonUrlArg: string): Promise<void> {
  const state = await readState()
  const daemonUrl =
    daemonUrlArg !== DEFAULT_DAEMON ? daemonUrlArg : (state.daemonUrl ?? daemonUrlArg)
  const ws = await openCtl(daemonUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const msg = parseDaemonMsg(ev.data as string)
      if (msg?.type === 'sessions') {
        if (msg.sessions.length === 0) {
          console.log('(no SPA tabs connected)')
        } else {
          for (const s of msg.sessions) {
            const age = ((Date.now() - s.openedAt) / 1000).toFixed(0)
            console.log(`${s.id}  ${s.title ?? '(untitled)'}  +${age}s`)
          }
        }
        ws.close()
        resolve()
      }
    })
    ws.addEventListener('error', () => reject(new Error('list failed')))
    send(ws, { v: PROTOCOL_VERSION, type: 'list' })
  })
}

async function cmdTail(sessionOverride?: string): Promise<void> {
  const { daemonUrl, sessionId, token } =
    await resolveSession(sessionOverride)
  const ws = await openCtl(daemonUrl, token)
  send(ws, { v: PROTOCOL_VERSION, type: 'subscribe', sessionId })
  console.error(`tailing ${sessionId} — Ctrl+C to exit`)
  ws.addEventListener('message', (ev) => {
    const msg = parseDaemonMsg(ev.data as string)
    if (msg?.type === 'event') process.stdout.write(formatEvent(msg.payload) + '\n')
    if (msg?.type === 'error') console.error(`error: ${msg.message}`)
  })
  await new Promise<void>(() => {})
}

async function cmdAttach(sessionOverride?: string): Promise<void> {
  const { daemonUrl, sessionId, token } =
    await resolveSession(sessionOverride)
  const ws = await openCtl(daemonUrl, token)
  send(ws, { v: PROTOCOL_VERSION, type: 'subscribe', sessionId })
  console.error(`attached to ${sessionId} — type to send, Ctrl+D to detach`)
  ws.addEventListener('message', (ev) => {
    const msg = parseDaemonMsg(ev.data as string)
    if (msg?.type === 'event') process.stdout.write(formatEvent(msg.payload) + '\n')
    if (msg?.type === 'error') console.error(`error: ${msg.message}`)
  })
  // Forward stdin lines as user messages.
  for await (const line of console) {
    const text = String(line).trim()
    if (!text) continue
    send(ws, { v: PROTOCOL_VERSION, type: 'send', sessionId, text })
  }
  ws.close()
}

async function cmdSend(text: string, sessionOverride?: string): Promise<void> {
  const { daemonUrl, sessionId, token } =
    await resolveSession(sessionOverride)
  const ws = await openCtl(daemonUrl, token)
  send(ws, { v: PROTOCOL_VERSION, type: 'send', sessionId, text })
  // Give the daemon a tick to relay before we close.
  await new Promise((r) => setTimeout(r, 50))
  ws.close()
}

async function cmdEval(
  script: string,
  sessionOverride?: string
): Promise<number> {
  const { daemonUrl, sessionId, token } =
    await resolveSession(sessionOverride)
  const ws = await openCtl(daemonUrl, token)
  const opId = crypto.randomUUID()
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('eval timed out (60s)'))
    }, 60_000)
    ws.addEventListener('message', (ev) => {
      const msg = parseDaemonMsg(ev.data as string)
      if (msg?.type === 'evalResult' && msg.opId === opId) {
        clearTimeout(timer)
        if (msg.stdout) process.stdout.write(msg.stdout)
        if (msg.stderr) process.stderr.write(msg.stderr)
        ws.close()
        resolve(msg.exitCode ?? 0)
      }
      if (msg?.type === 'error' && msg.opId === opId) {
        clearTimeout(timer)
        ws.close()
        reject(new Error(msg.message))
      }
    })
    send(ws, {
      v: PROTOCOL_VERSION,
      type: 'eval',
      sessionId,
      opId,
      script
    })
  })
}

async function cmdKill(sessionOverride?: string): Promise<void> {
  const { daemonUrl, sessionId, token } =
    await resolveSession(sessionOverride)
  const ws = await openCtl(daemonUrl, token)
  send(ws, { v: PROTOCOL_VERSION, type: 'abort', sessionId })
  await new Promise((r) => setTimeout(r, 50))
  ws.close()
  console.error(`abort sent to ${sessionId}`)
}

async function cmdLogout(): Promise<void> {
  await clearState()
  console.log('cleared local pairing state.')
}

// ---------------- argv ----------------

await yargs(hideBin(process.argv))
  .scriptName('comfy-ai')
  .usage('$0 <command> [options]')
  .command(
    'serve',
    'Start the bridge daemon',
    (y) =>
      y
        .option('port', { type: 'number', default: DEFAULT_PORT })
        .option('host', { type: 'string', default: DEFAULT_HOST })
        .option('verbose', { type: 'boolean', default: false }),
    async (argv) => {
      await serve({
        port: argv.port,
        host: argv.host,
        verbose: argv.verbose
      })
    }
  )
  .command(
    'pair <url>',
    'Claim a pairing code from the SPA modal',
    (y) =>
      y.positional('url', {
        type: 'string',
        demandOption: true,
        describe: 'http://localhost:7437/pair/<code> URL shown in the SPA'
      }),
    async (argv) => cmdPair(argv.url as string)
  )
  .command(
    'list',
    'List active SPA tabs',
    (y) =>
      y.option('daemon', { type: 'string', default: DEFAULT_DAEMON }),
    async (argv) => cmdList(argv.daemon)
  )
  .command(
    'tail [session]',
    'Stream session events (read-only)',
    (y) => y.positional('session', { type: 'string' }),
    async (argv) => cmdTail(argv.session)
  )
  .command(
    'attach [session]',
    'Bidirectional REPL — stdin → SPA, events → stdout',
    (y) => y.positional('session', { type: 'string' }),
    async (argv) => cmdAttach(argv.session)
  )
  .command(
    'send <text>',
    'Send a one-shot user message',
    (y) =>
      y
        .positional('text', { type: 'string', demandOption: true })
        .option('session', { alias: 's', type: 'string' }),
    async (argv) => cmdSend(argv.text as string, argv.session)
  )
  .command(
    'eval <script>',
    'Run a one-shot shell command in the SPA runtime',
    (y) =>
      y
        .positional('script', { type: 'string', demandOption: true })
        .option('session', { alias: 's', type: 'string' }),
    async (argv) => {
      const code = await cmdEval(argv.script as string, argv.session)
      process.exit(code)
    }
  )
  .command(
    'kill [session]',
    'Abort the current stream',
    (y) => y.positional('session', { type: 'string' }),
    async (argv) => cmdKill(argv.session)
  )
  .command('logout', 'Clear local pairing state', () => {}, async () =>
    cmdLogout()
  )
  .demandCommand(1, 'Specify a command')
  .strict()
  .help()
  .version()
  .fail((msg, err) => {
    if (err) {
      console.error('error:', err.message)
    } else {
      console.error(msg)
    }
    process.exit(1)
  })
  .parseAsync()
