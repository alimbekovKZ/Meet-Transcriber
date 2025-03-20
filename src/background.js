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

// Handle audio processing in background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "sendAudioToWhisper") {
        (async () => {
            try {
                console.log("📩 Получен аудиофайл, обрабатываем...");
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
                let audioData;
                try {
                    // Split the base64 string to get only the data part
                    const parts = message.file.split(',');
                    const mimeTypeHeader = parts[0] || '';
                    const base64Data = parts[1];
                    
                    console.log("🔍 MIME заголовок:", mimeTypeHeader);
                    
                    if (!base64Data) {
                        throw new Error("Некорректные данные аудиофайла");
                    }
                    
                    // Decode Base64 to binary
                    const byteCharacters = atob(base64Data);
                    const byteNumbers = new Array(byteCharacters.length);
                    
                    for (let i = 0; i < byteCharacters.length; i++) {
                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    
                    audioData = new Uint8Array(byteNumbers);
                    console.log("🔄 Аудиоданные декодированы, размер:", 
                              (audioData.length / 1024).toFixed(2), "KB");
                } catch (error) {
                    console.error("❌ Ошибка декодирования аудиоданных:", error);
                    showNotification("Ошибка", "Не удалось декодировать аудиофайл");
                    sendResponse({ status: "❌ Ошибка декодирования", error: error.message });
                    return;
                }

                // Create audio blob with proper MIME type
                // Whisper API works better with mp3, so we'll use that
                const audioBlob = new Blob([audioData], { type: 'audio/mp3' });
                
                console.log("🔊 Аудиофайл создан:", 
                          (audioBlob.size / 1024).toFixed(2), "KB,", 
                          "тип:", audioBlob.type);

                // Create form data for API request
                const formData = new FormData();
                
                // Add file with .mp3 extension for better compatibility
                formData.append("file", audioBlob, "recording.mp3");
                formData.append("model", WHISPER_MODEL);
                formData.append("language", language);
                formData.append("response_format", "json");
                
                // Set temperature for better accuracy
                formData.append("temperature", "0.0");
                
                // Add additional options for better results
                formData.append("prompt", "Это транскрипция звонка Google Meet.");
                
                console.log("📋 Параметры запроса:", {
                    model: WHISPER_MODEL,
                    language,
                    fileSize: (audioBlob.size / 1024).toFixed(2) + " KB",
                    fileType: audioBlob.type
                });

                // Determine the authentication method based on key format
                const isProjectKey = apiKey.startsWith("sk-proj-");
                const headers = new Headers();
                
                if (isProjectKey) {
                    // Try alternative authentication methods for project keys
                    headers.append("Authorization", `Bearer ${apiKey}`);
                    headers.append("X-API-Key", apiKey);
                } else {
                    // Standard OpenAI authentication
                    headers.append("Authorization", `Bearer ${apiKey}`);
                }
                
                console.log(`🌍 Отправка запроса в: ${apiUrl}`);
                console.log(`🔑 Используется тип ключа: ${isProjectKey ? "Проектный ключ" : "Стандартный ключ"}`);
                showNotification("Транскрибация", "Отправляем аудио на сервер...");

                // Send request to API with timeout and retry logic
                let attempts = 0;
                const maxAttempts = 3;
                
                while (attempts < maxAttempts) {
                    attempts++;
                    console.log(`🔄 Попытка #${attempts} отправки аудио`);
                    
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2-minute timeout
                        
                        const response = await fetch(apiUrl, {
                            method: "POST",
                            headers: headers,
                            body: formData,
                            signal: controller.signal
                        });
                        
                        clearTimeout(timeoutId);
                        
                        // Get response text first (helps with debugging)
                        const responseText = await response.text();
                        console.log("📝 Получен ответ:", responseText.substring(0, 100) + "...");
                        
                        // Parse response as JSON (if possible)
                        let result;
                        try {
                            result = JSON.parse(responseText);
                        } catch (e) {
                            console.error("❌ Ошибка парсинга JSON:", e);
                            if (response.ok) {
                                // If the response was OK but not JSON, use the text as is
                                result = { text: responseText };
                            } else {
                                throw new Error(`Получен некорректный ответ: ${responseText}`);
                            }
                        }
                        
                        if (!response.ok) {
                            const errorMsg = result.error?.message || 
                                            result.error || 
                                            `HTTP ошибка: ${response.status}`;
                            
                            console.error("⚠ Ошибка от сервера:", response.status, errorMsg);
                            
                            // If this is a server error or rate limit, retry
                            if (response.status >= 500 || response.status === 429) {
                                if (attempts < maxAttempts) {
                                    // Wait before retrying (exponential backoff)
                                    const waitTime = Math.pow(2, attempts) * 1000;
                                    console.log(`⏳ Ожидаем ${waitTime}ms перед повторной попыткой...`);
                                    await new Promise(r => setTimeout(r, waitTime));
                                    continue; // Try again
                                }
                            }
                            
                            showNotification("Ошибка обработки", errorMsg);
                            sendResponse({ 
                                status: "❌ Ошибка API", 
                                error: errorMsg,
                                details: result
                            });
                            return;
                        }
                        
                        // Check if we have transcription text
                        if (result.text) {
                            console.log("📥 Ответ от Whisper получен успешно");
                            
                            // Generate filename based on meeting name and date
                            const filename = generateFilename(message.meetingName);
                            
                            // Save transcription to file
                            const downloadId = await saveTranscriptionToFile(result.text, filename);
                            
                            // Store download info for later reference
                            chrome.storage.local.set({
                                lastDownload: {
                                    id: downloadId,
                                    filename: filename,
                                    timestamp: new Date().toISOString()
                                }
                            });
                            
                            showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                            sendResponse({ 
                                status: "✅ Аудиофайл обработан", 
                                transcription: result.text,
                                filename: filename,
                                downloadId: downloadId
                            });
                            return;
                        } else {
                            console.error("⚠ Ответ получен, но текст отсутствует:", result);
                            throw new Error("Нет текста в ответе API");
                        }
                    } catch (fetchError) {
                        console.error(`⚠ Ошибка запроса (попытка ${attempts}/${maxAttempts}):`, fetchError);
                        
                        if (fetchError.name === 'AbortError') {
                            console.error("⌛ Превышено время ожидания ответа от сервера");
                            if (attempts < maxAttempts) {
                                console.log("🔄 Повторная попытка...");
                                continue; // Try again
                            }
                        }
                        
                        // If we've reached max attempts or it's not a retriable error
                        if (attempts >= maxAttempts) {
                            showNotification("Ошибка", fetchError.message || "Не удалось отправить аудио на сервер");
                            sendResponse({ 
                                status: "❌ Ошибка отправки", 
                                error: fetchError.message 
                            });
                            return;
                        }
                        
                        // Wait before retrying (exponential backoff)
                        const waitTime = Math.pow(2, attempts) * 1000;
                        console.log(`⏳ Ожидаем ${waitTime}ms перед повторной попыткой...`);
                        await new Promise(r => setTimeout(r, waitTime));
                    }
                }
                
                // If we get here, all attempts failed
                showNotification("Ошибка", "Не удалось отправить аудио после нескольких попыток");
                sendResponse({ 
                    status: "❌ Все попытки отправки не удались", 
                    error: "Превышено максимальное количество попыток" 
                });
                
            } catch (error) {
                console.error("⚠ Критическая ошибка при обработке аудио:", error);
                showNotification("Ошибка", "Произошла непредвиденная ошибка при обработке аудио");
                sendResponse({ status: "❌ Критическая ошибка", error: error.message });
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

// Improved file download function for background.js

// Save transcription to file using reliable download method
async function saveTranscriptionToFile(transcription, filename) {
    try {
        console.log("💾 Создаем файл для скачивания:", filename);
        console.log("📝 Текст транскрипции:", transcription.substring(0, 100) + "...");
        
        // Create a blob from the transcription text
        const blob = new Blob([transcription], { type: "text/plain" });
        
        // Create a direct download URL
        const url = URL.createObjectURL(blob);
        
        // Store the transcription data for popup access
        chrome.storage.local.set({
            transcription: {
                text: transcription,
                filename: filename,
                timestamp: new Date().toISOString(),
                url: url  // Store URL for direct access
            }
        });
        
        console.log("✅ Транскрипция сохранена в хранилище");
        
        // Use chrome.downloads API
        return new Promise((resolve, reject) => {
            chrome.downloads.download({
                url: url,
                filename: filename,
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error("❌ Ошибка загрузки через chrome.downloads:", chrome.runtime.lastError);
                    
                    // Fall back to creating a download link in a new tab
                    createDownloadTab(transcription, filename)
                        .then(tabId => resolve(tabId))
                        .catch(error => reject(error));
                } else {
                    console.log("✅ Загрузка файла начата, ID:", downloadId);
                    resolve(downloadId);
                    
                    // Keep URL alive for a while to ensure download completes
                    setTimeout(() => {
                        URL.revokeObjectURL(url);
                    }, 60000); // 1 minute
                }
            });
        });
    } catch (error) {
        console.error("❌ Ошибка при сохранении файла:", error);
        
        // Try fallback method
        try {
            const tabId = await createDownloadTab(transcription, filename);
            return tabId;
        } catch (fallbackError) {
            console.error("❌ Ошибка при использовании запасного метода:", fallbackError);
            throw fallbackError;
        }
    }
}

// Create a download page in a new tab as fallback
async function createDownloadTab(transcription, filename) {
    return new Promise((resolve, reject) => {
        try {
            // Create a new tab with the text content
            chrome.tabs.create({ url: 'about:blank' }, (tab) => {
                console.log("📄 Открыт новый таб для скачивания");
                
                // Execute script to create download UI
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    function: (text, name) => {
                        document.body.innerHTML = `
                            <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 20px; border: 1px solid #ccc; border-radius: 5px;">
                                <h1>Google Meet Transcription</h1>
                                <p>Транскрипция готова к скачиванию:</p>
                                <div style="margin: 20px 0;">
                                    <button id="downloadBtn" style="background: #1a73e8; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">
                                        Скачать файл: ${name}
                                    </button>
                                </div>
                                <div style="margin-top: 20px; padding: 10px; background: #f5f5f5; border-radius: 4px; max-height: 400px; overflow-y: auto;">
                                    <pre style="white-space: pre-wrap; word-break: break-word;">${text}</pre>
                                </div>
                                <p style="margin-top: 20px; color: #5f6368; font-style: italic;">
                                    Вы можете также скопировать текст выше вручную.
                                </p>
                            </div>
                        `;
                        
                        // Add download functionality
                        document.getElementById('downloadBtn').onclick = () => {
                            const blob = new Blob([text], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = name;
                            a.click();
                            URL.revokeObjectURL(url);
                        };
                        
                        // Also set page title
                        document.title = "Транскрипция - " + name;
                    },
                    args: [transcription, filename]
                });
                
                resolve(tab.id);
            });
        } catch (error) {
            console.error("❌ Ошибка при создании таба для скачивания:", error);
            reject(error);
        }
    });
}

// Direct download function for popup
async function triggerDirectDownload(text, filename) {
    try {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        return new Promise((resolve, reject) => {
            chrome.downloads.download({
                url: url,
                filename: filename,
                saveAs: true  // Show save dialog
            }, (downloadId) => {
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(downloadId);
                }
            });
        });
    } catch (error) {
        console.error("❌ Ошибка при прямом скачивании:", error);
        throw error;
    }
}


// Add this to background.js - completely new approach for handling audio

// Handle raw audio processing (new message type)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "processRawAudio") {
        (async () => {
            try {
                console.log("📩 Получены сырые аудиоданные, размер:", 
                          (message.audioData.length / 1024).toFixed(2), "KB");
                
                showNotification("Транскрибация", "Начинаем обработку аудиозаписи...");

                // Get API key and settings from storage
                const storage = await chrome.storage.local.get(['apiKey', 'defaultLanguage', 'apiUrl']);
                let apiKey = storage.apiKey;
                const language = storage.defaultLanguage || DEFAULT_LANGUAGE;
                const apiUrl = storage.apiUrl || DEFAULT_API_URL;

                if (!apiKey) {
                    const error = "API ключ не настроен. Откройте настройки расширения.";
                    console.error("⚠ " + error);
                    showNotification("Ошибка API", error);
                    sendResponse({ status: "❌ Ошибка API", error });
                    return;
                }

                // Convert array back to binary data
                const audioData = new Uint8Array(message.audioData);
                
                // First try: create WAV file
                try {
                    // Create a WAV file (Whisper supports this format)
                    const wavFile = createWavFile(audioData);
                    console.log("💿 WAV файл создан, размер:", (wavFile.size / 1024).toFixed(2), "KB");
                    
                    // Try to send the WAV file
                    const result = await sendToWhisperAPI(wavFile, apiUrl, apiKey, language, "recording.wav");
                    
                    if (result.success) {
                        // Generate filename and save transcription
                        const filename = generateFilename(message.meetingName);
                        const downloadId = await saveTranscriptionToFile(result.text, filename);
                        
                        showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                        sendResponse({ 
                            status: "✅ Аудиофайл обработан", 
                            transcription: result.text,
                            filename: filename,
                            downloadId: downloadId
                        });
                        return;
                    } else {
                        console.error("❌ Ошибка при обработке WAV:", result.error);
                        // Continue to next attempt
                    }
                } catch (wavError) {
                    console.error("❌ Ошибка при создании WAV:", wavError);
                    // Continue to next attempt
                }
                
                // Second try: create MP3-like file
                try {
                    // Create a Blob that claims to be MP3
                    const mp3Blob = new Blob([audioData], { type: 'audio/mpeg' });
                    console.log("🎵 MP3 Blob создан, размер:", (mp3Blob.size / 1024).toFixed(2), "KB");
                    
                    // Try to send as MP3
                    const result = await sendToWhisperAPI(mp3Blob, apiUrl, apiKey, language, "recording.mp3");
                    
                    if (result.success) {
                        // Generate filename and save transcription
                        const filename = generateFilename(message.meetingName);
                        const downloadId = await saveTranscriptionToFile(result.text, filename);
                        
                        showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                        sendResponse({ 
                            status: "✅ Аудиофайл обработан", 
                            transcription: result.text,
                            filename: filename,
                            downloadId: downloadId
                        });
                        return;
                    } else {
                        console.error("❌ Ошибка при обработке MP3:", result.error);
                        // Continue to last attempt
                    }
                } catch (mp3Error) {
                    console.error("❌ Ошибка при создании MP3:", mp3Error);
                    // Continue to last attempt
                }
                
                // Last attempt: try sending raw data as M4A
                try {
                    const m4aBlob = new Blob([audioData], { type: 'audio/m4a' });
                    console.log("🔊 M4A Blob создан, размер:", (m4aBlob.size / 1024).toFixed(2), "KB");
                    
                    const result = await sendToWhisperAPI(m4aBlob, apiUrl, apiKey, language, "recording.m4a");
                    
                    if (result.success) {
                        // Generate filename and save transcription
                        const filename = generateFilename(message.meetingName);
                        const downloadId = await saveTranscriptionToFile(result.text, filename);
                        
                        showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                        sendResponse({ 
                            status: "✅ Аудиофайл обработан", 
                            transcription: result.text,
                            filename: filename,
                            downloadId: downloadId
                        });
                        return;
                    } else {
                        // All attempts failed
                        console.error("❌ Все попытки обработки аудио завершились неудачей");
                        showNotification("Ошибка", "Не удалось обработать аудиофайл");
                        sendResponse({ 
                            status: "❌ Ошибка обработки", 
                            error: "Все попытки обработки аудио завершились неудачей"
                        });
                    }
                } catch (finalError) {
                    console.error("❌ Критическая ошибка при обработке аудио:", finalError);
                    showNotification("Ошибка", "Произошла непредвиденная ошибка при обработке аудио");
                    sendResponse({ 
                        status: "❌ Критическая ошибка", 
                        error: finalError.message 
                    });
                }
            } catch (error) {
                console.error("⚠ Общая ошибка обработки:", error);
                showNotification("Ошибка", "Произошла непредвиденная ошибка");
                sendResponse({ status: "❌ Общая ошибка", error: error.message });
            }
        })();
        
        return true; // Важно для асинхронного sendResponse
    }
});

// Create simple WAV file from raw audio data
function createWavFile(audioData) {
    // This is a simplified approach - we're creating a "fake" WAV
    // by adding a basic WAV header to the audio data
    
    // Basic WAV header for 16kHz mono audio
    const wavHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // "RIFF"
        0, 0, 0, 0,             // File size (filled later)
        0x57, 0x41, 0x56, 0x45, // "WAVE"
        0x66, 0x6D, 0x74, 0x20, // "fmt "
        16, 0, 0, 0,            // fmt chunk size
        1, 0,                   // Audio format (1 = PCM)
        1, 0,                   // Number of channels
        0x80, 0x3E, 0, 0,       // Sample rate (16000 Hz)
        0, 0, 0, 0,             // Byte rate (filled later)
        2, 0,                   // Block align
        16, 0,                  // Bits per sample
        0x64, 0x61, 0x74, 0x61, // "data"
        0, 0, 0, 0              // Data size (filled later)
    ]);
    
    // Fill in the file size
    const fileSize = audioData.length + 36;
    wavHeader[4] = fileSize & 0xff;
    wavHeader[5] = (fileSize >> 8) & 0xff;
    wavHeader[6] = (fileSize >> 16) & 0xff;
    wavHeader[7] = (fileSize >> 24) & 0xff;
    
    // Fill in the byte rate
    const byteRate = 16000 * 1 * 16 / 8;
    wavHeader[28] = byteRate & 0xff;
    wavHeader[29] = (byteRate >> 8) & 0xff;
    wavHeader[30] = (byteRate >> 16) & 0xff;
    wavHeader[31] = (byteRate >> 24) & 0xff;
    
    // Fill in the data size
    wavHeader[40] = audioData.length & 0xff;
    wavHeader[41] = (audioData.length >> 8) & 0xff;
    wavHeader[42] = (audioData.length >> 16) & 0xff;
    wavHeader[43] = (audioData.length >> 24) & 0xff;
    
    // Combine header and audio data
    const wavFile = new Blob([wavHeader, audioData], { type: 'audio/wav' });
    return wavFile;
}

// Send audio to Whisper API
async function sendToWhisperAPI(audioBlob, apiUrl, apiKey, language, filename) {
    try {
        console.log(`🌍 Отправка ${filename} на API ${apiUrl}`);
        
        // Create form data
        const formData = new FormData();
        formData.append("file", audioBlob, filename);
        formData.append("model", WHISPER_MODEL);
        formData.append("language", language);
        formData.append("response_format", "json");
        
        // Set up headers
        const headers = new Headers();
        if (apiKey.startsWith("sk-proj-")) {
            // Project key - try multiple auth methods
            headers.append("Authorization", `Bearer ${apiKey}`);
            headers.append("X-API-Key", apiKey);
        } else {
            // Standard key
            headers.append("Authorization", `Bearer ${apiKey}`);
        }
        
        // Set up request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 1-minute timeout
        
        // Send request
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: headers,
            body: formData,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // Check for HTTP errors
        if (!response.ok) {
            // Try to parse error response
            let errorMessage;
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || `HTTP ошибка: ${response.status}`;
            } catch (e) {
                errorMessage = `HTTP ошибка: ${response.status}`;
            }
            
            return { 
                success: false, 
                error: errorMessage
            };
        }
        
        // Parse successful response
        const result = await response.json();
        
        if (result.text) {
            return {
                success: true,
                text: result.text
            };
        } else {
            return {
                success: false,
                error: "API вернул ответ без текста"
            };
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            return {
                success: false,
                error: "Превышено время ожидания ответа от сервера"
            };
        }
        
        return {
            success: false,
            error: error.message
        };
    }
}


// Add or update this message handler in background.js

// Handle redownload requests from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "redownloadTranscription") {
        (async () => {
            try {
                console.log("📥 Получен запрос на повторное скачивание файла");
                
                const result = await chrome.storage.local.get(['transcription']);
                
                if (!result.transcription || !result.transcription.text) {
                    console.error("❌ Нет сохраненной транскрипции");
                    sendResponse({ 
                        success: false, 
                        error: "Нет сохраненной транскрипции" 
                    });
                    return;
                }
                
                const { text, filename } = result.transcription;
                
                // Try direct download first
                try {
                    const downloadId = await triggerDirectDownload(text, filename);
                    console.log("✅ Скачивание началось, ID:", downloadId);
                    sendResponse({ success: true, downloadId });
                } catch (downloadError) {
                    console.error("❌ Ошибка прямого скачивания:", downloadError);
                    
                    // Fallback to tab method
                    try {
                        const tabId = await createDownloadTab(text, filename);
                        console.log("✅ Создана страница скачивания, ID:", tabId);
                        sendResponse({ success: true, tabId });
                    } catch (tabError) {
                        console.error("❌ Ошибка создания таба:", tabError);
                        sendResponse({ 
                            success: false, 
                            error: "Не удалось скачать файл: " + tabError.message 
                        });
                    }
                }
            } catch (error) {
                console.error("❌ Общая ошибка скачивания:", error);
                sendResponse({ 
                    success: false, 
                    error: "Ошибка: " + error.message 
                });
            }
        })();
        
        return true; // Important for async sendResponse
    }
    
    // New message type for advanced download
    if (message.type === "downloadTranscriptionAsFile") {
        (async () => {
            try {
                if (!message.text || !message.filename) {
                    sendResponse({ 
                        success: false, 
                        error: "Отсутствует текст или имя файла" 
                    });
                    return;
                }
                
                console.log("📥 Создаем файл напрямую:", message.filename);
                
                // Create a blob and trigger download
                const blob = new Blob([message.text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                
                chrome.downloads.download({
                    url: url,
                    filename: message.filename,
                    saveAs: message.saveAs || false
                }, (downloadId) => {
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                    
                    if (chrome.runtime.lastError) {
                        console.error("❌ Ошибка загрузки:", chrome.runtime.lastError);
                        sendResponse({ 
                            success: false, 
                            error: chrome.runtime.lastError.message 
                        });
                    } else {
                        console.log("✅ Загрузка файла начата, ID:", downloadId);
                        sendResponse({ success: true, downloadId });
                    }
                });
            } catch (error) {
                console.error("❌ Ошибка при создании файла:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        
        return true; // Important for async sendResponse
    }
});