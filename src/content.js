// Функция для поиска активных аудио потоков WebRTC
const interceptAudioStream = () => {
    // Получаем все медиапотоки с текущей страницы
    const mediaDevices = navigator.mediaDevices;
  
    if (!mediaDevices || !mediaDevices.getUserMedia) {
      console.error("WebRTC не поддерживается в этом браузере.");
      return;
    }
  
    console.log("Перехват аудио: запрашиваем доступ...");
  
    mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        console.log("Аудиопоток получен:", stream);
  
        // Создаем AudioContext
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
  
        console.log("AudioContext успешно подключен:", audioContext);
  
        // Создаем анализатор
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
  
        // Подключаем источник к анализатору и анализатор к выходу
        source.connect(analyser);
  
        console.log("Аудиопоток подключен к анализатору.");
        
        // Функция для логирования данных аудиопотока
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
  
        const logAudioData = () => {
          analyser.getByteFrequencyData(dataArray);
          console.log("Аудио-данные:", dataArray);
          requestAnimationFrame(logAudioData);
        };
  
        logAudioData(); // Запускаем логирование аудио
      })
      .catch(error => {
        console.error("Ошибка при получении аудиопотока:", error);
      });
  };
  
  // Ждем полной загрузки страницы перед выполнением
  window.addEventListener("load", () => {
    console.log("Страница загружена, начинаем перехват аудио...");
    interceptAudioStream();
  });
  