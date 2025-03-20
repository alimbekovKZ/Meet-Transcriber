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
// Improved audio recording and processing
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
            try {
                // Convert audio chunks to blob
                const audioBlob = new Blob(audioChunks, { 
                    type: mediaRecorder.mimeType || "audio/webm;codecs=opus" 
                });
                console.log("💾 Аудио-файл сформирован:", audioBlob.size, "байт");
                
                // Try to convert to WAV first
                let finalBlob;
                try {
                    finalBlob = await convertToWav(audioBlob);
                    console.log("✅ Конвертация в WAV успешна");
                } catch (error) {
                    console.error("❌ Ошибка конвертации в WAV:", error);
                    // Fallback to original format with different mime type
                    finalBlob = new Blob([await audioBlob.arrayBuffer()], { type: 'audio/wav' });
                    console.log("⚠️ Используем исходный формат с WAV mime-type");
                }
                
                console.log("📦 Финальный аудиофайл:", finalBlob.size, "байт, тип:", finalBlob.type);
                
                // Send to background script for processing
                const reader = new FileReader();
                reader.readAsDataURL(finalBlob); 
                reader.onloadend = function() {
                    chrome.runtime.sendMessage({
                        type: "sendAudioToWhisper",
                        file: reader.result,
                        meetingName: window.meetingName || "Unknown Meeting",
                        format: finalBlob.type
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("❌ Ошибка отправки сообщения:", chrome.runtime.lastError.message);
                        } else {
                            console.log("✅ Ответ от background.js:", response);
                        }
                    });
                };
            } catch (error) {
                console.error("❌ Критическая ошибка при обработке аудио:", error);
                chrome.runtime.sendMessage({
                    type: "recordingError",
                    error: error.message
                });
            } finally {
                // Release used media tracks
                if (mediaRecorder.stream) {
                    mediaRecorder.stream.getTracks().forEach(track => track.stop());
                }
                
                resolve();
            }
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
// Proper WebM to WAV conversion function
async function convertToWav(webmBlob) {
    console.log("🔄 Конвертация аудио из WebM в WAV формат...");
    
    try {
        // Create audio context
        const audioContext = new AudioContext();
        
        // Read the blob as ArrayBuffer
        const arrayBuffer = await webmBlob.arrayBuffer();
        
        // Decode the audio data
        const audioData = await audioContext.decodeAudioData(arrayBuffer);
        
        // Create a buffer source
        const source = audioContext.createBufferSource();
        source.buffer = audioData;
        
        // Create offline context for rendering
        const offlineCtx = new OfflineAudioContext(
            audioData.numberOfChannels,
            audioData.length,
            audioData.sampleRate
        );
        
        // Create buffer source for offline context
        const offlineSource = offlineCtx.createBufferSource();
        offlineSource.buffer = audioData;
        offlineSource.connect(offlineCtx.destination);
        offlineSource.start();
        
        // Render audio
        const renderedBuffer = await offlineCtx.startRendering();
        
        // Convert to WAV format
        const wavBlob = audioBufferToWav(renderedBuffer);
        
        console.log("✅ Аудио успешно конвертировано в WAV формат");
        return wavBlob;
    } catch (error) {
        console.error("❌ Ошибка при конвертации аудио:", error);
        
        // Fallback: Try to send original blob with proper MIME type
        console.log("⚠️ Используем оригинальный аудиофайл с измененным MIME типом");
        return new Blob([await webmBlob.arrayBuffer()], { type: 'audio/wav' });
    }
}

// Function to convert AudioBuffer to WAV Blob
function audioBufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2;
    const sampleRate = buffer.sampleRate;
    
    // Create DataView for WAV header
    const wavDataView = new DataView(new ArrayBuffer(44));
    
    // Write "RIFF" identifier
    writeString(wavDataView, 0, 'RIFF');
    // Write RIFF chunk length
    wavDataView.setUint32(4, 36 + length, true);
    // Write "WAVE" format
    writeString(wavDataView, 8, 'WAVE');
    // Write "fmt " chunk identifier
    writeString(wavDataView, 12, 'fmt ');
    // Write fmt chunk length
    wavDataView.setUint32(16, 16, true);
    // Write format code (1 for PCM)
    wavDataView.setUint16(20, 1, true);
    // Write number of channels
    wavDataView.setUint16(22, numOfChan, true);
    // Write sample rate
    wavDataView.setUint32(24, sampleRate, true);
    // Write byte rate (sample rate * block align)
    wavDataView.setUint32(28, sampleRate * numOfChan * 2, true);
    // Write block align (num of channels * bits per sample / 8)
    wavDataView.setUint16(32, numOfChan * 2, true);
    // Write bits per sample
    wavDataView.setUint16(34, 16, true);
    // Write "data" chunk identifier
    writeString(wavDataView, 36, 'data');
    // Write data chunk length
    wavDataView.setUint32(40, length, true);
    
    // Create the final buffer with header and audio data
    const wavData = new DataView(new ArrayBuffer(44 + length));
    
    // Copy WAV header
    for (let i = 0; i < 44; i++) {
        wavData.setUint8(i, wavDataView.getUint8(i));
    }
    
    // Convert audio data to 16-bit PCM and write it
    let offset = 44;
    for (let i = 0; i < buffer.numberOfChannels; i++) {
        const channelData = buffer.getChannelData(i);
        for (let j = 0; j < channelData.length; j++) {
            // Scale float32 to int16
            const sample = Math.max(-1, Math.min(1, channelData[j]));
            const int16Sample = sample < 0 
                ? sample * 0x8000 
                : sample * 0x7FFF;
            
            wavData.setInt16(offset, int16Sample, true);
            offset += 2;
        }
    }
    
    // Create WAV blob
    return new Blob([wavData], { type: 'audio/wav' });
}

// Helper function to write strings to DataView
function writeString(dataView, offset, string) {
    for (let i = 0; i < string.length; i++) {
        dataView.setUint8(offset + i, string.charCodeAt(i));
    }
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