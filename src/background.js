// const OPENAI_API_KEY = "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"; // 🔑 Вставь свой API-ключ OpenAI


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "sendAudioToWhisper") {
        (async () => {
            try {
                console.log("📩 Получен аудиофайл, конвертируем...");

                const byteCharacters = atob(message.file.split(',')[1]); // Декодируем Base64
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const audioBlob = new Blob([byteArray], { type: "audio/wav" });

                console.log("🔄 Файл успешно декодирован!");

                const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";
                
                const OPENAI_API_KEY = "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"; // 🔑 Вставь API-ключ OpenAI

                const formData = new FormData();
                formData.append("file", audioBlob, "recording.wav");
                formData.append("model", "whisper-1");
                formData.append("language", "ru"); // Укажи нужный язык

                console.log("🌍 Отправка запроса в:", OPENAI_API_URL);

                const response = await fetch(OPENAI_API_URL, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`,
                    },
                    body: formData,
                });

                const result = await response.json();
                console.log("📥 Ответ от Whisper:", result);

                if (response.ok) {
                    saveTranscriptionToFile(result.text);
                    sendResponse({ status: "✅ Аудиофайл обработан", transcription: result.text });
                } else {
                    console.error("⚠ Ошибка от OpenAI:", result);
                    sendResponse({ status: "❌ Ошибка OpenAI", error: result });
                }
            } catch (error) {
                console.error("⚠ Ошибка при отправке в Whisper:", error);
                sendResponse({ status: "❌ Ошибка отправки", error: error.message });
            }
        })();

        return true; // 🚀 ВАЖНО: Chrome будет ждать sendResponse
    }
});

// Функция сохранения транскрипции в .txt
function saveTranscriptionToFile(transcription) {
    const blob = new Blob([transcription], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcription.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
