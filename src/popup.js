// Popup UI controller

// DOM elements
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const disableBtn = document.getElementById("disableBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusIndicator = document.getElementById("statusIndicator");
const meetingInfo = document.getElementById("meetingInfo");

// Initialize popup UI
document.addEventListener("DOMContentLoaded", async () => {
    console.log("📱 Popup UI initialized");
    
    // Check if we're on a Google Meet page
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const isGoogleMeet = tabs[0]?.url?.includes("meet.google.com") || false;
    
    // Update UI based on current tab
    updateUIState(isGoogleMeet);
    
    if (isGoogleMeet) {
        // Get current recording status from content script
        chrome.tabs.sendMessage(tabs[0].id, { action: "getRecordingStatus" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error communicating with content script:", chrome.runtime.lastError.message);
                updateMeetingInfo(false, false, "");
                return;
            }
            
            if (response) {
                updateRecordingStatus(response.isRecording);
                updateMeetingInfo(true, response.meetingDetected, response.meetingName);
            }
        });
    }
});

// Start recording button
startBtn.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs[0]?.url?.includes("meet.google.com")) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "startRecording" }, (response) => {
            if (response) {
                console.log(response.status);
                updateRecordingStatus(true);
            }
        });
    } else {
        alert("Пожалуйста, откройте Google Meet для записи звонка.");
    }
});

// Stop recording button
stopBtn.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs[0]?.url?.includes("meet.google.com")) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "stopRecording" }, (response) => {
            if (response) {
                console.log(response.status);
                updateRecordingStatus(false);
            }
        });
    }
});

// Disable auto-transcription for current meeting
disableBtn.addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs[0]?.url?.includes("meet.google.com")) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "disableAutoTranscription" }, (response) => {
            if (response) {
                console.log(response.status);
                updateRecordingStatus(false);
                
                // Update button to show it's disabled
                disableBtn.textContent = "Запись отключена для этой встречи";
                disableBtn.disabled = true;
                disableBtn.classList.add("disabled");
            }
        });
    }
});

// Open settings page
settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

// Update UI based on whether we're on Google Meet
function updateUIState(isGoogleMeet) {
    if (!isGoogleMeet) {
        // Not on Google Meet
        startBtn.disabled = true;
        stopBtn.disabled = true;
        disableBtn.disabled = true;
        
        startBtn.classList.add("disabled");
        stopBtn.classList.add("disabled");
        disableBtn.classList.add("disabled");
        
        statusIndicator.classList.add("inactive");
        statusIndicator.setAttribute("title", "Не на странице Google Meet");
        
        meetingInfo.innerHTML = "<p>Откройте Google Meet для использования плагина</p>";
    }
}

// Update recording status indicator
function updateRecordingStatus(isRecording) {
    if (isRecording) {
        statusIndicator.classList.remove("inactive");
        statusIndicator.classList.add("active");
        statusIndicator.setAttribute("title", "Запись активна");
        
        startBtn.disabled = true;
        stopBtn.disabled = false;
        
        startBtn.classList.add("disabled");
        stopBtn.classList.remove("disabled");
    } else {
        statusIndicator.classList.remove("active");
        statusIndicator.classList.add("inactive");
        statusIndicator.setAttribute("title", "Запись не активна");
        
        startBtn.disabled = false;
        stopBtn.disabled = true;
        
        startBtn.classList.remove("disabled");
        stopBtn.classList.add("disabled");
    }
}

// Update meeting info section
function updateMeetingInfo(isGoogleMeet, meetingDetected, meetingName) {
    if (!isGoogleMeet) {
        meetingInfo.innerHTML = "<p>Откройте Google Meet для использования плагина</p>";
        return;
    }
    
    if (meetingDetected) {
        meetingInfo.innerHTML = `<p>Текущая встреча: <strong>${meetingName}</strong></p>`;
    } else {
        meetingInfo.innerHTML = "<p>Звонок не обнаружен. Подождите начала звонка или обновите страницу.</p>";
    }
}