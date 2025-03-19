document.getElementById("startBtn").addEventListener("click", () => {
    console.log("▶ Старт записи!");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "startRecording" });
    });
});

document.getElementById("stopBtn").addEventListener("click", () => {
    console.log("⏹ Остановка записи!");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "stopRecording" });
    });
});
