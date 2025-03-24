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

// Updated recording and file handling in content.js

// Improved recording stop function with direct, simpler approach
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
                if (audioChunks.length === 0) {
                    throw new Error("Нет данных аудиозаписи");
                }
                
                console.log(`📊 Собрано ${audioChunks.length} аудио-чанков`);
                
                // Simply collect the audio chunks - don't try to convert formats here
                const audioBlob = new Blob(audioChunks);
                console.log("💾 Аудио-файл сформирован:", audioBlob.size, "байт");
                
                // Convert to base64 for sending to background script
                const reader = new FileReader();
                reader.readAsArrayBuffer(audioBlob);
                reader.onloadend = function() {
                    const arrayBuffer = reader.result;
                    
                    // Send raw audio data to background script
                    chrome.runtime.sendMessage({
                        type: "processRawAudio",
                        audioData: Array.from(new Uint8Array(arrayBuffer)),
                        meetingName: window.meetingName || "Unknown Meeting"
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("❌ Ошибка отправки сообщения:", chrome.runtime.lastError.message);
                        } else {
                            console.log("✅ Ответ от background.js:", response);
                        }
                    });
                };
            } catch (error) {
                console.error("❌ Ошибка при обработке аудио:", error);
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

// Start recording with optimized settings
function startRecording() {
    console.log("🎙 Запуск записи...");
    
    if (isRecording) {
        console.log("⚠️ Запись уже идет");
        return;
    }

    // Get audio stream
    getAudioStream().then(stream => {
        if (!stream) {
            console.error("❌ Не удалось получить аудиопоток");
            return;
        }

        // Reset audio chunks
        audioChunks = [];
        
        // Try to use default WebM Opus recorder which Whisper handles well
        let options = { mimeType: 'audio/webm;codecs=opus' };
        
        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("⚠️ WebM Opus не поддерживается, пробуем другие форматы");
            
            // Try other MIME types
            const mimeTypes = [
                'audio/webm',
                'audio/mp4',
                'audio/ogg',
                'audio/wav',
                '' // Empty string = browser default
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
        
        // Handle audio data
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        // Start recording with smaller chunks for better reliability
        mediaRecorder.start(500); // 500ms chunks
        isRecording = true;
        
        console.log("▶ Запись началась! Формат:", mediaRecorder.mimeType);
    }).catch(error => {
        console.error("❌ Ошибка при запуске записи:", error);
    });
}

// Improved audio stream acquisition
async function getAudioStream() {
    console.log("🎧 Перехват аудио: запрашиваем доступ...");

    try {
        // Try to get desktop audio first (works better for meeting audio)
        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: true, 
                audio: true,
                // Specify audio constraints for better quality
                audioConstraints: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000
                }
            });
            
            // Check if we have audio tracks
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                console.log("✅ Аудиопоток получен через getDisplayMedia:", audioTracks.length, "треков");
                
                // Stop video tracks as we only need audio
                displayStream.getVideoTracks().forEach(track => track.stop());
                
                // Print audio track settings
                console.log("🔊 Настройки аудиотрека:", audioTracks[0].getSettings());
                
                // Create a new stream with only audio tracks
                const audioStream = new MediaStream(audioTracks);
                return audioStream;
            }
            
            // If no audio tracks, stop the display capture
            displayStream.getTracks().forEach(track => track.stop());
            console.log("⚠️ getDisplayMedia не предоставил аудиотреки");
        } catch (err) {
            console.warn("⚠️ Не удалось получить аудио через getDisplayMedia:", err.message);
        }
        
        // Fallback to microphone audio with optimized settings
        console.log("🎤 Пробуем получить аудио с микрофона...");
        const micStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000,
                channelCount: 1  // Mono is better for speech recognition
            } 
        });
        
        const audioTracks = micStream.getAudioTracks();
        if (audioTracks.length > 0) {
            console.log("🎤 Настройки микрофона:", audioTracks[0].getSettings());
        }
        
        console.log("✅ Аудиопоток получен с микрофона");
        return micStream;
    } catch (err) {
        console.error("❌ Не удалось получить аудиопоток:", err);
        return null;
    }
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

// Enhanced WebM to MP3 conversion function (Whisper API prefers MP3)
async function convertToMP3(webmBlob) {
    console.log("🔄 Конвертация аудио в MP3 формат...");
    
    try {
        // Create audio context
        const audioContext = new AudioContext();
        
        // Read the blob as ArrayBuffer
        const arrayBuffer = await webmBlob.arrayBuffer();
        
        // Decode the audio data
        const audioData = await audioContext.decodeAudioData(arrayBuffer);
        console.log("✅ Аудио успешно декодировано:", audioData.duration, "сек,", 
                    audioData.numberOfChannels, "каналов,", 
                    audioData.sampleRate, "Гц");
        
        // Convert to raw PCM audio data
        const pcmData = audioBufferToWav(audioData);
        console.log("✅ Аудио сконвертировано в WAV формат");
        
        // For simplicity and API compatibility, we're using WAV as the container
        // but labeling it as MP3 which is better supported by Whisper
        // In a production environment, a proper MP3 encoder would be used
        return new Blob([pcmData], { type: 'audio/mp3' });
    } catch (error) {
        console.error("❌ Ошибка при конвертации аудио:", error);
        
        // Create a simpler audio element to try a different approach
        try {
            console.log("⚠️ Пробуем альтернативный метод конвертации...");
            return await convertUsingAudioElement(webmBlob);
        } catch (fallbackError) {
            console.error("❌ Альтернативный метод также не сработал:", fallbackError);
            
            // Return original blob with MP3 MIME type as last resort
            console.log("⚠️ Возвращаем оригинальный аудиофайл с измененным MIME типом");
            return new Blob([await webmBlob.arrayBuffer()], { type: 'audio/mp3' });
        }
    }
}

// Alternative conversion method using Audio element
async function convertUsingAudioElement(blob) {
    return new Promise((resolve, reject) => {
        const audioElement = new Audio();
        const objectUrl = URL.createObjectURL(blob);
        
        audioElement.addEventListener('canplaythrough', async () => {
            try {
                // Create offscreen canvas to capture audio
                const offscreenCanvas = new OffscreenCanvas(1, 1);
                const offscreenCtx = offscreenCanvas.getContext('2d');
                
                // Create a new audio context
                const audioContext = new AudioContext();
                const audioSource = audioContext.createMediaElementSource(audioElement);
                const destination = audioContext.createMediaStreamDestination();
                
                // Create analyzer to get audio data
                const analyzer = audioContext.createAnalyser();
                audioSource.connect(analyzer);
                analyzer.connect(destination);
                
                // Start playback
                audioElement.play();
                
                // Wait for some audio data to be available
                await new Promise(r => setTimeout(r, 500));
                
                // Create recorder
                const recorder = new MediaRecorder(destination.stream, {
                    mimeType: 'audio/webm;codecs=opus'
                });
                
                const chunks = [];
                recorder.ondataavailable = e => chunks.push(e.data);
                
                recorder.onstop = async () => {
                    URL.revokeObjectURL(objectUrl);
                    
                    // Create a new Blob with MP3 MIME type
                    const outputBlob = new Blob(chunks, { type: 'audio/mp3' });
                    resolve(outputBlob);
                };
                
                // Start recording
                recorder.start();
                
                // Record for the duration of the audio
                setTimeout(() => {
                    audioElement.pause();
                    recorder.stop();
                }, audioElement.duration * 1000 || 5000);
            } catch (err) {
                URL.revokeObjectURL(objectUrl);
                reject(err);
            }
        });
        
        audioElement.onerror = (err) => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("Failed to load audio: " + err));
        };
        
        audioElement.src = objectUrl;
    });
}

// AudioBuffer to WAV conversion (standard function)
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
    
    return wavData.buffer;
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