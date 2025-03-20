console.log("📌 Google Meet Transcription Plugin загружен");

// Global variables
let audioContext;
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let meetingObserver = null;
let autoTranscriptionEnabled = true;

// Initialize when page loads
window.addEventListener('load', () => {
    // Check if we're on a Google Meet page
    if (window.location.href.includes('meet.google.com')) {
        console.log("🔍 Обнаружена страница Google Meet");
        initializeMeetDetection();
        
        // Check if auto-transcription is enabled in settings
        chrome.storage.local.get(['autoTranscription'], (result) => {
            if (result.hasOwnProperty('autoTranscription')) {
                autoTranscriptionEnabled = result.autoTranscription;
            }
        });
    }
});

// Initialize meeting detection
function initializeMeetDetection() {
    // Look for meeting UI elements to detect when call starts
    meetingObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.addedNodes.length) {
                // Check for video/audio elements that indicate a call has started
                const callStarted = document.querySelector('[data-call-started]') || 
                                    document.querySelector('[data-meeting-active]') ||
                                    document.querySelectorAll('video').length > 0;
                
                if (callStarted && autoTranscriptionEnabled && !isRecording) {
                    console.log("🎉 Обнаружено начало звонка в Google Meet");
                    startRecording();
                }
                
                // Check for meeting name to use in filename
                const meetingNameElement = document.querySelector('[data-meeting-title]') || 
                                          document.querySelector('.r6xAKc');
                if (meetingNameElement) {
                    window.meetingName = meetingNameElement.textContent.trim();
                }
            }
        });
    });
    
    // Start observing document body for changes
    meetingObserver.observe(document.body, { childList: true, subtree: true });
    
    // Also detect page unload to stop recording
    window.addEventListener('beforeunload', () => {
        if (isRecording) {
            stopRecording();
        }
    });
}

// Get audio stream from meeting
async function getAudioStream() {
    console.log("🎧 Перехват аудио: запрашиваем доступ...");

    try {
        // Try to capture tab audio first (requires tabCapture permission)
        if (navigator.mediaDevices.getDisplayMedia) {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            
            // If we have audio tracks, use them
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                console.log("✅ Аудиопоток получен через getDisplayMedia:", audioTracks.length, "треков");
                
                // Stop video tracks as we only need audio
                displayStream.getVideoTracks().forEach(track => track.stop());
                
                // Create a new stream with only audio tracks
                const audioStream = new MediaStream(audioTracks);
                return audioStream;
            }
            
            // If no audio tracks, stop the display capture
            displayStream.getTracks().forEach(track => track.stop());
        }
        
        // Fallback to microphone audio
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("✅ Аудиопоток получен с микрофона:", micStream);
        return micStream;
    } catch (err) {
        console.error("❌ Ошибка получения аудиопотока:", err);
        return null;
    }
}

// Start recording audio
async function startRecording() {
    console.log("🎙 Запуск записи...");
    
    if (isRecording) {
        console.log("⚠️ Запись уже идет");
        return;
    }

    // Initialize AudioContext if needed
    if (!audioContext) {
        audioContext = new AudioContext();
    }

    if (audioContext.state === "suspended") {
        await audioContext.resume();
        console.log("🔊 AudioContext возобновлён!");
    }

    // Get audio stream
    const stream = await getAudioStream();
    if (!stream) {
        console.error("❌ Не удалось получить аудиопоток");
        return;
    }

    // Reset audio chunks
    audioChunks = [];
    
    // Create MediaRecorder
    mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
    });
    
    // Handle audio data
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };

    // Start recording
    mediaRecorder.start(1000); // Capture in 1-second chunks
    isRecording = true;
    
    // Notify background script that recording started
    chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "started",
        meetingName: window.meetingName || "Unknown Meeting"
    });
    
    console.log("▶ Запись началась! Текущее состояние:", mediaRecorder.state);
}

// Stop recording and process audio
async function stopRecording() {
    console.log("🛑 Остановка записи...");

    if (!isRecording || !mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("⚠️ Запись не активна, нечего останавливать");
        return;
    }

    // Change recording state
    isRecording = false;
    
    // Create a promise to handle the stop event
    const stopPromise = new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
            // Convert audio chunks to blob
            const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
            console.log("💾 Аудио-файл сформирован:", audioBlob.size, "байт");
            
            // Convert to WAV for better compatibility with Whisper API
            const wavBlob = await convertToWav(audioBlob);
            
            // Send to background script for processing
            const reader = new FileReader();
            reader.readAsDataURL(wavBlob); 
            reader.onloadend = function() {
                chrome.runtime.sendMessage({
                    type: "sendAudioToWhisper",
                    file: reader.result,
                    meetingName: window.meetingName || "Unknown Meeting"
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error("❌ Ошибка отправки сообщения:", chrome.runtime.lastError.message);
                    } else {
                        console.log("✅ Ответ от background.js:", response);
                    }
                });
            };
            
            // Release used media tracks
            if (mediaRecorder.stream) {
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
            
            resolve();
        };
    });
    
    // Stop the recording
    mediaRecorder.stop();
    
    // Notify background script that recording stopped
    chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "stopped"
    });
    
    // Wait for stop to complete
    await stopPromise;
    console.log("⏹ Запись остановлена и отправлена на обработку");
}

// Convert WebM to WAV (simplified approach)
async function convertToWav(webmBlob) {
    // In a real implementation, we would use audio libraries to convert
    // For this example, we'll just return the original blob
    // In production, you'd want to use WebAudio API to properly convert
    console.log("🔄 Конвертация аудио формата (упрощенная версия)");
    return webmBlob;
}

// Disable auto-transcription for current meeting
function disableAutoTranscription() {
    autoTranscriptionEnabled = false;
    
    if (isRecording) {
        stopRecording();
    }
    
    console.log("🔕 Автоматическая транскрипция отключена для текущей встречи");
}

// Listen for messages from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startRecording") {
        console.log("📩 Получено сообщение 'startRecording'");
        startRecording();
        sendResponse({ status: "✅ Запись началась!" });
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
            meetingDetected: !!window.meetingName,
            meetingName: window.meetingName || "Unknown Meeting"
        });
    }
    
    return true; // Important for asynchronous sendResponse
});