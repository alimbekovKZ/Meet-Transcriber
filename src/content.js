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

// Запуск записи (обновленная версия с кэшированием потока)
async function startRecording() {
    console.log("🎙 Запуск записи...");
    
    if (isRecording) {
        console.log("⚠️ Запись уже идет");
        return;
    }

    try {
        // Используем кэшированный поток, если он есть
        let stream = cachedAudioStream;
        
        // Если нет кэшированного потока, получаем новый
        if (!stream) {
            stream = await getAudioStream();
            
            if (!stream) {
                console.error("❌ Не удалось получить аудиопоток");
                return;
            }
            
            // Кэшируем поток для будущего использования
            cachedAudioStream = stream;
        } else {
            console.log("🔄 Используем кэшированный аудиопоток");
        }

        // Сбрасываем аудио-чанки
        audioChunks = [];
        
        // Создаем MediaRecorder с оптимальным форматом
        let options = { mimeType: 'audio/webm;codecs=opus' };
        
        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("⚠️ WebM Opus не поддерживается, пробуем другие форматы");
            
            // Пробуем альтернативные форматы
            const mimeTypes = [
                'audio/webm',
                'audio/mp4',
                'audio/ogg',
                'audio/wav',
                '' // Пустая строка = браузерный формат по умолчанию
            ];
            
            for (let type of mimeTypes) {
                try {
                    options = type ? { mimeType: type } : {};
                    mediaRecorder = new MediaRecorder(stream, options);
                    console.log(`✅ Используем формат: ${mediaRecorder.mimeType}`);
                    break;
                } catch (e) {
                    console.warn(`⚠️ Формат ${type} не поддерживается`);
                }
            }
        }
        
        if (!mediaRecorder) {
            console.error("❌ Не удалось создать MediaRecorder с поддерживаемым форматом");
            return;
        }
        
        // Обработка аудио-данных
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        // Запускаем запись с меньшими чанками для лучшей надежности
        mediaRecorder.start(500); // 500ms чанки
        isRecording = true;
        
        console.log("▶ Запись началась! Формат:", mediaRecorder.mimeType);
        
        // Показываем индикатор записи
        showRecordingIndicator();
        
        // Отправляем сообщение в фоновый скрипт о начале записи
        chrome.runtime.sendMessage({
            type: "recordingStatus",
            status: "started"
        });
    } catch (error) {
        console.error("❌ Ошибка при запуске записи:", error);
    }
}

// Получение аудио-потока с кэшированием и улучшенной обработкой разрешений
async function getAudioStream() {
    console.log("🎧 Перехват аудио: запрашиваем доступ...");

    try {
        // Вариант 1: пытаемся получить аудио через захват экрана (системные звуки)
        try {
            console.log("🖥️ Запрашиваем доступ к захвату экрана для системного звука...");
            
            // Этот API требует пользовательского взаимодействия
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "never",
                    displaySurface: "browser"
                },
                audio: true,
                systemAudio: "include" // Явно запрашиваем системный звук
            });
            
            // Проверяем, что получили аудиотреки
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                console.log("✅ Аудиопоток получен через getDisplayMedia:", audioTracks.length, "треков");
                
                // Останавливаем видеотреки, нам нужен только звук
                displayStream.getVideoTracks().forEach(track => track.stop());
                
                // Выводим настройки для диагностики
                console.log("🔊 Настройки аудиотрека:", audioTracks[0].getSettings());
                
                // Создаем новый поток только с аудио
                const audioStream = new MediaStream(audioTracks);
                
                // Сохраняем тип аудио для последующего использования
                window.audioSource = "system";
                
                // Показываем успешное уведомление
                showNotification(
                    "Запись звука системы",
                    "Используется аудио из системы (оптимально для транскрибации)",
                    "success"
                );
                
                return audioStream;
            }
            
            // Если нет аудиотреков, останавливаем все треки
            displayStream.getTracks().forEach(track => track.stop());
            console.log("⚠️ getDisplayMedia не предоставил аудиотреки");
        } catch (err) {
            console.warn("⚠️ Не удалось получить аудио через getDisplayMedia:", err.message);
            // Пользователь отказался или произошла ошибка, продолжаем с микрофоном
        }
        
        // Вариант 2: используем микрофон как запасной вариант
        console.log("🎤 Пробуем получить аудио с микрофона...");
        
        // Показываем уведомление о переключении на микрофон
        showNotification(
            "Используем микрофон",
            "Системный звук недоступен, записываем звук с микрофона",
            "warning"
        );
        
        const micStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000,
                channelCount: 1  // Моно лучше для распознавания речи
            } 
        });
        
        const audioTracks = micStream.getAudioTracks();
        if (audioTracks.length > 0) {
            console.log("🎤 Настройки микрофона:", audioTracks[0].getSettings());
            window.audioSource = "microphone"; // Сохраняем тип аудио
        }
        
        console.log("✅ Аудиопоток получен с микрофона");
        return micStream;
    } catch (err) {
        console.error("❌ Не удалось получить аудиопоток:", err);
        
        // Показываем уведомление об ошибке
        showNotification(
            "Ошибка доступа к аудио", 
            "Не удалось получить доступ к аудио. Проверьте разрешения браузера.",
            "error"
        );
        
        return null;
    }
}

// Остановка записи (с безопасным освобождением ресурсов)
async function stopRecording() {
    console.log("🛑 Остановка записи...");

    if (!isRecording || !mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("⚠️ Запись не активна, нечего останавливать");
        return;
    }

    // Меняем состояние записи
    isRecording = false;
    
    // Скрываем индикатор записи
    hideRecordingIndicator();
    
    // Создаем промис для обработки события остановки
    const stopPromise = new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
            try {
                if (audioChunks.length === 0) {
                    throw new Error("Нет данных аудиозаписи");
                }
                
                console.log(`📊 Собрано ${audioChunks.length} аудио-чанков`);
                
                // Собираем аудио-чанки в блоб
                const audioBlob = new Blob(audioChunks);
                console.log("💾 Аудио-файл сформирован:", audioBlob.size, "байт");
                
                // Преобразуем в ArrayBuffer для отправки
                const reader = new FileReader();
                reader.readAsArrayBuffer(audioBlob);
                reader.onloadend = function() {
                    const arrayBuffer = reader.result;
                    
                    // Отправляем аудиоданные в background script
                    chrome.runtime.sendMessage({
                        type: "processRawAudio",
                        audioData: Array.from(new Uint8Array(arrayBuffer)),
                        meetingName: window.meetingName || "Unknown Meeting"
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("❌ Ошибка отправки сообщения:", chrome.runtime.lastError.message);
                            
                            // Показываем уведомление об ошибке
                            showNotification(
                                "Ошибка обработки", 
                                "Не удалось отправить аудио на обработку: " + chrome.runtime.lastError.message,
                                "error"
                            );
                        } else {
                            console.log("✅ Ответ от background.js:", response);
                            
                            // Показываем уведомление об успешной отправке
                            showNotification(
                                "Аудио отправлено", 
                                "Файл отправлен на транскрибацию",
                                "success"
                            );
                        }
                    });
                };
            } catch (error) {
                console.error("❌ Ошибка при обработке аудио:", error);
                
                // Показываем уведомление об ошибке
                showNotification(
                    "Ошибка обработки", 
                    "Не удалось обработать аудио: " + error.message,
                    "error"
                );
            } finally {
                // НЕ освобождаем треки, чтобы сохранить разрешения
                // Но останавливаем запись
                resolve();
            }
        };
    });
    
    // Останавливаем запись
    mediaRecorder.stop();
    
    // Отправляем сообщение в background script
    chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "stopped"
    });
    
    // Ждем завершения обработки
    await stopPromise;
    console.log("⏹ Запись остановлена и отправлена на обработку");
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

// Слушаем сообщения от popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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