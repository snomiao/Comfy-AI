export async function serveTerminal({
  port,
  host,
  shell,
}: {
  port: number;
  host: string;
  shell: string;
}) {
  console.log(`Starting WebSocket PTY server on ws://${host}:${port}/ws`);
  console.log(`Shell: ${shell}`);

  const server = Bun.serve({
    port,
    hostname: host,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (!upgraded) return new Response("WebSocket upgrade failed", { status: 400 });
        return undefined;
      }
      return new Response("Comfy AI Terminal Server — connect via ws://" + host + ":" + port + "/ws");
    },
    websocket: {
      open(ws) {
        const proc = Bun.spawn([shell], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, TERM: "xterm-256color" },
        });

        (ws as typeof ws & { proc: typeof proc }).proc = proc;

        // Forward pty stdout → ws
        const pipe = async (stream: ReadableStream) => {
          for await (const chunk of stream) {
            try { ws.send(chunk); } catch { break; }
          }
        };
        pipe(proc.stdout);
        pipe(proc.stderr);

        proc.exited.then(() => {
          try { ws.close(); } catch { /* ok */ }
        });
      },
      message(ws, data) {
        const p = (ws as typeof ws & { proc: ReturnType<typeof Bun.spawn> }).proc;
        if (!p) return;
        const buf = typeof data === "string" ? Buffer.from(data) : data;
        p.stdin.write(buf);
      },
      close(ws) {
        const p = (ws as typeof ws & { proc: ReturnType<typeof Bun.spawn> }).proc;
        p?.kill();
      },
    },
  });

  console.log(`Listening on ws://${server.hostname}:${server.port}/ws`);
  console.log("Press Ctrl+C to stop");

  // Keep alive
  await new Promise(() => {});
}
