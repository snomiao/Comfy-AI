// ==UserScript==
// @name         Comfy AI Terminal
// @namespace    https://comfy.org
// @version      0.1.0
// @description  Floating xterm.js terminal dialog on any page
// @author       snomiao
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

import { TerminalPanel } from "../ui/terminal-panel";

const panel = new TerminalPanel();

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    panel.toggle();
  }
});
