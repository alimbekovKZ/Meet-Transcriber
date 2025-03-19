console.log("📌 content.js загружен. Ожидание команды...");

let audioContext;
let mediaRecorder;
let audioChunks = [];

async function getAudioStream() {
    console.log("🎧 Перехват аудио: запрашиваем доступ...");

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("✅ Аудиопоток получен:", stream);

        return stream;
    } catch (err) {
        console.error("❌ Ошибка получения аудиопотока:", err);
    }
}

async function startRecording() {
    console.log("🎙 Запуск записи...");

    if (!audioContext) {
        audioContext = new AudioContext();
    }

    if (audioContext.state === "suspended") {
        await audioContext.resume();
        console.log("🔊 AudioContext возобновлён!");
    }

    const stream = await getAudioStream();
    if (!stream) return;

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };

    mediaRecorder.start();
    console.log("▶ Запись началась! Текущее состояние:", mediaRecorder.state);
}

// 🛑 Остановка записи и сохранение файла
async function stopRecording() {
    console.log("🛑 Остановка записи...");

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
        console.log("⏹ Запись остановлена.");
        
        // Ожидаем завершения записи
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
            console.log("💾 Аудио-файл сформирован:", audioBlob);

            await saveFile(audioBlob);
        };
    }
}

// 💾 Сохранение файла в FileSystem API
async function saveFile(blob) {
    const fileHandle = await window.showSaveFilePicker({
        suggestedName: "recording.wav",
        types: [{ description: "Audio File", accept: { "audio/wav": [".wav"] } }]
    });

    const writableStream = await fileHandle.createWritable();
    await writableStream.write(blob);
    await writableStream.close();

    console.log("✅ Файл сохранён: recording.wav");
}

// 📩 Слушаем команды от popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startRecording") {
        console.log("📩 Получено сообщение 'startRecording', запускаем запись...");
        startRecording();
        sendResponse({ status: "✅ Запись началась!" });
    }
    if (message.action === "stopRecording") {
        console.log("📩 Получено сообщение 'stopRecording', останавливаем запись...");
        stopRecording();
        sendResponse({ status: "✅ Запись остановлена!" });
    }
    return true;
});
