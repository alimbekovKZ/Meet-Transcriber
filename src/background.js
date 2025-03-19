// const OPENAI_API_KEY = "sk-proj-7qbsSITJhiFiuRwD-s5rlOFCqrJTfxSgJqszhwB2se_W2gsqEdvpl8I5HBlZzVuK8jL0CxVoJhT3BlbkFJbOtzeT6Oobb0MyruWEuA-PCFQWs4QRRrxgLhVSPsr74P2cpojwzUSYsWrr72_EIsZQln6VPjY"; // 🔑 Вставь свой API-ключ OpenAI

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "sendAudio") {
        (async () => {
            try {
                console.log("📩 Получен аудиофайл, отправляем на OpenAI Whisper...");

                const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";
                const OPENAI_API_KEY = "your-api-key"; // 🔑 Вставь свой API-ключ OpenAI

                const formData = new FormData();
                formData.append("file", message.audioBlob, "recording.wav");
                formData.append("model", "whisper-1");
                formData.append("language", "ru"); // Укажи нужный язык (например, "ru" для русского)

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

        return true; // ВАЖНО: Говорим Chrome, что ответ придёт асинхронно
    }
});
