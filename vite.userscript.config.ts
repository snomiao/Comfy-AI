import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/userscript/index.ts",
      userscript: {
        name: "Comfy AI Terminal",
        namespace: "https://comfy.org",
        version: "0.1.0",
        description: "Floating xterm.js terminal dialog on any page",
        author: "snomiao",
        match: ["*://*/*"],
        grant: ["GM_getValue", "GM_setValue"],
        "run-at": "document-idle",
      },
      build: {
        externalGlobals: {
          "@xterm/xterm": ["Xterm", (version) => `https://cdn.jsdelivr.net/npm/@xterm/xterm@${version}/lib/xterm.js`],
          "@xterm/addon-fit": ["XtermAddonFit", (version) => `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${version}/lib/addon-fit.js`],
          "@xterm/addon-attach": ["XtermAddonAttach", (version) => `https://cdn.jsdelivr.net/npm/@xterm/addon-attach@${version}/lib/addon-attach.js`],
        },
      },
    }),
  ],
  build: {
    outDir: "dist/userscript",
    emptyOutDir: true,
  },
});
