/**
 * Test helper: connects to the daemon as if it were a browser SPA.
 * Replies to `eval` requests by echoing the script as stdout, and
 * accepts `send` messages by emitting an "event" back so a `tail` shows
 * activity. Useful for local development without the real frontend.
 */
import { PROTOCOL_VERSION } from './protocol'

const DAEMON_URL = process.env.COMFY_AI_DAEMON ?? 'ws://127.0.0.1:7437'
const SESSION_ID = process.env.COMFY_AI_SESSION ?? crypto.randomUUID()
const TITLE = process.env.COMFY_AI_TITLE ?? 'mock-spa'
const PAIR_CODE = process.env.COMFY_AI_PAIR_CODE

const ws = new WebSocket(`${DAEMON_URL}/spa`)
ws.addEventListener('open', () => {
  console.error(`[mock-spa] connected; sessionId=${SESSION_ID}`)
  ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'hello',
      sessionId: SESSION_ID,
      title: TITLE
    })
  )
  if (PAIR_CODE) {
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'pair-request',
        code: PAIR_CODE
      })
    )
    console.error(`[mock-spa] registered pair code: ${PAIR_CODE}`)
  }
})
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data as string) as {
    v: number
    type: string
    [key: string]: unknown
  }
  if (msg.v !== PROTOCOL_VERSION) return
  console.error(`[mock-spa] <- ${msg.type}`)
  if (msg.type === 'send') {
    // Echo the user message back as an event the daemon can fan out.
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'event',
        payload: {
          kind: 'message',
          role: 'user',
          text: String(msg.text ?? '')
        }
      })
    )
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'event',
        payload: {
          kind: 'message',
          role: 'assistant',
          text: `(mock-spa received: ${String(msg.text ?? '')})`
        }
      })
    )
  } else if (msg.type === 'eval') {
    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'evalResult',
        opId: String(msg.opId),
        stdout: `(mock-spa eval) ${String(msg.script ?? '')}\n`,
        stderr: '',
        exitCode: 0
      })
    )
  } else if (msg.type === 'paired') {
    console.error(`[mock-spa] pairing code claimed: ${String(msg.code)}`)
  }
})
ws.addEventListener('close', () => {
  console.error('[mock-spa] disconnected')
  process.exit(0)
})
await new Promise(() => {})
