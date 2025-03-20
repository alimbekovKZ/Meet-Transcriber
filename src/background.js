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

// Save transcription to file using FileSystem API
async function saveTranscriptionToFile(transcription, filename) {
    try {
        // Create a blob from the transcription text
        const blob = new Blob([transcription], { type: "text/plain" });
        
        // Use the File System Access API if available
        if ('showSaveFilePicker' in window) {
            console.log("💾 Используем File System Access API для сохранения");
            
            const options = {
                suggestedName: filename,
                types: [{
                    description: 'Text Files',
                    accept: { 'text/plain': ['.txt'] },
                }],
            };
            
            try {
                // Show file picker dialog
                const fileHandle = await window.showSaveFilePicker(options);
                // Create a writable stream
                const writable = await fileHandle.createWritable();
                // Write the contents
                await writable.write(blob);
                // Close the file and write the contents to disk
                await writable.close();
                
                console.log(`✅ Файл успешно сохранён через FileSystem API: ${filename}`);
                return true;
            } catch (err) {
                // If user cancels the save dialog or any other error occurs, fall back to download method
                console.warn("⚠️ Не удалось использовать FileSystem API, переключаемся на fallback метод:", err);
            }
        }
        
        // Fallback method (if FileSystem API is not available or fails)
        console.log("💾 Используем стандартный метод скачивания файла");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`✅ Файл сохранён через стандартный метод скачивания: ${filename}`);
        return true;
    } catch (error) {
        console.error("❌ Ошибка при сохранении файла:", error);
        return false;
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