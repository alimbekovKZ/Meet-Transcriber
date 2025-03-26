// Глобальные переменные
let audioContext;
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let meetingObserver = null;
let autoTranscriptionEnabled = true;
let hasRequestedPermission = false;  // Отслеживаем, запрашивали ли мы уже разрешение
let cachedAudioStream = null;        // Кэшируем полученный поток
let meetDetected = false;            // Флаг обнаружения конференции

// Add these variables to the global scope in content.js
let chunkDuration = 15 * 60 * 1000; // 15 minutes per chunk in milliseconds
let currentChunkStartTime = 0;
let chunkCounter = 0;
let chunkTimer = null;
let isProcessingChunk = false;

// Инициализация при загрузке страницы
window.addEventListener('load', () => {
    // Проверяем, находимся ли мы на странице Google Meet
    if (window.location.href.includes('meet.google.com')) {
        console.log("🔍 Обнаружена страница Google Meet");
        
        // Проверяем настройки автотранскрибации
        chrome.storage.local.get(['autoTranscription'], (result) => {
            if (result.hasOwnProperty('autoTranscription')) {
                autoTranscriptionEnabled = result.autoTranscription;
            }
            
            // Инициализируем обнаружение конференции только после получения настроек
            if (autoTranscriptionEnabled) {
                initializeMeetDetection();
            } else {
                console.log("📌 Автотранскрибация отключена в настройках");
            }
        });
    }
});

// Инициализация обнаружения конференции
function initializeMeetDetection() {
    if (meetingObserver) {
        console.log("⚠️ MeetingObserver уже инициализирован, пропускаем повторную инициализацию");
        return;
    }
    
    console.log("🔍 Инициализация обнаружения звонка");
    
    // Создаем MutationObserver с дебаунсингом для предотвращения частых срабатываний
    let debounceTimeout = null;
    
    meetingObserver = new MutationObserver((mutations) => {
        // Предотвращаем частые вызовы с помощью debounce
        if (debounceTimeout) clearTimeout(debounceTimeout);
        
        debounceTimeout = setTimeout(() => {
            // Проверяем только если мы еще не обнаружили звонок
            if (!meetDetected) {
                checkForActiveMeeting();
            }
        }, 1000); // Задержка 1 секунда
    });
    
    // Начинаем наблюдение за изменениями в DOM
    meetingObserver.observe(document.body, { childList: true, subtree: true });
    
    // Также проверяем текущее состояние (возможно, мы уже в звонке)
    checkForActiveMeeting();
    
    // Обрабатываем выгрузку страницы
    window.addEventListener('beforeunload', () => {
        cleanupResources();
    });
}

// Проверка наличия активной конференции
function checkForActiveMeeting() {
    // Проверяем наличие индикаторов активного звонка
    const callStarted = 
        document.querySelector('[data-call-started]') || 
        document.querySelector('[data-meeting-active]') ||
        document.querySelectorAll('video').length > 0 ||
        document.querySelector('.r6xAKc') !== null;
    
    // Если обнаружен звонок и автотранскрибация включена
    if (callStarted && !meetDetected && autoTranscriptionEnabled && !isRecording && !hasRequestedPermission) {
        meetDetected = true;
        console.log("🎉 Обнаружен активный звонок в Google Meet");
        
        // Получаем название встречи для последующего использования
        const meetingNameElement = document.querySelector('[data-meeting-title]') || 
                                 document.querySelector('.r6xAKc');
        if (meetingNameElement) {
            window.meetingName = meetingNameElement.textContent.trim();
            console.log(`📝 Название конференции: ${window.meetingName}`);
        }
        
        // Показываем уведомление о возможности записи, но НЕ запрашиваем доступ автоматически
        showPermissionPrompt();
    }
}

// Показываем уведомление с предложением начать запись
function showPermissionPrompt() {
    console.log("🔔 Показываем запрос разрешения на запись");
    
    // Создаем блок уведомления
    const promptBox = document.createElement('div');
    promptBox.id = 'gtm-permission-prompt';
    promptBox.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background-color: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        padding: 16px;
        width: 300px;
        z-index: 10000;
        font-family: 'Google Sans', Roboto, Arial, sans-serif;
    `;
    
    promptBox.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
            <div style="width: 24px; height: 24px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
            </div>
            <div style="font-weight: 500; color: #202124; font-size: 16px;">Google Meet Transcription</div>
        </div>
        <p style="margin: 0 0 12px 0; color: #5f6368; font-size: 14px;">
            Обнаружен активный звонок. Хотите начать транскрибацию?
        </p>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button id="gtm-prompt-later" style="background: none; border: none; color: #5f6368; font-family: inherit; font-size: 14px; padding: 8px; cursor: pointer; border-radius: 4px;">
                Позже
            </button>
            <button id="gtm-prompt-never" style="background: none; border: none; color: #5f6368; font-family: inherit; font-size: 14px; padding: 8px; cursor: pointer; border-radius: 4px;">
                Не записывать
            </button>
            <button id="gtm-prompt-start" style="background: #1a73e8; border: none; color: white; font-family: inherit; font-size: 14px; padding: 8px 16px; cursor: pointer; border-radius: 4px;">
                Начать запись
            </button>
        </div>
    `;
    
    // Добавляем на страницу
    document.body.appendChild(promptBox);
    
    // Обработчик кнопки "Начать запись"
    document.getElementById('gtm-prompt-start').addEventListener('click', () => {
        promptBox.remove();
        // Отмечаем, что разрешение запрошено, чтобы не показывать повторно
        hasRequestedPermission = true;
        // Запускаем запись с явным взаимодействием пользователя
        startRecording();
    });
    
    // Обработчик кнопки "Позже"
    document.getElementById('gtm-prompt-later').addEventListener('click', () => {
        promptBox.remove();
    });
    
    // Обработчик кнопки "Не записывать"
    document.getElementById('gtm-prompt-never').addEventListener('click', () => {
        promptBox.remove();
        disableAutoTranscription();
    });
    
    // Скрываем через 30 секунд, если пользователь не среагировал
    setTimeout(() => {
        if (document.getElementById('gtm-permission-prompt')) {
            promptBox.remove();
        }
    }, 30000);
}

// Replace the startRecording function in content.js with this improved version
async function startRecording() {
    console.log("🎙 Запуск записи...");
    
    if (isRecording) {
        console.log("⚠️ Запись уже идет");
        return;
    }

    try {
        // Get audio stream (existing code remains the same)
        let stream = await getAudioStream();
        
        if (!stream) {
            console.error("❌ Не удалось получить аудиопоток");
            showNotification(
                "Ошибка записи", 
                "Не удалось получить аудиопоток. Проверьте разрешения браузера.",
                "error"
            );
            return;
        }
        
        // Cache the successful stream for future use
        cachedAudioStream = stream;

        // Reset audio chunks and chunk counter
        audioChunks = [];
        chunkCounter = 0;
        currentChunkStartTime = Date.now();
        
        // Create MediaRecorder with optimal format (existing code)
        let options = { mimeType: 'audio/webm;codecs=opus' };
        
        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            // Fallback code for other formats (existing code)
            // ...
        }
        
        if (!mediaRecorder) {
            console.error("❌ Не удалось создать MediaRecorder с поддерживаемым форматом");
            showNotification(
                "Ошибка записи", 
                "Не поддерживаемый формат аудио в вашем браузере.",
                "error"
            );
            return;
        }
        
        // Handle audio data
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
                console.log(`📊 Получен аудио-чанк: ${event.data.size} байт, всего: ${audioChunks.length} чанков`);
                
                // Monitor total size of audioChunks to prevent memory issues
                if (getTotalChunkSize() > 20 * 1024 * 1024) { // 20MB threshold
                    console.log("⚠️ Достигнут предел размера аудио. Начинаем обработку.");
                    processCurrentChunk(false);
                }
            }
        };

        // Start recording with smaller chunks for better reliability
        mediaRecorder.start(500); // 500ms chunks
        isRecording = true;
        
        console.log("▶ Запись началась! Формат:", mediaRecorder.mimeType);
        
        // Show recording indicator
        showRecordingIndicator();
        
        // Set up timer for periodic chunk processing
        setupChunkTimer();
        
        // Send message to background script about starting recording
        chrome.runtime.sendMessage({
            type: "recordingStatus",
            status: "started"
        });
    } catch (error) {
        console.error("❌ Ошибка при запуске записи:", error);
        showNotification(
            "Ошибка записи", 
            `Не удалось запустить запись: ${error.message}`,
            "error"
        );
    }
}

// Add new function to get total size of chunks
function getTotalChunkSize() {
    return audioChunks.reduce((total, chunk) => total + chunk.size, 0);
}

// Add new function to set up chunk timer
function setupChunkTimer() {
    // Clear existing timer if any
    if (chunkTimer) {
        clearTimeout(chunkTimer);
    }
    
    // Set new timer for chunk processing
    chunkTimer = setTimeout(() => {
        if (isRecording && audioChunks.length > 0) {
            console.log("⏰ Таймер чанка сработал. Обрабатываем текущий аудио фрагмент.");
            processCurrentChunk(true);
        }
    }, chunkDuration);
}

// Add new function to process current chunk
async function processCurrentChunk(continueRecording) {
    // Prevent multiple simultaneous processing
    if (isProcessingChunk) {
        console.log("⚠️ Обработка предыдущего чанка ещё не завершена. Пропускаем.");
        return;
    }
    
    isProcessingChunk = true;
    
    try {
        // Pause recording if needed
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.pause();
            console.log("⏸ Запись приостановлена для обработки чанка");
        }
        
        // Create a local copy of current chunks
        const chunksToProcess = [...audioChunks]; 
        
        // Clear the global array to collect new chunks
        audioChunks = [];
        
        // Calculate duration of the chunk
        const chunkDurationSeconds = Math.floor((Date.now() - currentChunkStartTime) / 1000);
        chunkCounter++;
        
        // Update start time for the next chunk
        currentChunkStartTime = Date.now();
        
        console.log(`📦 Обработка чанка #${chunkCounter}, длительность: ${chunkDurationSeconds} сек, размер: ${chunksToProcess.reduce((total, chunk) => total + chunk.size, 0) / 1024} KB`);
        
        // Show notification
        showNotification(
            "Обработка аудио", 
            `Обрабатываем часть ${chunkCounter} записи...`,
            "info"
        );
        
        // Convert to blob
        const audioBlob = new Blob(chunksToProcess, {
            type: mediaRecorder?.mimeType || 'audio/webm'
        });
        
        // Convert to base64 for sending
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = function() {
            const base64data = reader.result;
            
            // Send to background script with chunk info
            chrome.runtime.sendMessage({
                type: "sendAudioToWhisper",
                file: base64data,
                meetingName: window.meetingName || "Unknown Meeting",
                chunkInfo: {
                    number: chunkCounter,
                    duration: chunkDurationSeconds,
                    isLast: !continueRecording
                }
            }, (response) => {
                isProcessingChunk = false;
                
                if (chrome.runtime.lastError) {
                    console.error("❌ Error sending chunk:", chrome.runtime.lastError.message);
                    showNotification(
                        "Ошибка обработки", 
                        "Не удалось отправить аудио на обработку: " + chrome.runtime.lastError.message,
                        "error"
                    );
                } else {
                    console.log("✅ Chunk processed:", response);
                    
                    if (response.status.includes("✅")) {
                        // Show success notification
                        showNotification(
                            `Часть ${chunkCounter} обработана`, 
                            response.filename ? `Файл: ${response.filename}` : "Файл сохранен",
                            "success"
                        );
                    } else {
                        // Show warning/error notification
                        showNotification(
                            "Проблема обработки", 
                            response.status + (response.error ? `: ${response.error}` : ""),
                            response.error ? "error" : "warning"
                        );
                    }
                }
                
                // Resume recording if we should continue
                if (continueRecording && mediaRecorder && mediaRecorder.state === "paused") {
                    mediaRecorder.resume();
                    console.log("▶ Запись возобновлена");
                    
                    // Set up the next chunk timer
                    setupChunkTimer();
                }
            });
        };
    } catch (error) {
        console.error("❌ Error processing chunk:", error);
        isProcessingChunk = false;
        
        // Resume recording if we should continue
        if (continueRecording && mediaRecorder && mediaRecorder.state === "paused") {
            mediaRecorder.resume();
            console.log("▶ Запись возобновлена (после ошибки)");
            
            // Set up the next chunk timer
            setupChunkTimer();
        }
    }
}

// And replace the getAudioStream function with this improved version
async function getAudioStream() {
    console.log("🎧 Перехват аудио: запрашиваем доступ...");

    try {
        // Method 1: Try to get audio through screen capture (system sounds)
        try {
            console.log("🖥️ Запрашиваем доступ к захвату экрана для системного звука...");
            
            // Chrome requires explicit user interaction for getDisplayMedia
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "never",
                    displaySurface: "monitor"
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false
                },
                selfBrowserSurface: "exclude",
                systemAudio: "include"
            });
            
            // Check if we got audio tracks
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                console.log("✅ Audio stream obtained via getDisplayMedia:", audioTracks.length, "tracks");
                
                // Stop video tracks, we only need audio
                displayStream.getVideoTracks().forEach(track => {
                    track.stop();
                    displayStream.removeTrack(track);
                });
                
                // Create a new stream with audio only
                const audioOnlyStream = new MediaStream(audioTracks);
                
                // Store source type for user information
                window.audioSource = "system";
                
                console.log("🔈 System audio stream successfully obtained");
                return audioOnlyStream;
            } else {
                console.warn("⚠️ getDisplayMedia didn't provide audio tracks");
                
                // Release resources if no audio tracks
                displayStream.getTracks().forEach(track => track.stop());
                throw new Error("Audio tracks missing in stream");
            }
        } catch (err) {
            // Handle specific error types for better UX
            if (err.name === 'NotAllowedError') {
                console.warn("⚠️ User denied access to screen capture:", err.message);
            } else {
                console.warn("⚠️ Failed to get audio via getDisplayMedia:", err.name, err.message);
            }
            
            // Continue execution and try fallback method
        }
        
        // Method 2: Fallback - use microphone
        console.log("🎤 Requesting microphone access...");
        
        const micStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000,
                channelCount: 1
            } 
        });
        
        if (!micStream) {
            throw new Error("Failed to get microphone access");
        }
        
        const audioTracks = micStream.getAudioTracks();
        if (audioTracks.length > 0) {
            // Store source type for user information
            window.audioSource = "microphone";
            
            console.log("✅ Audio stream successfully obtained from microphone");
            return micStream;
        } else {
            throw new Error("Audio tracks missing in microphone stream");
        }
    } catch (err) {
        console.error("❌ Critical error getting audio stream:", err.name, err.message);
        
        // Send error info to background script
        chrome.runtime.sendMessage({
            type: "recordingError",
            error: {
                name: err.name,
                message: err.message,
                timestamp: new Date().toISOString()
            }
        });
        
        return null;
    }
}

// Обработчик ошибок getUserMedia для лучшей диагностики
function handleUserMediaError(error) {
    let errorMessage = "Ошибка доступа к микрофону";
    let errorType = "mic_error";
    
    // Диагностика типа ошибки на основе стандартных DOMException
    switch (error.name) {
        case 'NotAllowedError':
            errorMessage = "Доступ к микрофону запрещен пользователем";
            errorType = "permission_denied";
            break;
        case 'NotFoundError':
            errorMessage = "Микрофон не найден или не подключен";
            errorType = "device_not_found";
            break;
        case 'NotReadableError':
        case 'AbortError':
            errorMessage = "Микрофон занят другим приложением";
            errorType = "device_busy";
            break;
        case 'OverconstrainedError':
            errorMessage = "Не найден микрофон, соответствующий требованиям";
            errorType = "constraints_error";
            break;
        case 'SecurityError':
            errorMessage = "Доступ запрещен по соображениям безопасности";
            errorType = "security_error";
            break;
        case 'TypeError':
            errorMessage = "Некорректные параметры запроса";
            errorType = "type_error";
            break;
        default:
            errorMessage = `Ошибка доступа: ${error.message || error.name}`;
            errorType = "unknown_error";
    }
    
    // Логируем для диагностики
    console.error(`❌ ${errorType}: ${errorMessage}`, error);
    
    // Отправляем в background script для учета
    chrome.runtime.sendMessage({
        type: "permissionError",
        error: {
            type: errorType,
            name: error.name,
            message: errorMessage,
            timestamp: new Date().toISOString()
        }
    });
    
    // Пробрасываем ошибку дальше после логирования
    throw error;
}

// Обработчик запроса начала записи с временным интервалом (для предотвращения частых запросов)
let lastRequestTime = 0;
let requestTimeoutId = null;

// Ожидание перед повторной попыткой
function requestWithDebounce(callback, delay = 1000) {
    const now = Date.now();
    
    // Отменяем предыдущий таймаут, если он был
    if (requestTimeoutId) {
        clearTimeout(requestTimeoutId);
    }
    
    // Проверяем интервал между запросами
    if (now - lastRequestTime < delay) {
        // Если запрос был недавно, откладываем выполнение
        requestTimeoutId = setTimeout(() => {
            lastRequestTime = Date.now();
            callback();
        }, delay);
    } else {
        // Если прошло достаточно времени, выполняем немедленно
        lastRequestTime = now;
        callback();
    }
}

// Функция для улучшенного обработчика сообщений с защитой от частых запросов
function setupImprovedMessageHandler() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "startRecording") {
            console.log("📩 Получено сообщение 'startRecording'");
            
            // Проверяем, инициировано ли пользователем
            const isUserInitiated = message.source === "userInitiated";
            
            if (isUserInitiated) {
                // Используем защиту от частых запросов
                requestWithDebounce(() => {
                    // Запускаем запись аудио с корректной обработкой ошибок
                    startRecordingWithErrorHandling()
                        .then(result => {
                            // Отправляем результат обратно в popup
                            sendResponse(result);
                        })
                        .catch(error => {
                            console.error("❌ Ошибка при запуске записи:", error);
                            sendResponse({ 
                                status: "❌ Ошибка записи",
                                error: error.message,
                                errorName: error.name
                            });
                        });
                }, 1000);
                
                // Сразу отправляем предварительный ответ
                sendResponse({ 
                    status: "⏳ Запуск записи...",
                    inProgress: true
                });
                
                return true; // Указываем, что будем отвечать асинхронно
            } else {
                console.warn("⚠️ Попытка запустить запись без действия пользователя");
                sendResponse({ 
                    status: "❌ Запись не запущена",
                    error: "userInteractionRequired"
                });
            }
        }
        
        // Обработка других сообщений
        // ...
        
        return true; // Для поддержки асинхронных ответов
    });
}

// Улучшенный запуск записи с корректной обработкой ошибок
async function startRecordingWithErrorHandling() {
    try {
        if (isRecording) {
            return { 
                status: "⚠️ Запись уже идет",
                isRecording: true
            };
        }
        
        // Получаем аудиопоток с обработкой ошибок
        const stream = await getAudioStream();
        
        if (!stream) {
            const error = new Error("Не удалось получить аудиопоток");
            error.name = "AudioStreamError";
            throw error;
        }
        
        // Сохраняем в глобальную переменную для доступа из других функций
        cachedAudioStream = stream;
        
        // Создаем и настраиваем MediaRecorder
        // ... (ваш код для создания MediaRecorder)
        
        // Начинаем запись
        isRecording = true;
        
        // Возвращаем успешный результат
        return { 
            status: "✅ Запись началась!",
            captureType: window.audioSource || "unknown",
            isRecording: true
        };
    } catch (error) {
        // Преобразуем ошибку DOMException в более понятное сообщение
        if (error instanceof DOMException) {
            switch (error.name) {
                case 'NotAllowedError':
                    throw new Error("permissionDenied");
                case 'NotFoundError':
                    throw new Error("deviceNotFound");
                case 'NotReadableError':
                    throw new Error("deviceBusy");
                default:
                    throw new Error(`${error.name}: ${error.message}`);
            }
        }
        
        // Пробрасываем ошибку дальше
        throw error;
    }
}

// Инициализируем улучшенный обработчик при загрузке страницы
window.addEventListener('load', () => {
    setupImprovedMessageHandler();
});

// Replace the stopRecording function in content.js
async function stopRecording() {
    console.log("🛑 Остановка записи...");

    if (!isRecording || !mediaRecorder) {
        console.log("⚠️ Запись не активна, нечего останавливать");
        return;
    }

    // Clear chunk timer if it exists
    if (chunkTimer) {
        clearTimeout(chunkTimer);
        chunkTimer = null;
    }

    // Change recording state
    isRecording = false;
    
    // Hide recording indicator
    hideRecordingIndicator();
    
    // If we have chunks, process them as the final chunk
    if (audioChunks.length > 0) {
        // Create promise for the final chunk processing
        const processingPromise = new Promise((resolve) => {
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
            }
            
            // Process the final chunk
            console.log("📦 Обработка финального чанка записи");
            processCurrentChunk(false);
            
            // We'll resolve after a short delay to allow the chunk to be processed
            setTimeout(resolve, 1000);
        });
        
        // Wait for processing to complete
        await processingPromise;
    } else {
        // No chunks to process, just stop the recorder
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
        }
    }
    
    // Send message to background script
    chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "stopped"
    });
    
    console.log("⏹ Recording stopped");
}

// Очистка ресурсов при выгрузке страницы
function cleanupResources() {
    console.log("🧹 Очистка ресурсов перед выгрузкой страницы");
    
    // Останавливаем наблюдатель, если он активен
    if (meetingObserver) {
        meetingObserver.disconnect();
        meetingObserver = null;
    }
    
    // Останавливаем запись, если она активна
    if (isRecording && mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
            mediaRecorder.stop();
        } catch (e) {
            console.error("❌ Ошибка при остановке записи:", e);
        }
    }
    
    // Освобождаем потоки только при выгрузке страницы
    if (cachedAudioStream) {
        cachedAudioStream.getTracks().forEach(track => track.stop());
        cachedAudioStream = null;
    }
}

// Отключение автотранскрибации для текущей встречи
function disableAutoTranscription() {
    autoTranscriptionEnabled = false;
    hasRequestedPermission = true; // Отмечаем, что пользователь уже принял решение
    
    if (isRecording) {
        stopRecording();
    }
    
    console.log("🔕 Автоматическая транскрипция отключена для текущей встречи");
    
    // Показываем уведомление
    showNotification(
        "Транскрибация отключена", 
        "Автоматическая транскрибация отключена для этой встречи",
        "info"
    );
}

// Функция для отображения индикатора записи
function showRecordingIndicator() {
    // Удаляем существующий индикатор, если он есть
    const existingIndicator = document.getElementById('gtm-recording-indicator');
    if (existingIndicator) {
        existingIndicator.remove();
    }
    
    // Создаем новый индикатор
    const indicator = document.createElement('div');
    indicator.id = 'gtm-recording-indicator';
    indicator.style.cssText = `
        position: fixed;
        top: 8px;
        left: 8px;
        background-color: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 8px 12px;
        border-radius: 16px;
        font-size: 12px;
        display: flex;
        align-items: center;
        z-index: 9999;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    `;
    
    // Добавляем пульсирующую точку и текст
    indicator.innerHTML = `
        <div style="
            width: 8px;
            height: 8px;
            background-color: #ea4335;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        "></div>
        <span>Запись активна</span>
    `;
    
    // Добавляем стили для анимации
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0% {
                box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.7);
            }
            70% {
                box-shadow: 0 0 0 6px rgba(234, 67, 53, 0);
            }
            100% {
                box-shadow: 0 0 0 0 rgba(234, 67, 53, 0);
            }
        }
    `;
    document.head.appendChild(style);
    
    // Добавляем на страницу
    document.body.appendChild(indicator);
}

// Функция для скрытия индикатора записи
function hideRecordingIndicator() {
    const indicator = document.getElementById('gtm-recording-indicator');
    if (indicator) {
        indicator.remove();
    }
}

// Функция для отображения уведомлений
function showNotification(title, message, type = "info", duration = 5000) {
    // Проверяем, существует ли контейнер для уведомлений
    let notificationContainer = document.getElementById('gtm-notification-container');
    
    if (!notificationContainer) {
        // Создаем контейнер для уведомлений
        notificationContainer = document.createElement('div');
        notificationContainer.id = 'gtm-notification-container';
        notificationContainer.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            z-index: 9999;
            width: 320px;
        `;
        document.body.appendChild(notificationContainer);
    }
    
    // Определяем цвет в зависимости от типа
    let typeColor;
    let bgColor;
    switch (type) {
        case "success":
            typeColor = "#0f9d58";
            bgColor = "#e6f4ea";
            break;
        case "warning":
            typeColor = "#f4b400";
            bgColor = "#fef7e0";
            break;
        case "error":
            typeColor = "#ea4335";
            bgColor = "#fce8e6";
            break;
        default:
            typeColor = "#1a73e8";
            bgColor = "#e8f0fe";
    }
    
    // Создаем уведомление
    const notification = document.createElement('div');
    notification.style.cssText = `
        background-color: ${bgColor};
        border-left: 4px solid ${typeColor};
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
        margin-bottom: 8px;
        overflow: hidden;
        animation: slideIn 0.3s ease-out;
    `;
    
    notification.innerHTML = `
        <div style="padding: 12px 16px;">
            <div style="display: flex; align-items: center; margin-bottom: 6px;">
                <div style="color: ${typeColor}; font-weight: 500; font-size: 14px;">
                    ${title}
                </div>
                <button class="close-btn" style="background: none; border: none; cursor: pointer; margin-left: auto; color: #5f6368; font-size: 14px;">
                    ✕
                </button>
            </div>
            <div style="color: #202124; font-size: 13px;">
                ${message}
            </div>
        </div>
    `;
    
    // Добавляем анимацию
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        
        .slide-out {
            animation: slideOut 0.3s ease-in forwards;
        }
    `;
    document.head.appendChild(style);
    
    // Добавляем уведомление в контейнер
    notificationContainer.appendChild(notification);
    
    // Настраиваем закрытие по клику на крестик
    const closeBtn = notification.querySelector('.close-btn');
    closeBtn.addEventListener('click', () => {
        notification.classList.add('slide-out');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 300);
    });
    
    // Автоматическое закрытие через указанное время
    setTimeout(() => {
        if (notification.parentNode) {
            notification.classList.add('slide-out');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }
    }, duration);
}

// Improved message listeners with ping support
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Simple ping to check if content script is available
    if (message.action === "ping") {
        console.log("📍 Received ping from popup");
        sendResponse({ status: "pong", available: true });
        return true;
    }
    
    if (message.action === "startRecording") {
        console.log("📩 Получено сообщение 'startRecording'");
        hasRequestedPermission = true; // Отмечаем, что запрос был инициирован пользователем
        startRecording();
        sendResponse({ 
            status: "✅ Запись началась!",
            captureType: window.audioSource || "system"
        });
    }
    else if (message.action === "stopRecording") {
        console.log("📩 Получено сообщение 'stopRecording'");
        stopRecording();
        sendResponse({ status: "✅ Запись остановлена!" });
    }
    else if (message.action === "disableAutoTranscription") {
        console.log("📩 Получено сообщение 'disableAutoTranscription'");
        disableAutoTranscription();
        sendResponse({ status: "✅ Автоматическая транскрипция отключена!" });
    }
    else if (message.action === "getRecordingStatus") {
        sendResponse({ 
            isRecording: isRecording,
            meetingDetected: meetDetected,
            meetingName: window.meetingName || "Unknown Meeting",
            hasRequestedPermission: hasRequestedPermission,
            audioSource: window.audioSource || "unknown"
        });
    }
    
    return true; // Важно для асинхронного sendResponse
});

// Also ensure content script is properly initialized when the page loads
console.log("🔌 Content script initialized for Google Meet");