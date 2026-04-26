import { TerminalPanel } from "../ui/terminal-panel";

const panel = new TerminalPanel();

// Toggle via keyboard shortcut message from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "toggle-terminal") panel.toggle();
});

// Also allow Ctrl+` as local keybind fallback
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    panel.toggle();
  }
});
