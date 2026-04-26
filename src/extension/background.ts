chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "toggle-terminal" });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-terminal" && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-terminal" });
  }
});
