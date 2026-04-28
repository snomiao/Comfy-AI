import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AttachAddon } from "@xterm/addon-attach";
import "@xterm/xterm/css/xterm.css";

const PANEL_ID = "comfy-ai-terminal-panel";
const WS_URL_KEY = "comfy-ai-ws-url";
const DEFAULT_WS_URL = "ws://localhost:7681/ws";

const PANEL_CSS = `
  #${PANEL_ID}-host {
    position: fixed;
    z-index: 2147483647;
    bottom: 24px;
    right: 24px;
    width: 720px;
    height: 420px;
    min-width: 320px;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    border-radius: 8px;
    overflow: hidden;
    resize: both;
    font-family: monospace;
  }
  .titlebar {
    background: #1e1e2e;
    color: #cdd6f4;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: move;
    user-select: none;
    flex-shrink: 0;
    font-size: 13px;
    font-family: sans-serif;
  }
  .titlebar-title { font-weight: 600; letter-spacing: 0.03em; }
  .titlebar-actions { display: flex; gap: 6px; }
  .btn {
    background: none;
    border: none;
    color: #cdd6f4;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
  }
  .btn:hover { background: #45475a; }
  .terminal-wrap {
    flex: 1;
    background: #1e1e2e;
    padding: 4px;
    overflow: hidden;
  }
  .terminal-wrap .xterm { height: 100%; }
  .terminal-wrap .xterm-viewport { overflow-y: auto !important; }
  .ws-bar {
    background: #181825;
    display: flex;
    align-items: center;
    padding: 4px 8px;
    gap: 6px;
    flex-shrink: 0;
  }
  .ws-bar input {
    flex: 1;
    background: #313244;
    border: 1px solid #45475a;
    color: #cdd6f4;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
  }
  .ws-bar button {
    background: #89b4fa;
    color: #1e1e2e;
    border: none;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }
  .ws-bar button:hover { background: #74c7ec; }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-connected { background: #a6e3a1; }
  .dot-disconnected { background: #f38ba8; }
  .dot-connecting { background: #f9e2af; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
`;

export class TerminalPanel {
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ws: WebSocket | null = null;
  private visible = false;
  private dragOffset = { x: 0, y: 0 };
  private isDragging = false;

  mount() {
    if (document.getElementById(PANEL_ID + "-host")) return;

    this.host = document.createElement("div");
    this.host.id = PANEL_ID + "-host";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="titlebar" id="titlebar">
        <span class="titlebar-title">⚡ Comfy AI Terminal</span>
        <div class="titlebar-actions">
          <button class="btn" id="btn-minimize" title="Minimize">_</button>
          <button class="btn" id="btn-close" title="Close">✕</button>
        </div>
      </div>
      <div class="ws-bar" id="ws-bar">
        <div class="status-dot dot-disconnected" id="status-dot"></div>
        <input id="ws-url" type="text" value="${this.getSavedUrl()}" placeholder="${DEFAULT_WS_URL}" />
        <button id="btn-connect">Connect</button>
      </div>
      <div class="terminal-wrap" id="terminal-wrap"></div>
    `;
    this.shadow.appendChild(panel);
    document.documentElement.appendChild(this.host);

    this.initTerminal();
    this.bindEvents();
    this.show();
  }

  private getSavedUrl(): string {
    try {
      return localStorage.getItem(WS_URL_KEY) ?? DEFAULT_WS_URL;
    } catch {
      return DEFAULT_WS_URL;
    }
  }

  private initTerminal() {
    this.term = new Terminal({
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5c2e7",
        selectionBackground: "#45475a",
      },
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      cursorBlink: true,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    const wrap = this.shadow!.getElementById("terminal-wrap")!;
    this.term.open(wrap);
    this.fitAddon.fit();

    this.term.writeln("\x1b[1;32mComfy AI Terminal\x1b[0m — enter WebSocket URL above and click Connect.");
  }

  private bindEvents() {
    const s = this.shadow!;

    s.getElementById("btn-close")!.addEventListener("click", () => this.hide());
    s.getElementById("btn-minimize")!.addEventListener("click", () => this.toggleMinimize());
    s.getElementById("btn-connect")!.addEventListener("click", () => this.connect());

    s.getElementById("ws-url")!.addEventListener("keydown", (e: Event) => {
      if ((e as KeyboardEvent).key === "Enter") this.connect();
    });

    // drag
    const titlebar = s.getElementById("titlebar")!;
    titlebar.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      this.isDragging = true;
      const rect = this.host!.getBoundingClientRect();
      this.dragOffset = { x: me.clientX - rect.left, y: me.clientY - rect.top };
    });
    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.isDragging) return;
      this.host!.style.left = e.clientX - this.dragOffset.x + "px";
      this.host!.style.top = e.clientY - this.dragOffset.y + "px";
      this.host!.style.bottom = "auto";
      this.host!.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { this.isDragging = false; });

    // resize observer to refit terminal
    new ResizeObserver(() => this.fitAddon?.fit()).observe(this.host!);
  }

  private connect() {
    const input = this.shadow!.getElementById("ws-url") as HTMLInputElement;
    const url = input.value.trim() || DEFAULT_WS_URL;
    try { localStorage.setItem(WS_URL_KEY, url); } catch { /* ok */ }

    this.setStatus("connecting");
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    this.ws = new WebSocket(url);
    const attach = new AttachAddon(this.ws);
    this.term!.loadAddon(attach);

    this.ws.onopen = () => this.setStatus("connected");
    this.ws.onclose = () => {
      this.setStatus("disconnected");
      this.term!.writeln("\r\n\x1b[1;31m[disconnected]\x1b[0m");
    };
    this.ws.onerror = () => {
      this.setStatus("disconnected");
      this.term!.writeln("\r\n\x1b[1;31m[connection error]\x1b[0m");
    };
  }

  private setStatus(state: "connected" | "disconnected" | "connecting") {
    const dot = this.shadow!.getElementById("status-dot");
    if (!dot) return;
    dot.className = `status-dot dot-${state}`;
  }

  private toggleMinimize() {
    const wrap = this.shadow!.getElementById("terminal-wrap") as HTMLElement;
    const wsBar = this.shadow!.getElementById("ws-bar") as HTMLElement;
    const hidden = wrap.style.display === "none";
    wrap.style.display = hidden ? "" : "none";
    wsBar.style.display = hidden ? "" : "none";
    this.host!.style.height = hidden ? "" : "auto";
  }

  show() {
    if (!this.host) this.mount();
    else this.host.style.display = "flex";
    this.visible = true;
    this.fitAddon?.fit();
  }

  hide() {
    if (this.host) this.host.style.display = "none";
    this.visible = false;
  }

  toggle() {
    this.visible ? this.hide() : this.show();
  }
}
