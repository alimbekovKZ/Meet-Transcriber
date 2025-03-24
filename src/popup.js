// Popup UI controller for Google Meet Transcription Plugin

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

// Improved download button with multiple fallbacks and error recovery
downloadBtn.addEventListener("click", () => {
    downloadWithDiagnostics();
});

// Comprehensive download function with diagnostics
async function downloadWithDiagnostics() {
    // Show immediate feedback
    showNotification('Начинаем скачивание...');
    
    try {
        // First check what's in storage
        const transcription = await getTranscriptionFromStorage();
        
        if (!transcription || !transcription.text) {
            showNotification('Нет сохраненной транскрипции');
            return;
        }
        
        console.log(`📥 Retrieved transcription: ${transcription.text.length} chars, filename: ${transcription.filename}`);
        
        // Method 1: Use the background page API
        try {
            console.log("🔄 Trying background download method...");
            
            const response = await sendMessageToBackground({
                type: "downloadTranscriptionAsFile",
                text: transcription.text,
                filename: transcription.filename,
                saveAs: false // First try without save dialog for simplicity
            });
            
            if (response && response.success) {
                console.log("✅ Background download started:", response.result);
                return;
            } else if (response && response.inProgress) {
                console.log("🔄 Download in progress...");
                
                // Add listener for final result
                chrome.runtime.onMessage.addListener(function downloadListener(msg) {
                    if (msg.type === "downloadResult") {
                        // Remove the listener to avoid memory leaks
                        chrome.runtime.onMessage.removeListener(downloadListener);
                        
                        if (msg.success) {
                            console.log("✅ Download completed:", msg.result);
                            showNotification('Скачивание файла начато');
                        } else {
                            console.error("❌ Background download failed:", msg.error);
                            
                            // Continue to fallback methods
                            setTimeout(() => {
                                popupDownloadFallback(transcription.text, transcription.filename);
                            }, 500);
                        }
                    }
                });
                
                // Set a timeout to move to fallback if no response
                setTimeout(() => {
                    console.log("⏱️ Response timeout, trying fallback...");
                    popupDownloadFallback(transcription.text, transcription.filename);
                }, 5000);
                
                return;
            }
            
            console.error("❌ Background download failed, trying fallback...", response?.error || "Unknown error");
            throw new Error(response?.error || "Скачивание не удалось");
        } catch (error) {
            console.error("❌ Background method failed:", error);
            await popupDownloadFallback(transcription.text, transcription.filename);
        }
    } catch (error) {
        console.error("❌ Download error:", error);
        showNotification('Ошибка скачивания: ' + error.message, 5000);
        
        // Last resort - show diagnostic info button
        showDiagnosticButton();
    }
}

// Improved popup-based download with explicit encoding
async function popupDownloadFallback(text, filename) {
    console.log("🔄 Trying popup fallback methods...");
    
    // Method 2: Try redownload API
    try {
        console.log("🔄 Trying redownload API...");
        const response = await sendMessageToBackground({ type: "redownloadTranscription" });
        
        if (response && response.success) {
            console.log("✅ Redownload started:", response.result);
            showNotification('Скачивание файла начато');
            return;
        } 
        
        if (response && response.fallbackText) {
            // We got the text back, can try direct methods
            console.log("📄 Got fallback text, trying direct methods...");
            text = response.fallbackText;
            filename = response.fallbackFilename || filename;
        }
        
        console.warn("⚠️ Redownload failed, trying direct methods:", response?.error);
        throw new Error(response?.error || "Redownload failed");
    } catch (error) {
        console.error("❌ Redownload API failed:", error);
        
        // Method 3: Try UTF-8 encoded download
        try {
            console.log("🔄 Trying UTF-8 encoded download method...");
            await utf8EncodedDownload(text, filename);
            console.log("✅ UTF-8 encoded download worked");
            showNotification('Скачивание файла начато');
            return;
        } catch (encodedError) {
            console.error("❌ UTF-8 encoded method failed:", encodedError);
            
            // Method 4: Try direct text file download
            try {
                console.log("🔄 Trying direct text file method...");
                await directTextFileDownload(text, filename);
                console.log("✅ Direct text file download worked");
                showNotification('Скачивание файла начато');
                return;
            } catch (directError) {
                console.error("❌ Direct text file method failed:", directError);
                
                // Method 5: Offer copy to clipboard instead as last resort
                console.log("🔄 All download methods failed, offering copy...");
                showNotification('Скачивание не удалось. Попробуйте скопировать текст.', 5000);
                
                // Make copy button prominent
                highlightCopyButton();
                
                // Show diagnostic button
                showDiagnosticButton();
            }
        }
    }
}

// UTF-8 encoded download method
function utf8EncodedDownload(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            console.log("📝 Creating UTF-8 encoded download...");
            
            // Create TextEncoder for proper UTF-8 handling
            const encoder = new TextEncoder();
            const encodedData = encoder.encode(text);
            
            // Create blob with proper encoding
            const blob = new Blob([encodedData], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            // Create URL
            const url = URL.createObjectURL(blob);
            
            // Create link and click it
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            
            document.body.appendChild(a);
            a.click();
            
            // Clean up
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                resolve(true);
            }, 100);
        } catch (error) {
            reject(error);
        }
    });
}

// Direct text file download method with verification
function directTextFileDownload(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            console.log("📄 Creating direct text file download...");
            
            // Normalize line endings
            const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            
            // Create blob with BOM for UTF-8
            const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
            const textEncoder = new TextEncoder();
            const encodedText = textEncoder.encode(normalizedText);
            
            // Combine BOM and text
            const combinedArray = new Uint8Array(BOM.length + encodedText.length);
            combinedArray.set(BOM);
            combinedArray.set(encodedText, BOM.length);
            
            // Create blob from combined array
            const blob = new Blob([combinedArray], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            // Verify content
            const reader = new FileReader();
            reader.onload = function() {
                const content = reader.result;
                console.log(`✓ Verified text content (${content.length} chars)`);
                
                // Create URL
                const url = URL.createObjectURL(blob);
                
                // Create link and click it
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                
                document.body.appendChild(a);
                a.click();
                
                // Clean up
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    resolve(true);
                }, 100);
            };
            
            reader.onerror = function(e) {
                reject(new Error("Failed to verify text content: " + e));
            };
            
            // Start reading to verify
            reader.readAsText(blob);
        } catch (error) {
            reject(error);
        }
    });
}

// Get transcription data from storage
function getTranscriptionFromStorage() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['transcription'], (result) => {
            resolve(result.transcription);
        });
    });
}

// Send message to background with timeout
function sendMessageToBackground(message, timeout = 10000) {
    return new Promise((resolve, reject) => {
        // Set timeout for response
        const timeoutId = setTimeout(() => {
            reject(new Error("Timeout waiting for background response"));
        }, timeout);
        
        // Send message
        chrome.runtime.sendMessage(message, (response) => {
            // Clear timeout
            clearTimeout(timeoutId);
            
            // Check for error
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}

// Make the copy button more prominent when download fails
function highlightCopyButton() {
    const copyBtn = document.getElementById('copyTextBtn');
    if (copyBtn) {
        // Save original styling
        const originalClass = copyBtn.className;
        
        // Apply prominent styling
        copyBtn.className = 'btn primary';
        copyBtn.style.fontWeight = 'bold';
        copyBtn.innerHTML = '📋 Скопировать текст (рекомендуется)';
        
        // Add glow effect with CSS
        const style = document.createElement('style');
        style.textContent = `
            @keyframes glow {
                0% { box-shadow: 0 0 5px rgba(26, 115, 232, 0.5); }
                50% { box-shadow: 0 0 15px rgba(26, 115, 232, 0.8); }
                100% { box-shadow: 0 0 5px rgba(26, 115, 232, 0.5); }
            }
            .btn-highlight {
                animation: glow 2s infinite;
            }
        `;
        document.head.appendChild(style);
        
        copyBtn.classList.add('btn-highlight');
    }
}

// Show diagnostic button when all else fails
function showDiagnosticButton() {
    // Remove existing button if any
    const existingBtn = document.getElementById('diagnosticBtn');
    if (existingBtn) {
        existingBtn.remove();
    }
    
    // Create diagnostic button
    const diagnosticBtn = document.createElement('button');
    diagnosticBtn.id = 'diagnosticBtn';
    diagnosticBtn.className = 'btn secondary';
    diagnosticBtn.style.marginTop = '10px';
    diagnosticBtn.textContent = 'Показать диагностику';
    
    // Add to download actions
    const downloadActions = document.querySelector('.download-actions');
    if (downloadActions) {
        downloadActions.appendChild(diagnosticBtn);
    }
    
    // Add click handler
    diagnosticBtn.addEventListener('click', async () => {
        try {
            // Get diagnostic info
            const diagnostics = await sendMessageToBackground({ type: "getDiagnostics" });
            
            // Create diagnostic popup
            const diagInfo = document.createElement('div');
            diagInfo.className = 'diagnostic-info';
            diagInfo.style.position = 'fixed';
            diagInfo.style.top = '10%';
            diagInfo.style.left = '5%';
            diagInfo.style.width = '90%';
            diagInfo.style.maxHeight = '80%';
            diagInfo.style.backgroundColor = 'white';
            diagInfo.style.border = '1px solid #dadce0';
            diagInfo.style.borderRadius = '8px';
            diagInfo.style.padding = '16px';
            diagInfo.style.zIndex = '1000';
            diagInfo.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.1)';
            diagInfo.style.overflowY = 'auto';
            
            // Add diagnostic content
            diagInfo.innerHTML = `
                <h3 style="margin-top:0">Диагностика скачивания</h3>
                <p><strong>Разрешения:</strong> ${JSON.stringify(diagnostics.permissions)}</p>
                <p><strong>Последняя ошибка:</strong> ${diagnostics.lastError || 'Нет'}</p>
                <p><strong>Выполненные попытки:</strong> ${diagnostics.downloadDiagnostics.totalAttempts}</p>
                <p><strong>Методы:</strong> ${diagnostics.downloadDiagnostics.methods.join(', ')}</p>
                <p><strong>Ошибки:</strong></p>
                <ul style="margin-bottom:16px">
                    ${diagnostics.downloadDiagnostics.allErrors.map(err => `<li>${err}</li>`).join('')}
                </ul>
                <button id="closeDiagBtn" style="background:#1a73e8;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;">
                    Закрыть
                </button>
            `;
            
            // Add to page
            document.body.appendChild(diagInfo);
            
            // Add close button handler
            document.getElementById('closeDiagBtn').addEventListener('click', () => {
                diagInfo.remove();
            });
        } catch (error) {
            console.error("❌ Error getting diagnostics:", error);
            showNotification('Ошибка получения диагностики', 3000);
        }
    });
}

// Create a better "Copy Text" button with visual feedback
function addImprovedCopyButton() {
    // Remove existing button if it exists
    const existingBtn = document.getElementById('copyTextBtn');
    if (existingBtn) {
        existingBtn.remove();
    }
    
    // Create a new button with better styling
    const copyBtn = document.createElement('button');
    copyBtn.id = 'copyTextBtn';
    copyBtn.className = 'btn secondary';
    copyBtn.innerHTML = '<span class="btn-icon">📋</span> Скопировать текст';
    
    // Insert after download button
    if (downloadBtn && downloadBtn.parentNode) {
        downloadBtn.parentNode.insertBefore(copyBtn, downloadBtn.nextSibling);
    }
    
    // Add improved click handler with better error handling
    copyBtn.addEventListener('click', async () => {
        try {
            const result = await getTranscriptionFromStorage();
            
            if (!result || !result.text) {
                showNotification("Нет сохраненной транскрипции");
                return;
            }
            
            // Copy to clipboard with proper error handling
            try {
                await navigator.clipboard.writeText(result.text);
                
                // Show success state
                const originalHTML = copyBtn.innerHTML;
                copyBtn.innerHTML = '<span class="btn-icon">✓</span> Скопировано!';
                copyBtn.classList.add('success');
                
                // Reset after delay
                setTimeout(() => {
                    copyBtn.innerHTML = originalHTML;
                    copyBtn.classList.remove('success');
                }, 2000);
            } catch (clipboardError) {
                console.error("Clipboard error:", clipboardError);
                
                // Fallback method for older browsers
                const textarea = document.createElement('textarea');
                textarea.value = result.text;
                textarea.style.position = 'fixed';  // Prevent scrolling to bottom
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                
                try {
                    const successful = document.execCommand('copy');
                    if (!successful) throw new Error("execCommand failed");
                    
                    // Show success state
                    const originalHTML = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<span class="btn-icon">✓</span> Скопировано!';
                    
                    // Reset after delay
                    setTimeout(() => {
                        copyBtn.innerHTML = originalHTML;
                    }, 2000);
                } catch (e) {
                    showNotification("Не удалось скопировать текст");
                } finally {
                    document.body.removeChild(textarea);
                }
            }
        } catch (error) {
            console.error("Copy error:", error);
            showNotification("Ошибка при копировании");
        }
    });
    
    // Add hover styling
    const style = document.createElement('style');
    style.textContent = `
        .btn.success {
            background-color: #34a853 !important;
            color: white !important;
        }
        .btn-icon {
            margin-right: 5px;
        }
    `;
    document.head.appendChild(style);
    
    return copyBtn;
}

// Улучшенная функция показа уведомлений
function showNotification(message, details = "", duration = 3000) {
    // Удаляем существующее уведомление
    const existingNotification = document.querySelector('.notification');
    if (existingNotification) {
        existingNotification.remove();
    }
    
    // Создаем элемент уведомления
    const notification = document.createElement('div');
    notification.className = 'notification';
    
    // Добавляем содержимое
    if (details) {
        notification.innerHTML = `
            <div class="notification-title">${message}</div>
            <div class="notification-details">${details}</div>
        `;
    } else {
        notification.textContent = message;
    }
    
    // Стили для notification-title и notification-details
    const style = document.createElement('style');
    style.textContent = `
        .notification-title {
            font-weight: 500;
            margin-bottom: 4px;
        }
        .notification-details {
            font-size: 0.9em;
            opacity: 0.9;
        }
    `;
    document.head.appendChild(style);
    
    // Добавляем в документ
    document.body.appendChild(notification);
    
    // Показываем уведомление после небольшой задержки (для анимации)
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    // Скрываем и удаляем через указанное время
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 300); // ждем завершения анимации
    }, duration);
}


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

// Manual file download
function manualDownload() {
    chrome.storage.local.get(['transcription'], (result) => {
        if (!result.transcription || !result.transcription.text) {
            showNotification('Нет сохраненной транскрипции');
            return;
        }
        
        try {
            // Use direct UTF-8 encoded download
            directTextFileDownload(result.transcription.text, result.transcription.filename)
                .then(() => {
                    showNotification('Скачивание начато');
                })
                .catch((error) => {
                    console.error('Ошибка прямого скачивания:', error);
                    showNotification('Ошибка скачивания: ' + error.message);
                });
        } catch (error) {
            console.error('Ошибка скачивания:', error);
            showNotification('Ошибка скачивания: ' + error.message);
        }
    });
}

// Initialize popup UI
document.addEventListener("DOMContentLoaded", async () => {
    console.log("📱 Popup UI initialized");
    addImprovedCopyButton();
    
    // Check if we're on a Google Meet page
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0];
    const isGoogleMeet = currentTab?.url?.includes("meet.google.com") || false;
    
    // Update UI based on current tab
    updateUIState(isGoogleMeet);
    setupPreviewFunctionality();
    
    // Add an alternative download method
    const downloadBtn = document.getElementById('downloadBtn');
    if (downloadBtn) {
        downloadBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            manualDownload();
            return false;
        });
    }
    
    if (isGoogleMeet) {
        // First check if content script is accessible
        try {
            // Try to ping the content script with a timeout
            await pingContentScript(currentTab.id, 1000);
            
            // If we get here, the content script is accessible
            console.log("✅ Content script is accessible");
            
            // Get current recording status from content script
            chrome.tabs.sendMessage(currentTab.id, { action: "getRecordingStatus" }, (response) => {
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
        } catch (error) {
            console.error("Content script not accessible:", error);
            
            // Show a more helpful message in the UI
            meetingInfo.innerHTML = `
                <p>Не удалось подключиться к странице Google Meet.</p>
                <p>Попробуйте <a href="#" id="reloadLink">обновить страницу</a> Google Meet.</p>
            `;
            
            // Add reload link handler
            document.getElementById('reloadLink')?.addEventListener('click', () => {
                chrome.tabs.reload(currentTab.id);
                window.close(); // Close the popup
            });
        }
    }
    
    // Check for saved transcription
    loadTranscriptionInfo();
});

// Ping content script with timeout
function pingContentScript(tabId, timeout = 1000) {
    return new Promise((resolve, reject) => {
        // Set timeout to catch unresponsive content script
        const timeoutId = setTimeout(() => {
            reject(new Error("Content script ping timed out"));
        }, timeout);
        
        // Try to send a simple ping message
        chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
            clearTimeout(timeoutId);
            
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// Улучшенный обработчик кнопки начала записи
startBtn.addEventListener("click", async () => {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tabs[0]?.url?.includes("meet.google.com")) {
            alert("Пожалуйста, откройте Google Meet для записи звонка.");
            return;
        }
        
        // Получаем статус разрешений перед запуском записи
        const permissionStatus = await checkMediaPermissions();
        
        if (!permissionStatus.hasMicrophone) {
            // Если нет разрешения на микрофон, показываем информационное окно
            showPermissionDialog("microphone");
            return;
        }

        // Обновляем UI до отправки сообщения
        updateRecordingStatus(true);
        
        // Отправляем сообщение в content script
        chrome.tabs.sendMessage(tabs[0].id, { 
            action: "startRecording",
            source: "userInitiated" // Важно: указываем, что действие инициировано пользователем
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Ошибка связи с content script:", chrome.runtime.lastError.message);
                
                // Восстанавливаем UI, если возникла ошибка
                updateRecordingStatus(false);
                
                // Показываем ошибку пользователю
                showNotification("Ошибка запуска записи: " + chrome.runtime.lastError.message);
                return;
            }
            
            if (response) {
                console.log(response.status);
                
                if (response.captureType === "microphone") {
                    showNotification("Запись началась через микрофон", 
                                   "Захват системного звука недоступен. Используется микрофон.");
                } else {
                    showNotification("Запись началась");
                }
            }
        });
    } catch (error) {
        console.error("Ошибка при запуске записи:", error);
        updateRecordingStatus(false);
        showNotification("Не удалось запустить запись: " + error.message);
    }
});

// Проверка разрешений на доступ к медиа с лучшей диагностикой
async function checkMediaPermissions() {
    const result = {
        hasMicrophone: false,
        hasCamera: false,
        microphoneState: 'unknown',
        cameraState: 'unknown'
    };
    
    // Проверяем, поддерживается ли API разрешений
    if (!navigator.permissions || !navigator.permissions.query) {
        console.log("API разрешений не поддерживается, используем альтернативный метод проверки");
        // Альтернативный метод - попробуем получить устройства
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const hasMicPermission = devices.some(device => 
                device.kind === 'audioinput' && device.label);
            const hasCamPermission = devices.some(device => 
                device.kind === 'videoinput' && device.label);
                
            result.hasMicrophone = hasMicPermission;
            result.hasCamera = hasCamPermission;
            result.microphoneState = hasMicPermission ? 'granted' : 'prompt';
            result.cameraState = hasCamPermission ? 'granted' : 'prompt';
            
            return result;
        } catch (e) {
            console.error("Не удалось проверить устройства:", e);
            return result;
        }
    }
    
    try {
        // Проверяем разрешение на доступ к микрофону
        try {
            const micPermission = await navigator.permissions.query({ name: 'microphone' });
            result.hasMicrophone = micPermission.state === 'granted';
            result.microphoneState = micPermission.state;
        } catch (e) {
            console.warn("Не удалось запросить состояние разрешения микрофона:", e);
        }
        
        // Проверяем разрешение на доступ к камере
        try {
            const cameraPermission = await navigator.permissions.query({ name: 'camera' });
            result.hasCamera = cameraPermission.state === 'granted';
            result.cameraState = cameraPermission.state;
        } catch (e) {
            console.warn("Не удалось запросить состояние разрешения камеры:", e);
        }
        
        return result;
    } catch (error) {
        console.error("Ошибка при проверке разрешений:", error);
        return result;
    }
}

// Улучшенный обработчик кнопки начала записи
function setupStartButtonHandler() {
    const startBtn = document.getElementById("startBtn");
    if (!startBtn) return;
    
    // Очищаем старые обработчики, если они есть
    const newStartBtn = startBtn.cloneNode(true);
    startBtn.parentNode.replaceChild(newStartBtn, startBtn);
    
    // Добавляем новый улучшенный обработчик
    newStartBtn.addEventListener("click", handleStartRecording);
}

// Обработчик начала записи с улучшенной обработкой ошибок
async function handleStartRecording() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tabs[0]?.url?.includes("meet.google.com")) {
            showNotification("Ошибка", "Пожалуйста, откройте Google Meet для записи звонка");
            return;
        }
        
        // Сначала обновляем UI, чтобы дать мгновенную обратную связь
        updateRecordingStatus(true);
        showNotification("Подготовка к записи...");
        
        // Проверяем состояние разрешений
        const permissionStatus = await checkMediaPermissions();
        console.log("Статус разрешений:", permissionStatus);
        
        // Если нет разрешения на микрофон, сначала проверяем состояние
        if (permissionStatus.microphoneState === 'denied') {
            // Пользователь заблокировал доступ - показываем инструкции
            updateRecordingStatus(false); // Возвращаем UI в исходное состояние
            showMicrophoneBlockedDialog();
            return;
        }
        
        // Отправляем сообщение в content script для начала записи
        chrome.tabs.sendMessage(tabs[0].id, { 
            action: "startRecording",
            source: "userInitiated" // Важно для разрешения browser.mediaDevices
        }, (response) => {
            // Проверяем наличие ошибки взаимодействия с content script
            if (chrome.runtime.lastError) {
                console.error("Ошибка связи с content script:", chrome.runtime.lastError);
                updateRecordingStatus(false);
                showNotification("Ошибка запуска записи", chrome.runtime.lastError.message);
                return;
            }
            
            // Обрабатываем ответ
            if (response) {
                console.log("Ответ от content script:", response);
                
                if (response.error) {
                    // Обработка ошибки от content script
                    updateRecordingStatus(false);
                    
                    if (response.error === 'userInteractionRequired') {
                        showNotification("Требуется взаимодействие пользователя", 
                            "Пожалуйста, запустите запись снова");
                    } else if (response.error === 'permissionDenied') {
                        showMicrophoneBlockedDialog();
                    } else {
                        showNotification("Ошибка записи", response.error);
                    }
                } else {
                    // Запись успешно запущена
                    if (response.captureType === "microphone") {
                        showNotification("Запись началась (микрофон)", 
                            "Используется микрофон для записи");
                    } else {
                        showNotification("Запись началась", 
                            "Идет запись звука");
                    }
                }
            } else {
                // Нет ответа - что-то пошло не так
                updateRecordingStatus(false);
                showNotification("Нет ответа от страницы Google Meet");
            }
        });
    } catch (error) {
        console.error("Ошибка при запуске записи:", error);
        updateRecordingStatus(false);
        showNotification("Ошибка запуска", error.message);
    }
}

// Показываем диалог с инструкциями для случая, когда микрофон заблокирован
function showMicrophoneBlockedDialog() {
    // Создаем модальное окно
    const modal = document.createElement('div');
    modal.className = 'permission-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    
    // Содержимое модального окна
    modal.innerHTML = `
        <div style="background-color: white; border-radius: 8px; width: 85%; max-width: 400px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
            <h3 style="margin-top: 0; color: #ea4335;">Доступ к микрофону заблокирован</h3>
            
            <p>Для работы записи необходим доступ к микрофону или системному звуку.</p>
            
            <p style="margin-bottom: 5px;"><strong>Как разрешить доступ:</strong></p>
            <ol style="margin-top: 0; padding-left: 20px;">
                <li>Нажмите на значок 🔒 или 🔇 в адресной строке</li>
                <li>Выберите "Разрешения сайта" или "Настройки сайта"</li>
                <li>Найдите "Микрофон" и установите "Разрешить"</li>
                <li>Обновите страницу и попробуйте снова</li>
            </ol>
            
            <div style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 8px;">
                <button id="helpBtn" style="background: none; border: 1px solid #dadce0; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Подробнее</button>
                <button id="closeModalBtn" style="background-color: #1a73e8; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Закрыть</button>
            </div>
        </div>
    `;
    
    // Добавляем модальное окно на страницу
    document.body.appendChild(modal);
    
    // Обработчики событий
    document.getElementById('closeModalBtn').addEventListener('click', () => {
        modal.remove();
    });
    
    document.getElementById('helpBtn').addEventListener('click', () => {
        // Открываем справочную страницу или настройки Chrome
        try {
            chrome.tabs.create({
                url: 'chrome://settings/content/microphone'
            });
        } catch (e) {
            // В случае ошибки открываем общую страницу помощи
            chrome.tabs.create({
                url: 'https://support.google.com/chrome/answer/2693767'
            });
        }
        modal.remove();
    });
}

// Показываем диалог для запроса разрешений
function showPermissionDialog(permissionType) {
    // Создаем диалоговое окно
    const dialog = document.createElement('div');
    dialog.className = 'permission-dialog';
    dialog.innerHTML = `
        <div class="permission-dialog-content">
            <h3>Требуется разрешение</h3>
            <p>Для работы функции записи необходим доступ к ${
                permissionType === 'microphone' ? 'микрофону' : 
                permissionType === 'camera' ? 'камере' : 
                'медиаустройствам'
            }.</p>
            <p>Разрешите доступ при появлении запроса от браузера.</p>
            <div class="permission-dialog-actions">
                <button id="requestPermissionBtn" class="btn primary">Запросить доступ</button>
                <button id="cancelPermissionBtn" class="btn secondary">Отмена</button>
            </div>
        </div>
    `;
    
    // Добавляем стили
    const style = document.createElement('style');
    style.textContent = `
        .permission-dialog {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        }
        
        .permission-dialog-content {
            background-color: white;
            border-radius: 8px;
            padding: 24px;
            max-width: 80%;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }
        
        .permission-dialog h3 {
            margin-top: 0;
            color: #1a73e8;
        }
        
        .permission-dialog-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }
    `;
    document.head.appendChild(style);
    
    // Добавляем на страницу
    document.body.appendChild(dialog);
    
    // Обработчики кнопок
    document.getElementById('requestPermissionBtn').addEventListener('click', async () => {
        try {
            // Запрашиваем соответствующее разрешение
            if (permissionType === 'microphone') {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } else if (permissionType === 'camera') {
                await navigator.mediaDevices.getUserMedia({ video: true });
            } else if (permissionType === 'display') {
                await navigator.mediaDevices.getDisplayMedia({ video: true });
            }
            
            // Закрываем диалог
            document.body.removeChild(dialog);
            
            // Перезапускаем процесс
            startBtn.click();
        } catch (error) {
            console.error(`Ошибка при запросе разрешения на ${permissionType}:`, error);
            
            // Обновляем сообщение в диалоге
            const content = dialog.querySelector('.permission-dialog-content');
            content.innerHTML = `
                <h3>Доступ запрещен</h3>
                <p>Вы не дали разрешение на доступ к ${
                    permissionType === 'microphone' ? 'микрофону' : 
                    permissionType === 'camera' ? 'камере' : 
                    'экрану'
                }.</p>
                <p>Для работы плагина необходимо разрешить доступ в настройках браузера.</p>
                <div class="permission-dialog-actions">
                    <button id="closePermissionBtn" class="btn primary">Понятно</button>
                </div>
            `;
            
            // Обновляем обработчик
            document.getElementById('closePermissionBtn').addEventListener('click', () => {
                document.body.removeChild(dialog);
            });
        }
    });
    
    document.getElementById('cancelPermissionBtn').addEventListener('click', () => {
        document.body.removeChild(dialog);
    });
}

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