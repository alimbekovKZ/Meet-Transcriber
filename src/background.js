const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const API_KEY = "sk-proj-7qbsSITJhiFiuRwD-s5rlOFCqrJTfxSgJqszhwB2se_W2gsqEdvpl8I5HBlZzVuK8jL0CxVoJhT3BlbkFJbOtzeT6Oobb0MyruWEuA-PCFQWs4QRRrxgLhVSPsr74P2cpojwzUSYsWrr72_EIsZQln6VPjY"; // Подставь свой API-ключ

async function sendToWhisper(file) {
    if (!file) {
        console.error("❌ Ошибка: Файл отсутствует.");
        return;
    }

    console.log("📤 Отправляем файл на Whisper API...");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");

    try {
        const response = await fetch(WHISPER_API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${API_KEY}`
            },
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Ошибка API: ${response.statusText}`);
        }

        const data = await response.json();
        console.log("✅ Whisper API ответ:", data.text);

        // Сохранение транскрипции в файл
        saveTranscriptionToFile(data.text);

        // Отправляем текст транскрипции в popup.js
        chrome.runtime.sendMessage({ type: "transcriptionResult", text: data.text });

    } catch (error) {
        console.error("⚠ Ошибка при отправке в Whisper:", error);
    }
}

// Функция для сохранения транскрипции в файл
function saveTranscriptionToFile(text) {
    if (!text) {
        console.error("❌ Ошибка: Текст транскрипции пуст.");
        return;
    }

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcription.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    console.log("📄 Файл транскрипции сохранен.");
}

// Слушаем сообщения от content.js или popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "sendAudioToWhisper") {
        sendToWhisper(message.file);
    }
});