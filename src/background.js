// Background script for Google Meet Transcription Plugin

// Constants
const DEFAULT_LANGUAGE = "ru";
const WHISPER_MODEL = "whisper-1";
const DEFAULT_API_URL = "https://api.openai.com/v1/audio/transcriptions";

// Initialize plugin settings
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['apiKey', 'enableNotifications', 'defaultLanguage'], (result) => {
        if (!result.apiKey) {
            chrome.storage.local.set({
                apiKey: "", // Empty by default, to be set by user
                enableNotifications: true,
                defaultLanguage: DEFAULT_LANGUAGE
            });
            // Open options page when first installed
            chrome.runtime.openOptionsPage();
        }
    });
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "sendAudioToWhisper") {
        (async () => {
            try {
                console.log("📩 Получен аудиофайл, конвертируем...");
                showNotification("Транскрибация", "Начинаем обработку аудиозаписи...");

                // Get API key and settings from storage
                const storage = await chrome.storage.local.get(['apiKey', 'defaultLanguage', 'apiUrl']);
                let apiKey = storage.apiKey;
                const language = storage.defaultLanguage || DEFAULT_LANGUAGE;
                // Use custom API URL if set, otherwise use default
                const apiUrl = storage.apiUrl || DEFAULT_API_URL;

                if (!apiKey) {
                    const error = "API ключ не настроен. Откройте настройки расширения.";
                    console.error("⚠ " + error);
                    showNotification("Ошибка API", error);
                    sendResponse({ status: "❌ Ошибка API", error });
                    return;
                }

                // Decode Base64 audio data
                const byteCharacters = atob(message.file.split(',')[1]);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const audioBlob = new Blob([byteArray], { type: "audio/wav" });

                console.log("🔄 Файл успешно декодирован!");

                // Create form data for API request
                const formData = new FormData();
                formData.append("file", audioBlob, "recording.wav");
                formData.append("model", WHISPER_MODEL);
                formData.append("language", language);

                // Determine the authentication method based on key format
                const isProjectKey = apiKey.startsWith("sk-proj-");
                const authHeader = {};
                
                if (isProjectKey) {
                    // Try alternative authentication methods for project keys
                    authHeader.Authorization = `Bearer ${apiKey}`;
                    // Add fallback authentication methods
                    authHeader["X-API-Key"] = apiKey;
                } else {
                    // Standard OpenAI authentication
                    authHeader.Authorization = `Bearer ${apiKey}`;
                }
                
                console.log(`🌍 Отправка запроса в: ${apiUrl}`);
                console.log(`🔑 Используется тип ключа: ${isProjectKey ? "Проектный ключ" : "Стандартный ключ"}`);
                showNotification("Транскрибация", "Отправляем аудио на сервер...");

                // Send request to API
                const response = await fetch(apiUrl, {
                    method: "POST",
                    headers: authHeader,
                    body: formData,
                });

                const result = await response.json();

                if (response.ok) {
                    console.log("📥 Ответ от Whisper получен успешно");
                    
                    // Generate filename based on meeting name and date
                    const filename = generateFilename(message.meetingName);
                    
                    // Save transcription to file
                    saveTranscriptionToFile(result.text, filename);
                    
                    showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                    sendResponse({ status: "✅ Аудиофайл обработан", transcription: result.text });
                } else {
                    console.error("⚠ Ошибка от OpenAI:", result);
                    showNotification("Ошибка OpenAI", "Не удалось обработать аудиофайл");
                    sendResponse({ status: "❌ Ошибка OpenAI", error: result });
                }
            } catch (error) {
                console.error("⚠ Ошибка при отправке в Whisper:", error);
                showNotification("Ошибка", "Не удалось отправить аудио на сервер");
                sendResponse({ status: "❌ Ошибка отправки", error: error.message });
            }
        })();

        return true; // Важно для асинхронного sendResponse
    }
});

// Generate filename for transcription
function generateFilename(meetingName) {
    const date = new Date();
    const formattedDate = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const formattedTime = date.toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
    
    // Clean meeting name or use default
    const cleanName = meetingName 
        ? meetingName.replace(/[^\w\s-]/g, "").substring(0, 30).trim() 
        : "встреча";
        
    return `transcription_${cleanName}_${formattedDate}_${formattedTime}.txt`;
}

// Save transcription to file using download method
async function saveTranscriptionToFile(transcription, filename) {
    try {
        // Create a blob from the transcription text
        const blob = new Blob([transcription], { type: "text/plain" });
        
        // Standard download method that works in background script
        console.log("💾 Создаем файл для скачивания");
        
        // Use chrome.downloads API for reliable file saving from background
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("❌ Ошибка при скачивании:", chrome.runtime.lastError.message);
            } else {
                console.log(`✅ Скачивание файла начато, ID: ${downloadId}`);
            }
            // Revoke URL after download starts
            URL.revokeObjectURL(url);
        });
        
        console.log(`✅ Запрос на скачивание файла отправлен: ${filename}`);
        return true;
    } catch (error) {
        console.error("❌ Ошибка при сохранении файла:", error);
        
        // Attempt fallback method if the download API fails
        try {
            const blob = new Blob([transcription], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            
            // Create a new tab with the text content
            chrome.tabs.create({ url: url }, (tab) => {
                console.log("📄 Открыт новый таб с текстом транскрипции. Пользователь может сохранить вручную.");
                
                // Add a listener to close the tab when download is complete
                chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                    if (tabId === tab.id && info.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        
                        // Execute content script to add download button
                        chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            function: (filename) => {
                                const downloadBtn = document.createElement('button');
                                downloadBtn.textContent = 'Скачать транскрипцию';
                                downloadBtn.style.position = 'fixed';
                                downloadBtn.style.top = '10px';
                                downloadBtn.style.left = '10px';
                                downloadBtn.style.zIndex = '9999';
                                downloadBtn.style.padding = '10px';
                                downloadBtn.style.backgroundColor = '#1a73e8';
                                downloadBtn.style.color = 'white';
                                downloadBtn.style.border = 'none';
                                downloadBtn.style.borderRadius = '4px';
                                downloadBtn.style.cursor = 'pointer';
                                
                                downloadBtn.onclick = () => {
                                    const a = document.createElement('a');
                                    a.href = window.location.href;
                                    a.download = filename;
                                    a.click();
                                };
                                
                                document.body.prepend(downloadBtn);
                            },
                            args: [filename]
                        });
                    }
                });
            });
            
            return true;
        } catch (fallbackError) {
            console.error("❌ Ошибка при использовании запасного метода:", fallbackError);
            return false;
        }
    }
}

// Show notification
function showNotification(title, message) {
    chrome.storage.local.get(['enableNotifications'], (result) => {
        if (result.enableNotifications) {
            chrome.notifications.create({
                type: "basic",
                iconUrl: "../images/icon128.png",
                title: title,
                message: message
            });
        }
    });
}