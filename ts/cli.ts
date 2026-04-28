#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

yargs(hideBin(process.argv))
  .scriptName("comfy-ai")
  .usage("$0 <command> [options]")
  .command(
    "serve [port]",
    "Start WebSocket PTY server for the xterm.js panel",
    (y) =>
      y
        .positional("port", {
          type: "number",
          default: 7681,
          describe: "Port to listen on",
        })
        .option("shell", {
          type: "string",
          default: process.env.SHELL ?? "/bin/bash",
          describe: "Shell to spawn",
        })
        .option("host", {
          type: "string",
          default: "localhost",
          describe: "Host to bind",
        }),
    async (argv) => {
      const { serveTerminal } = await import("./serve");
      await serveTerminal({ port: argv.port, host: argv.host, shell: argv.shell });
    }
  )
  .demandCommand(1, "Specify a command")
  .strict()
  .help()
  .version()
  .showHelpOnFail(true)
  .parse();
