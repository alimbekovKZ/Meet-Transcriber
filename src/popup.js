// Popup UI controller

// DOM elements
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const disableBtn = document.getElementById("disableBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusIndicator = document.getElementById("statusIndicator");
const meetingInfo = document.getElementById("meetingInfo");

// Transcription elements
const transcriptionSection = document.getElementById("transcriptionSection");
const noTranscription = document.getElementById("noTranscription");
const hasTranscription = document.getElementById("hasTranscription");
const transcriptionFilename = document.getElementById("transcriptionFilename");
const transcriptionTime = document.getElementById("transcriptionTime");
const downloadBtn = document.getElementById("downloadBtn");
const openFolderBtn = document.getElementById("openFolderBtn");

// Show text preview
function setupPreviewFunctionality() {
    // Get elements
    const previewSection = document.getElementById('previewSection');
    const togglePreviewBtn = document.getElementById('togglePreviewBtn');
    const previewContent = document.getElementById('previewContent');
    const previewText = document.getElementById('previewText');
    
    // Check if transcription exists
    chrome.storage.local.get(['transcription'], (result) => {
        if (result.transcription && result.transcription.text) {
            // Show preview section
            previewSection.style.display = 'block';
            
            // Add toggle functionality
            togglePreviewBtn.addEventListener('click', () => {
                if (previewContent.style.display === 'none') {
                    // Show preview and populate text
                    previewContent.style.display = 'block';
                    previewText.textContent = result.transcription.text.substring(0, 500) + 
                                             (result.transcription.text.length > 500 ? '...' : '');
                    togglePreviewBtn.textContent = 'Скрыть текст';
                } else {
                    // Hide preview
                    previewContent.style.display = 'none';
                    togglePreviewBtn.textContent = 'Показать текст';
                }
            });
        } else {
            // No transcription, hide preview section
            previewSection.style.display = 'none';
        }
    });
}

// Show notification in popup
function showNotification(message, duration = 3000) {
    // Remove any existing notification
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        document.body.removeChild(existingNotification);
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    
    // Add to document
    document.body.appendChild(notification);
    
    // Show notification after a small delay (for animation)
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    // Hide and remove after duration
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 300); // wait for fade-out animation
    }, duration);
}

// Manual file download
function manualDownload() {
    chrome.storage.local.get(['transcription'], (result) => {
        if (!result.transcription || !result.transcription.text) {
            showNotification('Нет сохраненной транскрипции');
            return;
        }
        
        try {
            // Create blob and download link
            const blob = new Blob([result.transcription.text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            
            // Create download link
            const a = document.createElement('a');
            a.href = url;
            a.download = result.transcription.filename;
            a.style.display = 'none';
            
            // Add to document, click, and remove
            document.body.appendChild(a);
            a.click();
            
            // Clean up
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showNotification('Скачивание начато');
            }, 100);
        } catch (error) {
            console.error('Ошибка скачивания:', error);
            showNotification('Ошибка скачивания: ' + error.message);
        }
    });
}

// Initialize popup UI
document.addEventListener("DOMContentLoaded", async () => {
    console.log("📱 Popup UI initialized");
    addCopyTextButton();
    
    // Check if we're on a Google Meet page
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const isGoogleMeet = tabs[0]?.url?.includes("meet.google.com") || false;
    
    // Update UI based on current tab
    updateUIState(isGoogleMeet);

    setupPreviewFunctionality();
    
    // Add an alternative download method
    const downloadBtn = document.getElementById('downloadBtn');
    downloadBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        manualDownload();
        return false;
    });
    
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
    
    // Check for saved transcription
    loadTranscriptionInfo();
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

// Download transcription - improved version
downloadBtn.addEventListener("click", () => {
    chrome.storage.local.get(['transcription'], (result) => {
        if (!result.transcription || !result.transcription.text) {
            alert("Нет сохраненной транскрипции");
            return;
        }
        
        const { text, filename } = result.transcription;
        
        // First try: Use the direct download method through background script
        chrome.runtime.sendMessage({ 
            type: "downloadTranscriptionAsFile",
            text: text,
            filename: filename,
            saveAs: true  // Show save dialog
        }, (response) => {
            if (response && response.success) {
                console.log("✅ Скачивание началось");
            } else {
                console.error("❌ Ошибка прямого скачивания:", response?.error);
                
                // Second try: Use the redownload method
                chrome.runtime.sendMessage({ 
                    type: "redownloadTranscription" 
                }, (fallbackResponse) => {
                    if (!fallbackResponse || !fallbackResponse.success) {
                        console.error("❌ Все попытки скачивания не удались");
                        
                        // Last resort: Create download in popup context
                        try {
                            const blob = new Blob([text], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            
                            // Create invisible download link
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = filename;
                            a.style.display = 'none';
                            document.body.appendChild(a);
                            
                            // Trigger download
                            a.click();
                            
                            // Clean up
                            setTimeout(() => {
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                            }, 100);
                            
                            console.log("✅ Скачивание через popup успешно");
                        } catch (error) {
                            console.error("❌ Все методы скачивания не удались:", error);
                            alert("Не удалось скачать файл. Пожалуйста, попробуйте позже или обратитесь к разработчику.");
                        }
                    }
                });
            }
        });
    });
});

// Create a helper function to add a "Copy Text" button
function addCopyTextButton() {
    // Create a button in the UI
    const copyBtn = document.createElement('button');
    copyBtn.id = 'copyTextBtn';
    copyBtn.className = 'btn secondary';
    copyBtn.textContent = 'Скопировать текст';
    
    // Insert after download button
    downloadBtn.parentNode.insertBefore(copyBtn, downloadBtn.nextSibling);
    
    // Add click handler
    copyBtn.addEventListener('click', () => {
        chrome.storage.local.get(['transcription'], (result) => {
            if (!result.transcription || !result.transcription.text) {
                alert("Нет сохраненной транскрипции");
                return;
            }
            
            // Copy to clipboard
            navigator.clipboard.writeText(result.transcription.text)
                .then(() => {
                    // Change button text temporarily to indicate success
                    copyBtn.textContent = '✓ Скопировано!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Скопировать текст';
                    }, 2000);
                })
                .catch(err => {
                    console.error('Ошибка при копировании текста:', err);
                    alert('Не удалось скопировать текст');
                });
        });
    });
}

// Open downloads folder
openFolderBtn.addEventListener("click", () => {
    chrome.downloads.showDefaultFolder();
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

// Format date for display
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Load and display transcription info
function loadTranscriptionInfo() {
    chrome.storage.local.get(['transcription'], (result) => {
        if (result.transcription) {
            // Show transcription info
            noTranscription.style.display = 'none';
            hasTranscription.style.display = 'block';
            
            // Update info
            transcriptionFilename.textContent = result.transcription.filename;
            transcriptionTime.textContent = formatDate(result.transcription.timestamp);
            
            // Enable download buttons
            downloadBtn.disabled = false;
            openFolderBtn.disabled = false;
            
            downloadBtn.classList.remove('disabled');
            openFolderBtn.classList.remove('disabled');
        } else {
            // No transcription available
            noTranscription.style.display = 'block';
            hasTranscription.style.display = 'none';
            
            // Disable download buttons
            downloadBtn.disabled = true;
            openFolderBtn.disabled = true;
            
            downloadBtn.classList.add('disabled');
            openFolderBtn.classList.add('disabled');
        }
    });
}