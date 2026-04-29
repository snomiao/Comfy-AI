/**
 * Per-user CLI state lives at `~/.config/comfy-ai/state.json`. Tracks the
 * default session + token written by `comfy-ai pair`, so subsequent
 * commands don't need an explicit --session flag.
 */
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export interface CliState {
  /** sessionId of the currently-paired SPA tab. */
  sessionId?: string
  /** Token returned by the daemon during pairing. */
  token?: string
  /** Daemon URL the pairing succeeded against. */
  daemonUrl?: string
  /** Human-friendly title of the paired session for `comfy-ai list` output. */
  title?: string
  /** Unix-ms timestamp of pairing. */
  pairedAt?: number
}

function statePath(): string {
  const dir =
    process.env.COMFY_AI_CONFIG_DIR ?? join(homedir(), '.config', 'comfy-ai')
  return join(dir, 'state.json')
}

export async function readState(): Promise<CliState> {
  const path = statePath()
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return {}
    return (await file.json()) as CliState
  } catch {
    return {}
  }
}

export async function writeState(state: CliState): Promise<void> {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(state, null, 2) + '\n')
}

export async function clearState(): Promise<void> {
  await writeState({})
}
