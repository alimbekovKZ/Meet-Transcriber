let mediaRecorder;
let recordedChunks = [];

// Функция для поиска активных аудио потоков WebRTC и записи
const interceptAndRecordAudio = async () => {
  try {
    console.log("Перехват аудио: запрашиваем доступ...");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    console.log("Аудиопоток получен:", stream);

    // Создаём MediaRecorder для записи
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log("Запись остановлена, начинаем сохранение...");
      await saveRecording();
    };

    console.log("Готов к записи.");
  } catch (error) {
    console.error("Ошибка при получении аудиопотока:", error);
  }
};

// Функция сохранения записанного аудио в FileSystem API
const saveRecording = async () => {
  if (!recordedChunks.length) {
    console.warn("Нет записанных данных.");
    return;
  }

  const blob = new Blob(recordedChunks, { type: "audio/wav" });

  try {
    // Открываем доступ к файловой системе
    const handle = await window.showSaveFilePicker({
      suggestedName: "recording.wav",
      types: [{
        description: "Audio File",
        accept: { "audio/wav": [".wav"] }
      }]
    });

    // Записываем файл
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();

    console.log("Файл успешно сохранен!");
    recordedChunks = []; // Очищаем буфер
  } catch (error) {
    console.error("Ошибка при сохранении файла:", error);
  }
};

// Управление записью
const startRecording = () => {
  if (!mediaRecorder) {
    console.error("MediaRecorder не инициализирован.");
    return;
  }

  recordedChunks = [];
  mediaRecorder.start();
  console.log("Запись началась...");
};

const pauseRecording = () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.pause();
    console.log("Запись приостановлена.");
  }
};

const resumeRecording = () => {
  if (mediaRecorder && mediaRecorder.state === "paused") {
    mediaRecorder.resume();
    console.log("Запись возобновлена.");
  }
};

const stopRecording = () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    console.log("Запись остановлена.");
  }
};

// Запуск после загрузки страницы
window.addEventListener("load", () => {
  console.log("Страница загружена, начинаем перехват аудио...");
  interceptAndRecordAudio();
});

// Добавляем обработку команд от popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === "start") startRecording();
  if (message.command === "pause") pauseRecording();
  if (message.command === "resume") resumeRecording();
  if (message.command === "stop") stopRecording();
});
