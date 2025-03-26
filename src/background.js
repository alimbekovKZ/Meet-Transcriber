// Background script for Google Meet Transcription Plugin

// Constants
const DEFAULT_LANGUAGE = "ru";
const WHISPER_MODEL = "whisper-1";
const DEFAULT_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const chunkedTranscriptions = {};

// Global diagnostic object to track download status
const downloadDiagnostics = {
  attempts: [],
  lastError: null,
  addAttempt: function(method, result, error = null) {
    this.attempts.push({
      method,
      timestamp: new Date().toISOString(),
      success: !error,
      error: error ? error.message || String(error) : null,
      result
    });
    if (error) {
      this.lastError = error;
    }
    console.log(`📊 Download attempt [${method}]: ${error ? '❌ Failed' : '✅ Success'}`);
    if (error) {
      console.error(`📊 Error details:`, error);
    }
  },
  reset: function() {
    this.attempts = [];
    this.lastError = null;
  },
  getSummary: function() {
    return {
      totalAttempts: this.attempts.length,
      methods: this.attempts.map(a => a.method),
      lastError: this.lastError ? (this.lastError.message || String(this.lastError)) : null,
      allErrors: this.attempts.filter(a => !a.success).map(a => a.error)
    };
  }
};

// Initialize extension and load saved chunks
chrome.runtime.onInstalled.addListener(() => {
    console.log("🔌 Extension installed/updated");
    
    // Load settings
    chrome.storage.local.get(['apiKey', 'enableNotifications', 'defaultLanguage', 'transcriptionChunks'], (result) => {
        if (!result.apiKey) {
            chrome.storage.local.set({
                apiKey: "", // Empty by default, to be set by user
                enableNotifications: true,
                defaultLanguage: DEFAULT_LANGUAGE
            });
            // Open options page when first installed
            chrome.runtime.openOptionsPage();
        }
        
        // Load saved chunks
        if (result.transcriptionChunks) {
            Object.assign(chunkedTranscriptions, result.transcriptionChunks);
            console.log("📂 Loaded chunks from storage:", Object.keys(chunkedTranscriptions).length, "meetings");
        }
    });
    
    // Set up periodic saving of chunks state
    setInterval(saveChunksToStorage, 60000); // Save every minute
});

// Handle audio processing in background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "sendAudioToWhisper") {
        (async () => {
            try {
                console.log("📩 Получен аудиофайл, обрабатываем...");
                
                // Check if this is a chunk
                const isChunk = message.chunkInfo && typeof message.chunkInfo === 'object';
                const chunkInfo = isChunk ? message.chunkInfo : { number: 1, isLast: true };
                
                // Generate a unique key for this meeting session
                const meetingKey = message.meetingName + "_" + (new Date().toISOString().split('T')[0]);
                
                if (isChunk) {
                    showNotification(
                        "Транскрибация", 
                        `Начинаем обработку части ${chunkInfo.number} аудиозаписи...`
                    );
                } else {
                    showNotification(
                        "Транскрибация", 
                        "Начинаем обработку аудиозаписи..."
                    );
                }

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
                    // Process the audio data (existing code)
                    // ...
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
                const audioBlob = new Blob([audioData], { type: 'audio/mp3' });
                
                console.log("🔊 Аудиофайл создан:", 
                          (audioBlob.size / 1024).toFixed(2), "KB,", 
                          "тип:", audioBlob.type);

                // Create form data for API request
                const formData = new FormData();
                
                // Add file with .mp3 extension for better compatibility
                formData.append("file", audioBlob, `recording_chunk${chunkInfo.number}.mp3`);
                formData.append("model", WHISPER_MODEL);
                formData.append("language", language);
                formData.append("response_format", "json");
                
                // Set temperature for better accuracy
                formData.append("temperature", "0.0");
                
                // Add appropriate prompt based on chunk
                if (isChunk) {
                    formData.append("prompt", `Это часть ${chunkInfo.number} транскрипции звонка Google Meet.`);
                } else {
                    formData.append("prompt", "Это транскрипция звонка Google Meet.");
                }
                
                console.log("📋 Параметры запроса:", {
                    model: WHISPER_MODEL,
                    language,
                    fileSize: (audioBlob.size / 1024).toFixed(2) + " KB",
                    fileType: audioBlob.type,
                    chunk: isChunk ? chunkInfo.number : "N/A"
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
                        
                        // Process API response
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
                            // Handle error (existing code)
                            // ...
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
                            
                            // If this is a chunk, handle it differently
                            if (isChunk) {
                                // Store or append the chunk transcription
                                if (!chunkedTranscriptions[meetingKey]) {
                                    chunkedTranscriptions[meetingKey] = [];
                                }
                                
                                // Add this chunk
                                chunkedTranscriptions[meetingKey].push({
                                    chunkNumber: chunkInfo.number,
                                    text: result.text,
                                    timestamp: new Date().toISOString()
                                });
                                
                                console.log(`✅ Сохранен чанк #${chunkInfo.number} для ${meetingKey}, всего: ${chunkedTranscriptions[meetingKey].length} чанков`);
                                
                                // If this is the last chunk, combine all chunks and save
                                if (chunkInfo.isLast) {
                                    const combinedTranscription = combineTranscriptions(chunkedTranscriptions[meetingKey]);
                                    const filename = generateFilename(message.meetingName, true);
                                    
                                    // Save the combined transcription
                                    try {
                                        const downloadId = await saveTranscriptionToFile(combinedTranscription, filename);
                                        
                                        showNotification("Транскрибация завершена", "Полный файл сохранен как " + filename);
                                        sendResponse({ 
                                            status: "✅ Аудиофайл обработан", 
                                            transcription: result.text,
                                            filename: filename,
                                            downloadId: downloadId,
                                            isCompleted: true
                                        });
                                        
                                        // Clean up after successful save
                                        delete chunkedTranscriptions[meetingKey];
                                        return;
                                    } catch (downloadError) {
                                        console.error("❌ Ошибка при сохранении файла:", downloadError);
                                        
                                        showNotification("Текст получен, но сохранение не удалось", 
                                                      "Вы можете скачать файл через интерфейс плагина");
                                        sendResponse({ 
                                            status: "⚠️ Транскрипция получена, но сохранение не удалось", 
                                            transcription: result.text,
                                            filename: filename,
                                            error: downloadError.message
                                        });
                                        return;
                                    }
                                } else {
                                    // This is not the last chunk, just send success for this chunk
                                    const chunkFilename = generateFilename(message.meetingName, false, chunkInfo.number);
                                    
                                    // Save only the current chunk for reference
                                    try {
                                        await storeTranscriptionData(result.text, chunkFilename, false, chunkInfo.number);
                                        
                                        showNotification("Часть транскрибации готова", `Обработана часть ${chunkInfo.number}`);
                                        sendResponse({ 
                                            status: `✅ Аудиофайл (часть ${chunkInfo.number}) обработан`, 
                                            transcription: result.text,
                                            filename: chunkFilename,
                                            chunkNumber: chunkInfo.number,
                                            isCompleted: false
                                        });
                                        return;
                                    } catch (storeError) {
                                        console.error("❌ Ошибка при сохранении части:", storeError);
                                        
                                        sendResponse({ 
                                            status: `⚠️ Часть ${chunkInfo.number} обработана, но не сохранена`, 
                                            transcription: result.text,
                                            error: storeError.message
                                        });
                                        return;
                                    }
                                }
                            } else {
                                // Process a regular non-chunked transcription (existing code)
                                const filename = generateFilename(message.meetingName);
                                
                                try {
                                    const downloadId = await saveTranscriptionToFile(result.text, filename);
                                    
                                    showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                                    sendResponse({ 
                                        status: "✅ Аудиофайл обработан", 
                                        transcription: result.text,
                                        filename: filename,
                                        downloadId: downloadId
                                    });
                                    return;
                                } catch (downloadError) {
                                    console.error("❌ Ошибка при сохранении файла:", downloadError);
                                    
                                    showNotification("Текст получен, но сохранение не удалось", 
                                                  "Вы можете скачать файл через интерфейс плагина");
                                    sendResponse({ 
                                        status: "⚠️ Транскрипция получена, но сохранение не удалось", 
                                        transcription: result.text,
                                        filename: filename,
                                        error: downloadError.message
                                    });
                                    return;
                                }
                            }
                        } else {
                            console.error("⚠ Ответ получен, но текст отсутствует:", result);
                            throw new Error("Нет текста в ответе API");
                        }
                    } catch (fetchError) {
                        // Handle fetch errors (existing code)
                        // ...
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

        return true; // Important for async sendResponse
    }

    if (message.type === "combineChunks") {
        (async () => {
            try {
                const meetingKey = message.meetingKey;
                
                if (!meetingKey || !chunkedTranscriptions[meetingKey]) {
                    sendResponse({ 
                        success: false, 
                        error: "Части для объединения не найдены" 
                    });
                    return;
                }
                
                const chunks = chunkedTranscriptions[meetingKey];
                console.log(`🔄 Объединение ${chunks.length} частей для ${meetingKey}`);
                
                // Combine the chunks
                const combinedText = combineTranscriptions(chunks);
                
                // Generate a filename for the combined file
                // Extract meeting name from the key
                const meetingName = meetingKey.split('_')[0];
                const filename = generateFilename(meetingName, true);
                
                // Save the combined transcription
                try {
                    const downloadId = await saveTranscriptionToFile(combinedText, filename);
                    
                    showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                    
                    // Clean up the chunks after successful save
                    delete chunkedTranscriptions[meetingKey];
                    
                    sendResponse({ 
                        success: true, 
                        filename: filename,
                        downloadId: downloadId
                    });
                } catch (downloadError) {
                    console.error("❌ Ошибка при сохранении объединенного файла:", downloadError);
                    
                    showNotification("Текст объединен, но сохранение не удалось", 
                                  "Вы можете скачать файл через интерфейс плагина");
                    
                    // Store combined text for manual download
                    try {
                        await storeTranscriptionData(combinedText, filename, true);
                        
                        sendResponse({ 
                            success: true,
                            savedToStorage: true,
                            filename: filename,
                            error: downloadError.message
                        });
                    } catch (storeError) {
                        sendResponse({ 
                            success: false, 
                            error: "Ошибка сохранения: " + storeError.message
                        });
                    }
                }
                
            } catch (error) {
                console.error("❌ Ошибка при объединении частей:", error);
                sendResponse({ 
                    success: false, 
                    error: "Ошибка объединения: " + error.message
                });
            }
        })();
        
        return true; // Important for async sendResponse
    }

    // Add handler for getting chunks status
    if (message.type === "getChunksStatus") {
        sendResponse({
            success: true,
            hasChunks: Object.keys(chunkedTranscriptions).length > 0,
            meetings: Object.keys(chunkedTranscriptions),
            chunksCount: Object.values(chunkedTranscriptions).reduce((sum, chunks) => sum + chunks.length, 0)
        });
        
        return false; // Synchronous response
    }

    // NEW: Handle content script reinjection requests
    if (message.type === "reinjectContentScript") {
        (async () => {
            try {
                const tabId = message.tabId;
                
                if (!tabId) {
                    sendResponse({ success: false, error: "No tab ID provided" });
                    return;
                }
                
                // Check if the tab exists and is a Google Meet tab
                const tab = await chrome.tabs.get(tabId);
                if (!tab || !tab.url || !tab.url.includes("meet.google.com")) {
                    sendResponse({ success: false, error: "Not a Google Meet tab" });
                    return;
                }
                
                console.log("🔄 Attempting to reinject content script in tab", tabId);
                
                // Inject the content script
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ["src/content.js"]
                });
                
                console.log("✅ Content script reinjected successfully");
                sendResponse({ success: true });
            } catch (error) {
                console.error("❌ Failed to reinject content script:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        
        return true; // For async response
    }
});

// Add function to periodically save chunk state to storage
function saveChunksToStorage() {
    if (Object.keys(chunkedTranscriptions).length > 0) {
        console.log("💾 Saving chunks state to storage...");
        
        chrome.storage.local.set({
            transcriptionChunks: chunkedTranscriptions
        }, () => {
            if (chrome.runtime.lastError) {
                console.error("❌ Error saving chunks state:", chrome.runtime.lastError);
            } else {
                console.log("✅ Chunks state saved to storage");
            }
        });
    }
}

// Add new function to combine transcriptions
function combineTranscriptions(chunks) {
    if (!chunks || chunks.length === 0) {
        return "Транскрипция не содержит текста.";
    }
    
    // Sort chunks by number to ensure correct order
    chunks.sort((a, b) => a.chunkNumber - b.chunkNumber);
    
    let combinedText = "# Полная транскрипция звонка Google Meet\n\n";
    
    // Add timestamp for the complete transcription
    combinedText += `Дата: ${new Date().toLocaleString('ru-RU')}\n\n`;
    
    // Add each chunk with proper formatting
    chunks.forEach((chunk, index) => {
        combinedText += `## Часть ${chunk.chunkNumber}\n\n`;
        combinedText += chunk.text.trim() + "\n\n";
        
        // Add separator between chunks, except for the last one
        if (index < chunks.length - 1) {
            combinedText += "---\n\n";
        }
    });
    
    // Add footer
    combinedText += "\n[Конец транскрипции]\n";
    
    return combinedText;
}

// Modify the generateFilename function to handle chunks
function generateFilename(meetingName, isComplete = true, chunkNumber = null) {
    const date = new Date();
    const formattedDate = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const formattedTime = date.toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
    
    // Clean meeting name or use default
    const cleanName = meetingName 
        ? meetingName.replace(/[^\w\s-]/g, "").substring(0, 30).trim() 
        : "встреча";
    
    if (isComplete) {
        return `transcription_${cleanName}_${formattedDate}_${formattedTime}.txt`;
    } else {
        return `transcription_${cleanName}_part${chunkNumber}_${formattedDate}_${formattedTime}.txt`;
    }
}

// Validate and clean the transcription text before saving
function validateAndCleanTranscription(text) {
    // Check if text is valid
    if (!text || typeof text !== 'string') {
        console.error("❌ Invalid transcription text:", text);
        throw new Error("Transcription text is invalid or empty");
    }
    
    console.log(`🔍 Processing transcription: ${text.length} characters`);
    
    // Remove any non-printable characters that might corrupt the file
    const cleanedText = text.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "");
    
    // Normalize line endings (important for cross-platform compatibility)
    const normalizedText = cleanedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    
    // Warn if content has changed during cleaning
    if (normalizedText.length !== text.length) {
        console.warn(`⚠️ Transcription text was modified during cleaning: ${text.length} → ${normalizedText.length} characters`);
    }
    
    // Add a signature to detect any corruption during the download process
    const finalText = normalizedText + "\n\n[Transcription by Google Meet Transcription Plugin]";
    console.log(`✅ Final transcription: ${finalText.length} characters`);
    
    return finalText;
}

// Replace this function in background.js
async function saveTranscriptionToFile(transcription, filename) {
    console.log("💾 Creating download file:", filename);
    
    // First validate and clean the transcription text
    const validatedText = validateAndCleanTranscription(transcription);
    
    // Reset diagnostics for this download attempt
    downloadDiagnostics.reset();
    
    try {
        // First always save to storage for recovery
        await storeTranscriptionData(validatedText, filename);
        downloadDiagnostics.addAttempt("storage", true);
        
        // Method 1: Direct text file download - most reliable method
        try {
            console.log("🔄 Trying text file download method...");
            const blob = new Blob([validatedText], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            const url = URL.createObjectURL(blob);
            
            const downloadId = await new Promise((resolve, reject) => {
                chrome.downloads.download({
                    url: url,
                    filename: filename,
                    saveAs: false
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        URL.revokeObjectURL(url);
                        reject(new Error(`Download API error: ${chrome.runtime.lastError.message}`));
                    } else if (!downloadId) {
                        URL.revokeObjectURL(url);
                        reject(new Error("Download returned null ID"));
                    } else {
                        // Clean up URL after a delay
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                        resolve(downloadId);
                    }
                });
            });
            
            downloadDiagnostics.addAttempt("text_file", downloadId);
            console.log("✅ Text file download success, ID:", downloadId);
            
            // Monitor download progress
            chrome.downloads.onChanged.addListener(function onDownloadChanged(delta) {
                if (delta.id !== downloadId) return;
                
                if (delta.state?.current === 'complete') {
                    console.log(`✅ Download complete [${downloadId}]`);
                    chrome.downloads.onChanged.removeListener(onDownloadChanged);
                    showNotification("Транскрибация завершена", `Файл сохранен: ${filename}`);
                } else if (delta.error) {
                    console.error(`❌ Download error [${downloadId}]:`, delta.error.current);
                    chrome.downloads.onChanged.removeListener(onDownloadChanged);
                }
            });
            
            return downloadId;
        } catch (textFileError) {
            downloadDiagnostics.addAttempt("text_file", false, textFileError);
            console.warn("⚠️ Text file download failed, trying fallback method...");
            
            // Method 2: Try the helper tab method
            try {
                console.log("🔄 Trying download helper tab method...");
                const tabId = await createDownloadTab(validatedText, filename);
                downloadDiagnostics.addAttempt("helper_tab", tabId);
                console.log("✅ Helper tab download success, Tab ID:", tabId);
                return tabId;
            } catch (tabError) {
                downloadDiagnostics.addAttempt("helper_tab", false, tabError);
                console.warn("⚠️ Helper tab download failed, trying data URL method...");
                
                // Method 3: Data URL Method
                try {
                    console.log("🔄 Trying data URL download method...");
                    const dataUrlResult = await dataUrlDownload(validatedText, filename);
                    downloadDiagnostics.addAttempt("data_url", dataUrlResult);
                    console.log("✅ Data URL download success");
                    return dataUrlResult;
                } catch (dataUrlError) {
                    downloadDiagnostics.addAttempt("data_url", false, dataUrlError);
                    
                    // All methods failed, but we still have the data in storage
                    const summary = downloadDiagnostics.getSummary();
                    console.error("❌ All download methods failed:", summary);
                    throw new Error("All download methods failed. Data is saved and can be accessed from popup.");
                }
            }
        }
    } catch (error) {
        const summary = downloadDiagnostics.getSummary();
        console.error("❌ Critical download error:", error, "Summary:", summary);
        
        // Even if we fail, notify that the data is still accessible
        if (summary.totalAttempts > 0 && summary.methods.includes("storage") && summary.methods[0] === "storage") {
            console.log("ℹ️ Transcription was saved to storage and can still be accessed from popup");
            showNotification(
                "Текст сохранен, но скачивание не удалось", 
                "Вы можете скопировать текст из окна плагина"
            );
        }
        
        throw error;
    }
}

// Modify storeTranscriptionData to support chunks
async function storeTranscriptionData(text, filename, isComplete = true, chunkNumber = null) {
    return new Promise((resolve, reject) => {
        try {
            // First check available storage space to avoid silent failures
            chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
                const textBytes = new TextEncoder().encode(text).length;
                const totalBytes = bytesInUse + textBytes + 1000; // 1000 bytes buffer for metadata
                
                const transcriptionData = {
                    text: text,
                    filename: filename,
                    timestamp: new Date().toISOString(),
                    size: textBytes
                };
                
                // Add chunk info if applicable
                if (!isComplete && chunkNumber !== null) {
                    transcriptionData.isChunk = true;
                    transcriptionData.chunkNumber = chunkNumber;
                }
                
                chrome.storage.local.set({
                    transcription: transcriptionData,
                    diagnostics: {
                        storageInfo: {
                            bytesInUse,
                            newContentSize: textBytes,
                            timestamp: new Date().toISOString()
                        }
                    }
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.error("❌ Storage error:", chrome.runtime.lastError);
                        reject(chrome.runtime.lastError);
                    } else {
                        console.log(`✅ Transcription saved to storage: ${textBytes} bytes`);
                        resolve(true);
                    }
                });
            });
        } catch (error) {
            console.error("❌ Storage error:", error);
            reject(error);
        }
    });
}

// Direct download through chrome.downloads API with explicit encoding
async function directDownload(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            // Create blob with proper encoding - explicitly set UTF-8
            const blob = new Blob([text], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            // Create URL with explicit cleanup plan
            const url = URL.createObjectURL(blob);
            console.log("🔗 Created URL for download:", url.substring(0, 30) + "...");
            
            // Schedule cleanup of URL after 2 minutes (safety)
            const autoCleanupTimeout = setTimeout(() => {
                console.log("⏱️ Auto-cleanup of download URL");
                URL.revokeObjectURL(url);
            }, 120000);
            
            // Verify blob content before download
            const reader = new FileReader();
            reader.onload = function(e) {
                const content = e.target.result;
                const contentPreview = content.slice(0, 100) + "..." + content.slice(-100);
                console.log(`✓ Verified blob content (${content.length} chars): ${contentPreview}`);
                
                // Only proceed with download after content verification
                chrome.downloads.download({
                    url: url,
                    filename: filename,
                    saveAs: false
                }, (downloadId) => {
                    const error = chrome.runtime.lastError;
                    
                    if (error) {
                        clearTimeout(autoCleanupTimeout);
                        URL.revokeObjectURL(url);
                        console.error("❌ Download API error:", error);
                        reject(new Error(`Download API error: ${error.message}`));
                        return;
                    }
                    
                    if (!downloadId) {
                        clearTimeout(autoCleanupTimeout);
                        URL.revokeObjectURL(url);
                        console.error("❌ Download failed with null ID");
                        reject(new Error("Download returned null ID"));
                        return;
                    }
                    
                    console.log("🔄 Download starting, ID:", downloadId);
                    
                    // Monitor download progress
                    chrome.downloads.onChanged.addListener(function onDownloadChanged(delta) {
                        if (delta.id !== downloadId) return;
                        
                        console.log(`📌 Download state change [${downloadId}]:`, delta.state?.current || "N/A");
                        
                        // Check for completion or error
                        if (delta.state?.current === 'complete') {
                            console.log(`✅ Download complete [${downloadId}]`);
                            clearTimeout(autoCleanupTimeout);
                            URL.revokeObjectURL(url);
                            chrome.downloads.onChanged.removeListener(onDownloadChanged);
                            showNotification("Транскрибация завершена", `Файл сохранен: ${filename}`);
                        } else if (delta.error) {
                            console.error(`❌ Download error [${downloadId}]:`, delta.error.current);
                            clearTimeout(autoCleanupTimeout);
                            URL.revokeObjectURL(url);
                            chrome.downloads.onChanged.removeListener(onDownloadChanged);
                        }
                    });
                    
                    // Return success with download ID
                    resolve(downloadId);
                });
            };
            
            reader.onerror = function(e) {
                console.error("❌ Error verifying blob content:", e);
                clearTimeout(autoCleanupTimeout);
                URL.revokeObjectURL(url);
                reject(new Error("Failed to verify blob content"));
            };
            
            // Start reading the blob
            reader.readAsText(blob);
        } catch (error) {
            console.error("❌ Direct download error:", error);
            reject(error);
        }
    });
}

// Specialized text file download method
async function textFileDownload(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            console.log("📄 Creating dedicated text file for download...");
            
            // Create a TextEncoder to handle UTF-8 encoding
            const encoder = new TextEncoder();
            const encodedText = encoder.encode(text);
            
            // Create a blob with explicit type and encoding
            const blob = new Blob([encodedText], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            // Create a FileReader to verify content
            const reader = new FileReader();
            reader.onload = function() {
                const content = reader.result;
                console.log(`✓ Verified text file content (${content.length} chars)`);
                
                // Create URL from verified blob
                const url = URL.createObjectURL(blob);
                
                // Attempt direct download
                chrome.downloads.download({
                    url: url,
                    filename: filename,
                    saveAs: false
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        URL.revokeObjectURL(url);
                        reject(new Error(`Text file download error: ${chrome.runtime.lastError.message}`));
                    } else if (!downloadId) {
                        URL.revokeObjectURL(url);
                        reject(new Error("Text file download returned null ID"));
                    } else {
                        console.log("✅ Text file download started, ID:", downloadId);
                        
                        // Clean up URL after a delay
                        setTimeout(() => URL.revokeObjectURL(url), 30000);
                        
                        showNotification("Транскрибация завершена", `Файл сохранен: ${filename}`);
                        resolve(downloadId);
                    }
                });
            };
            
            reader.onerror = function() {
                reject(new Error("Failed to verify text file content"));
            };
            
            // Start reading the blob to verify content
            reader.readAsText(blob);
        } catch (error) {
            console.error("❌ Text file download error:", error);
            reject(error);
        }
    });
}

// Last resort data URL download method
async function dataUrlDownload(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            console.log("🔗 Creating data URL download...");
            
            // Add BOM for UTF-8
            const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
            const textEncoder = new TextEncoder();
            const encodedText = textEncoder.encode(text);
            
            // Combine BOM and text
            const combinedArray = new Uint8Array(BOM.length + encodedText.length);
            combinedArray.set(BOM);
            combinedArray.set(encodedText, BOM.length);
            
            // Create blob from combined array
            const blob = new Blob([combinedArray], { 
                type: 'text/plain;charset=utf-8' 
            });
            
            // Convert to data URL
            const reader = new FileReader();
            reader.onload = function() {
                const dataUrl = reader.result;
                
                // Attempt download through downloads API
                chrome.downloads.download({
                    url: dataUrl,
                    filename: filename,
                    saveAs: false
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        console.error("❌ Data URL download error:", chrome.runtime.lastError);
                        reject(new Error(`Data URL download error: ${chrome.runtime.lastError.message}`));
                    } else if (!downloadId) {
                        console.error("❌ Data URL download failed (null ID)");
                        reject(new Error("Data URL download returned null ID"));
                    } else {
                        console.log("✅ Data URL download started, ID:", downloadId);
                        showNotification("Транскрибация завершена", `Файл сохранен: ${filename}`);
                        resolve(downloadId);
                    }
                });
            };
            
            reader.onerror = function(e) {
                reject(new Error("Failed to create data URL: " + e));
            };
            
            // Start reading as data URL
            reader.readAsDataURL(blob);
        } catch (error) {
            console.error("❌ Data URL download error:", error);
            reject(error);
        }
    });
}

// Create a specialized download tab
async function createDownloadTab(text, filename) {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.create({ url: 'about:blank' }, (tab) => {
                if (!tab || !tab.id) {
                    reject(new Error("Failed to create tab"));
                    return;
                }
                
                console.log("📄 Created helper tab, ID:", tab.id);
                
                // Execute script with maximum reliability
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    function: (text, name) => {
                        // Create a clean, self-contained download page
                        document.documentElement.innerHTML = `
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>Транскрипция - ${name}</title>
                            <style>
                                body {
                                    font-family: Arial, sans-serif;
                                    max-width: 800px;
                                    margin: 0 auto;
                                    padding: 20px;
                                    background-color: #f5f5f5;
                                }
                                .container {
                                    background-color: white;
                                    border-radius: 8px;
                                    padding: 20px;
                                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                                }
                                h1 {
                                    color: #1a73e8;
                                    font-size: 24px;
                                }
                                .btn {
                                    background-color: #1a73e8;
                                    color: white;
                                    border: none;
                                    padding: 10px 20px;
                                    border-radius: 4px;
                                    font-size: 16px;
                                    cursor: pointer;
                                    margin-right: 10px;
                                    margin-bottom: 10px;
                                }
                                .btn.secondary {
                                    background-color: #f8f9fa;
                                    color: #1a73e8;
                                    border: 1px solid #dadce0;
                                }
                                .btn:hover {
                                    opacity: 0.9;
                                }
                                .btn:active {
                                    opacity: 0.8;
                                }
                                .content {
                                    background-color: #f8f9fa;
                                    border-radius: 4px;
                                    padding: 15px;
                                    margin-top: 20px;
                                    max-height: 400px;
                                    overflow-y: auto;
                                    white-space: pre-wrap;
                                    font-family: monospace;
                                    font-size: 14px;
                                    line-height: 1.5;
                                }
                                .success {
                                    color: #0f9d58;
                                    font-weight: bold;
                                }
                                .footer {
                                    margin-top: 20px;
                                    color: #5f6368;
                                    font-size: 12px;
                                }
                                .status {
                                    margin-top: 10px;
                                    padding: 8px;
                                    border-radius: 4px;
                                    background-color: #e6f4ea;
                                    color: #137333;
                                    display: none;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>Google Meet Transcription</h1>
                                <p>Транскрипция звонка готова. Используйте кнопки ниже для сохранения текста.</p>
                                
                                <div>
                                    <button id="downloadBtn" class="btn">Скачать как файл</button>
                                    <button id="copyBtn" class="btn secondary">Скопировать текст</button>
                                </div>
                                
                                <div id="status" class="status"></div>
                                
                                <div class="content">${text}</div>
                                
                                <div class="footer">
                                    <p>Если у вас возникли проблемы со скачиванием, вы можете вручную скопировать текст выше.</p>
                                </div>
                            </div>
                            
                            <script>
                                // Self-contained download script
                                document.getElementById('downloadBtn').addEventListener('click', function() {
                                    try {
                                        // Method 1: Using Blob with BOM for proper UTF-8 encoding
                                        // Create BOM (Byte Order Mark) for UTF-8
                                        const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
                                        
                                        // Get the text content
                                        const textContent = '${text.replace(/'/g, "\\'")}';
                                        
                                        // Encode text as UTF-8
                                        const textEncoder = new TextEncoder();
                                        const encodedText = textEncoder.encode(textContent);
                                        
                                        // Combine BOM and encoded text
                                        const combinedArray = new Uint8Array(BOM.length + encodedText.length);
                                        combinedArray.set(BOM);
                                        combinedArray.set(encodedText, BOM.length);
                                        
                                        // Create blob from combined array
                                        const blob = new Blob([combinedArray], { 
                                            type: 'text/plain;charset=utf-8' 
                                        });
                                        
                                        const url = URL.createObjectURL(blob);
                                        
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = '${name}';
                                        a.style.display = 'none';
                                        
                                        document.body.appendChild(a);
                                        a.click();
                                        
                                        // Clean up
                                        setTimeout(function() {
                                            document.body.removeChild(a);
                                            URL.revokeObjectURL(url);
                                            
                                            // Show success message
                                            const status = document.getElementById('status');
                                            status.style.display = 'block';
                                            status.textContent = '✓ Файл скачивается';
                                            
                                            // Update button
                                            const btn = document.getElementById('downloadBtn');
                                            btn.textContent = '✓ Скачивание начато';
                                        }, 100);
                                    } catch (e) {
                                        console.error('Download error:', e);
                                        alert('Ошибка скачивания: ' + e.message);
                                        
                                        // Try alternate method as fallback
                                        try {
                                            // Method 2: Using data URL with encodeURIComponent (works in more browsers)
                                            const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent('${text.replace(/'/g, "\\'")}');
                                            
                                            const a = document.createElement('a');
                                            a.href = dataUrl;
                                            a.download = '${name}';
                                            a.style.display = 'none';
                                            
                                            document.body.appendChild(a);
                                            a.click();
                                            
                                            // Clean up
                                            setTimeout(function() {
                                                document.body.removeChild(a);
                                                
                                                // Show success message
                                                const status = document.getElementById('status');
                                                status.style.display = 'block';
                                                status.textContent = '✓ Файл скачивается (альтернативный метод)';
                                                
                                                // Update button
                                                const btn = document.getElementById('downloadBtn');
                                                btn.textContent = '✓ Скачивание начато';
                                            }, 100);
                                        } catch (e2) {
                                            console.error('Alternative download error:', e2);
                                            alert('Не удалось скачать файл. Пожалуйста, скопируйте текст вручную.');
                                        }
                                    }
                                });
                                
                                // Copy button handler with proper encoding
                                document.getElementById('copyBtn').addEventListener('click', function() {
                                    try {
                                        // Method 1: Modern clipboard API
                                        navigator.clipboard.writeText('${text.replace(/'/g, "\\'")}')
                                            .then(function() {
                                                // Show success message
                                                const status = document.getElementById('status');
                                                status.style.display = 'block';
                                                status.textContent = '✓ Текст скопирован в буфер обмена';
                                                
                                                // Update button
                                                const btn = document.getElementById('copyBtn');
                                                btn.textContent = '✓ Скопировано';
                                                
                                                // Reset after delay
                                                setTimeout(function() {
                                                    btn.textContent = 'Скопировать текст';
                                                }, 2000);
                                            })
                                            .catch(function(err) {
                                                // Fallback for clipboard API failure
                                                console.error('Clipboard API error:', err);
                                                fallbackCopy();
                                            });
                                    } catch (e) {
                                        console.error('Copy error:', e);
                                        fallbackCopy();
                                    }
                                    
                                    // Fallback copy method
                                    function fallbackCopy() {
                                        try {
                                            const textarea = document.createElement('textarea');
                                            textarea.value = '${text.replace(/'/g, "\\'")}';
                                            textarea.style.position = 'fixed';
                                            textarea.style.opacity = '0';
                                            
                                            document.body.appendChild(textarea);
                                            textarea.focus();
                                            textarea.select();
                                            
                                            const successful = document.execCommand('copy');
                                            document.body.removeChild(textarea);
                                            
                                            if (successful) {
                                                // Show success message
                                                const status = document.getElementById('status');
                                                status.style.display = 'block';
                                                status.textContent = '✓ Текст скопирован в буфер обмена';
                                                
                                                // Update button
                                                const btn = document.getElementById('copyBtn');
                                                btn.textContent = '✓ Скопировано';
                                                
                                                // Reset after delay
                                                setTimeout(function() {
                                                    btn.textContent = 'Скопировать текст';
                                                }, 2000);
                                            } else {
                                                throw new Error('execCommand returned false');
                                            }
                                        } catch (e) {
                                            console.error('Fallback copy error:', e);
                                            alert('Не удалось скопировать текст. Пожалуйста, выделите его вручную и скопируйте (Ctrl+C).');
                                        }
                                    }
                                });
                            </script>
                        </body>
                        </html>
                        `;
                    },
                    args: [text, filename]
                }, (results) => {
                    if (chrome.runtime.lastError) {
                        console.error("❌ Script injection error:", chrome.runtime.lastError);
                        reject(new Error(`Script injection error: ${chrome.runtime.lastError.message}`));
                    } else if (!results || results.length === 0) {
                        console.error("❌ Script execution failed with empty results");
                        reject(new Error("Script execution failed with empty results"));
                    } else {
                        console.log("✅ Download page created successfully");
                        showNotification(
                            "Транскрибация готова", 
                            "Открыта страница для скачивания файла"
                        );
                        resolve(tab.id);
                    }
                });
            });
        } catch (error) {
            console.error("❌ Tab creation error:", error);
            reject(error);
        }
    });
}

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
                        
                        try {
                            const downloadId = await saveTranscriptionToFile(result.text, filename);
                            
                            showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                            sendResponse({ 
                                status: "✅ Аудиофайл обработан", 
                                transcription: result.text,
                                filename: filename,
                                downloadId: downloadId
                            });
                        } catch (downloadError) {
                            console.error("❌ Ошибка при сохранении файла:", downloadError);
                            
                            // Return success with error info about download
                            showNotification("Текст получен, но сохранение не удалось", 
                                          "Вы можете скачать файл через интерфейс плагина");
                            sendResponse({ 
                                status: "⚠️ Транскрипция получена, но сохранение не удалось", 
                                transcription: result.text,
                                filename: filename,
                                error: downloadError.message
                            });
                        }
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
                        
                        try {
                            const downloadId = await saveTranscriptionToFile(result.text, filename);
                            
                            showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                            sendResponse({ 
                                status: "✅ Аудиофайл обработан", 
                                transcription: result.text,
                                filename: filename,
                                downloadId: downloadId
                            });
                        } catch (downloadError) {
                            console.error("❌ Ошибка при сохранении файла:", downloadError);
                            
                            // Return success with error info about download
                            showNotification("Текст получен, но сохранение не удалось", 
                                          "Вы можете скачать файл через интерфейс плагина");
                            sendResponse({ 
                                status: "⚠️ Транскрипция получена, но сохранение не удалось", 
                                transcription: result.text,
                                filename: filename,
                                error: downloadError.message
                            });
                        }
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
                        
                        try {
                            const downloadId = await saveTranscriptionToFile(result.text, filename);
                            
                            showNotification("Транскрибация завершена", "Файл сохранен как " + filename);
                            sendResponse({ 
                                status: "✅ Аудиофайл обработан", 
                                transcription: result.text,
                                filename: filename,
                                downloadId: downloadId
                            });
                        } catch (downloadError) {
                            console.error("❌ Ошибка при сохранении файла:", downloadError);
                            
                            // Return success with error info about download
                            showNotification("Текст получен, но сохранение не удалось", 
                                          "Вы можете скачать файл через интерфейс плагина");
                            sendResponse({ 
                                status: "⚠️ Транскрипция получена, но сохранение не удалось", 
                                transcription: result.text,
                                filename: filename,
                                error: downloadError.message
                            });
                        }
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

// Improved message handler for download-related requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "redownloadTranscription") {
        (async () => {
            console.log("📥 Received transcription redownload request");
            
            // Reset diagnostics for this operation
            downloadDiagnostics.reset();
            
            try {
                // Get stored transcription
                const result = await new Promise((resolve) => {
                    chrome.storage.local.get(['transcription'], (data) => {
                        if (chrome.runtime.lastError) {
                            throw new Error(`Storage error: ${chrome.runtime.lastError.message}`);
                        }
                        resolve(data);
                    });
                });
                
                if (!result || !result.transcription || !result.transcription.text) {
                    console.error("❌ No saved transcription found");
                    sendResponse({ success: false, error: "Нет сохраненной транскрипции" });
                    return;
                }
                
                // Log retrieval success
                downloadDiagnostics.addAttempt("storage_retrieve", true);
                console.log("✅ Retrieved transcription from storage:", 
                            `${result.transcription.text.length} chars,`,
                            `Filename: ${result.transcription.filename}`);
                
                const { text, filename } = result.transcription;
                
                // Try all download methods
                try {
                    // First show a confirmation message to let user know something is happening
                    sendResponse({ 
                        message: "Начинаем скачивание...", 
                        inProgress: true 
                    });
                    
                    // Try download with save dialog
                    console.log("🔄 Trying download with save dialog...");
                    const downloadResult = await saveTranscriptionToFile(text, filename);
                    
                    sendResponse({ 
                        success: true, 
                        result: downloadResult,
                        message: "Скачивание началось"
                    });
                } catch (error) {
                    console.error("❌ All download methods failed:", error);
                    
                    // Get detailed diagnostic info
                    const diagInfo = downloadDiagnostics.getSummary();
                    
                    sendResponse({ 
                        success: false, 
                        error: "Не удалось скачать файл: " + error.message,
                        diagnostics: diagInfo,
                        fallbackText: text,  // Send the text back so popup can try to handle it
                        fallbackFilename: filename
                    });
                }
            } catch (error) {
                console.error("❌ Critical error in redownload:", error);
                sendResponse({ 
                    success: false, 
                    error: "Критическая ошибка: " + error.message
                });
            }
        })();
        
        return true; // Important for async sendResponse
    }
    
    // Direct download request handler
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
                
                // Temporary response to improve perceived performance
                sendResponse({ 
                    inProgress: true, 
                    message: "Начинаем скачивание..." 
                });
                
                console.log(`📥 Direct download request: ${message.filename}, ${message.text.length} chars`);
                
                // Try the download with all available methods
                try {
                    const result = await saveTranscriptionToFile(
                        message.text, 
                        message.filename
                    );
                    
                    // Send success response
                    chrome.runtime.sendMessage({
                        type: "downloadResult",
                        success: true,
                        result: result,
                        message: "Скачивание началось"
                    });
                } catch (error) {
                    console.error("❌ Download failed:", error);
                    
                    // Send failure response
                    chrome.runtime.sendMessage({
                        type: "downloadResult",
                        success: false,
                        error: error.message,
                        diagnostics: downloadDiagnostics.getSummary()
                    });
                }
            } catch (error) {
                console.error("❌ Critical error in download handler:", error);
                
                // Send error response
                chrome.runtime.sendMessage({
                    type: "downloadResult",
                    success: false,
                    error: "Критическая ошибка: " + error.message
                });
            }
        })();
        
        return true; // Important for async sendResponse
    }
    
    // Add this to your existing message listeners
    if (message.type === "getDiagnostics") {
        sendResponse({
            downloadDiagnostics: downloadDiagnostics.getSummary(),
            lastError: downloadDiagnostics.lastError ? 
                       (downloadDiagnostics.lastError.message || String(downloadDiagnostics.lastError)) : 
                       null,
            permissions: {
                downloads: typeof chrome.downloads !== 'undefined',
                tabs: typeof chrome.tabs !== 'undefined',
                scripting: typeof chrome.scripting !== 'undefined',
                storage: typeof chrome.storage !== 'undefined'
            }
        });
        return false; // Synchronous response
    }
});

// Generic notification function
function showNotification(title, message) {
    if (typeof chrome.notifications !== 'undefined' && chrome.notifications.create) {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: '../images/icon128.png', // Update path to your extension icon
            title: title,
            message: message
        });
    } else {
        console.log(`🔔 NOTIFICATION: ${title} - ${message}`);
    }
}


// Load chunks from storage on startup
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.get(['transcriptionChunks'], (result) => {
        if (result.transcriptionChunks) {
            Object.assign(chunkedTranscriptions, result.transcriptionChunks);
            console.log("📂 Loaded chunks from storage:", Object.keys(chunkedTranscriptions).length, "meetings");
        }
    });
});
