(() => {
  "use strict";

  // Подключение к Supabase
  const SUPABASE_URL =
    "https://juchryyubxkuapnaqelj.supabase.co";

  const SUPABASE_KEY =
    "sb_publishable_l75mr1kAzXwX6aPUEvruEA_GfmLKIE-";

  // Настройки игры
  const DEFAULT_ROOM = "party-1";

  // При таком количестве очков шкала заполнена полностью.
  const MAX_SCORE = 100;

  // Порог начала и окончания громкого звука.
  const LOUD_START = 35;
  const LOUD_END = 25;

  // Минимальная пауза между очками.
  const SCORE_COOLDOWN_MS = 1000;

  // Настройки персонажей.
  const CHARACTERS = [
    {
      image: "images/luigi.png",
      color: "#d3f77d"
    },
    {
      image: "images/mario.png",
      color: "#dc9146"
    },
    {
      image: "images/luigi.png",
      color: "#8ab8ff"
    },
    {
      image: "images/mario.png",
      color: "#f7a4c6"
    }
  ];

  const nameInput = document.getElementById("playerName");
  const roomInput = document.getElementById("roomName");
  const joinButton = document.getElementById("joinButton");
  const startButton = document.getElementById("startButton");
  const stopButton = document.getElementById("stopButton");
  const statusElement = document.getElementById("status");
  const meterFill = document.getElementById("meterFill");
  const scoreList = document.getElementById("scoreList");
  const errorElement = document.getElementById("error");
  const controls = document.getElementById("controls");
  const setup = document.querySelector(".setup");

  let db = null;
  let playerName = "";
  let roomName = DEFAULT_ROOM;

  let audioContext = null;
  let audioStream = null;
  let analyser = null;
  let animationFrame = null;

  let isRunning = false;
  let isStarting = false;
  let isLoud = false;
  let isSavingPoint = false;
  let lastPointTime = -Infinity;

  let scoreChannel = null;
  let refreshTimer = null;
  let refreshVersion = 0;

  function showError(message) {
    console.error(message);

    if (errorElement) {
      errorElement.textContent = message;
      errorElement.classList.remove("hidden");
    }
  }

  function hideError() {
    if (errorElement) {
      errorElement.textContent = "";
      errorElement.classList.add("hidden");
    }
  }

  function errorMessage(error) {
    return error?.message || String(error);
  }

  // Проверяем, что HTML соответствует скрипту.
  const requiredElements = [
    nameInput,
    roomInput,
    joinButton,
    startButton,
    stopButton,
    statusElement,
    meterFill,
    scoreList,
    controls,
    setup,
    errorElement
  ];

  if (requiredElements.some(element => !element)) {
    showError(
      "Не найдены элементы интерфейса. " +
      "Замените index.html на последнюю версию."
    );
    return;
  }

  if (!window.supabase?.createClient) {
    showError(
      "Не загрузилась библиотека Supabase. " +
      "Проверьте подключение CDN перед game.js в index.html."
    );
    return;
  }

  try {
    db = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );
  } catch (error) {
    showError(
      "Ошибка подключения к Supabase: " + errorMessage(error)
    );
    return;
  }

  joinButton.addEventListener("click", joinGame);
  startButton.addEventListener("click", startListening);
  stopButton.addEventListener("click", stopListening);

  nameInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !joinButton.disabled) {
      joinGame();
    }
  });

  window.addEventListener("pagehide", () => {
    stopListening();

    if (refreshTimer) {
      clearInterval(refreshTimer);
    }

    if (scoreChannel) {
      db.removeChannel(scoreChannel);
    }
  });

  async function joinGame() {
    if (joinButton.disabled) return;

    const name = nameInput.value.trim();
    const room = roomInput.value.trim() || DEFAULT_ROOM;

    if (!name) {
      showError("Введите имя игрока.");
      return;
    }

    if (name.length > 30) {
      showError("Имя должно быть не длиннее 30 символов.");
      return;
    }

    if (room.length > 50) {
      showError("Название комнаты — не длиннее 50 символов.");
      return;
    }

    hideError();

    joinButton.disabled = true;
    joinButton.textContent = "Подключение…";

    try {
      // Если игрок уже существует, его счёт не сбрасывается.
      const { error } = await db
        .from("players")
        .upsert(
          {
            room,
            name,
            score: 0
          },
          {
            onConflict: "room,name",
            ignoreDuplicates: true
          }
        );

      if (error) throw error;

      playerName = name;
      roomName = room;

      setup.classList.add("hidden");
      controls.classList.remove("hidden");

      statusElement.textContent =
        playerName + ", нажмите «Начать»";

      await loadScores();
      subscribeToScores();

      // Резервное обновление, если Realtime недоступен.
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }

      refreshTimer = setInterval(() => {
        loadScores();
      }, 5000);
    } catch (error) {
      console.error("Ошибка входа:", error);

      showError(
        "Не удалось войти: " + errorMessage(error)
      );
    } finally {
      joinButton.disabled = false;
      joinButton.textContent = "Войти в игру";
    }
  }

  async function startListening() {
    if (isRunning || isStarting) return;

    if (!playerName) {
      showError("Сначала войдите в игру.");
      return;
    }

    hideError();

    if (!navigator.mediaDevices?.getUserMedia) {
      showError(
        "Микрофон недоступен. Откройте сайт по HTTPS " +
        "в отдельной вкладке браузера."
      );
      return;
    }

    isStarting = true;
    startButton.disabled = true;

    statusElement.textContent =
      "Ожидаем разрешение на микрофон…";

    try {
      audioStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: false
          }
        });

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        throw new Error(
          "Браузер не поддерживает обработку звука."
        );
      }

      audioContext = new AudioContextClass();

      await audioContext.resume();

      const source =
        audioContext.createMediaStreamSource(audioStream);

      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;

      source.connect(analyser);

      // Не подключаем источник к динамикам:
      // свой микрофон игрок не слышит.
      isRunning = true;
      isLoud = false;
      lastPointTime = -Infinity;

      stopButton.disabled = false;

      statusElement.textContent =
        playerName + ": микрофон включён";

      listenToMicrophone();
    } catch (error) {
      console.error("Ошибка микрофона:", error);

      stopListening();

      if (error.name === "NotAllowedError") {
        showError(
          "Доступ к микрофону запрещён. " +
          "Разрешите микрофон в настройках сайта. " +
          "Если игра открыта в Meleto, проверьте её " +
          "сначала в отдельной вкладке: iframe может " +
          "блокировать доступ."
        );
      } else if (error.name === "NotFoundError") {
        showError(
          "Микрофон не найден. Проверьте его подключение."
        );
      } else {
        showError(
          "Не удалось включить микрофон: " +
          errorMessage(error)
        );
      }
    } finally {
      isStarting = false;
      startButton.disabled = isRunning;
    }
  }

  function listenToMicrophone() {
    const data = new Uint8Array(analyser.fftSize);

    function check() {
      if (!isRunning || !analyser) return;

      analyser.getByteTimeDomainData(data);

      let sum = 0;

      for (let i = 0; i < data.length; i++) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }

      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(
        100,
        Math.round(rms * 300)
      );

      meterFill.style.width = level + "%";

      const now = performance.now();

      if (level >= LOUD_START) {
        isLoud = true;
      } else if (isLoud && level < LOUD_END) {
        // Громкий всплеск закончился.
        isLoud = false;

        if (
          now - lastPointTime >= SCORE_COOLDOWN_MS &&
          !isSavingPoint
        ) {
          lastPointTime = now;
          addPoint();
        }
      }

      animationFrame = requestAnimationFrame(check);
    }

    check();
  }

  async function addPoint() {
    if (isSavingPoint || !playerName) return;

    isSavingPoint = true;

    try {
      const { data, error } = await db
        .from("players")
        .select("score")
        .eq("room", roomName)
        .eq("name", playerName)
        .single();

      if (error) throw error;

      const nextScore = (Number(data.score) || 0) + 1;

      const { data: saved, error: updateError } = await db
        .from("players")
        .update({
          score: nextScore
        })
        .eq("room", roomName)
        .eq("name", playerName)
        .select("score")
        .single();

      if (updateError) throw updateError;

      if (isRunning) {
        statusElement.textContent =
          playerName + ": +1 очко! Всего: " + saved.score;
      }

      await loadScores();
    } catch (error) {
      console.error("Ошибка начисления очка:", error);

      showError(
        "Не удалось сохранить очко: " +
        errorMessage(error)
      );
    } finally {
      isSavingPoint = false;
    }
  }

  function stopListening() {
    isRunning = false;
    isLoud = false;

    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    if (audioStream) {
      audioStream.getTracks().forEach(track => {
        track.stop();
      });

      audioStream = null;
    }

    if (audioContext) {
      const context = audioContext;
      audioContext = null;

      context.close().catch(console.error);
    }

    analyser = null;

    meterFill.style.width = "0%";
    startButton.disabled = false;
    stopButton.disabled = true;

    statusElement.textContent =
      "Микрофон выключен. Очки сохранены.";
  }

  async function loadScores() {
    const requestVersion = ++refreshVersion;

    try {
      const { data, error } = await db
        .from("players")
        .select("name, score")
        .eq("room", roomName)
        .order("name", { ascending: true });

      if (error) throw error;

      // Не показываем устаревший ответ,
      // если более новый запрос уже начался.
      if (requestVersion !== refreshVersion) return;

      renderScores(data || []);
    } catch (error) {
      console.error("Ошибка загрузки очков:", error);

      if (requestVersion === refreshVersion) {
        showError(
          "Не удалось загрузить очки: " +
          errorMessage(error)
        );
      }
    }
  }

  function subscribeToScores() {
    if (scoreChannel) {
      db.removeChannel(scoreChannel);
    }

    scoreChannel = db
      .channel("scores-" + crypto.randomUUID())
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players"
        },
        () => {
          loadScores();
        }
      )
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          loadScores();
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          console.warn(
            "Realtime недоступен. " +
            "Используется обновление раз в 5 секунд.",
            error
          );
        }
      });
  }

  function renderScores(players) {
    scoreList.replaceChildren();

    const emptyMessage =
      document.getElementById("emptyMessage");

    if (emptyMessage) {
      emptyMessage.classList.toggle(
        "hidden",
        players.length > 0
      );
    }

    // Алфавитный порядок: изменение счёта
    // не переставляет игроков местами.
    const orderedPlayers = [...players].sort((a, b) =>
      a.name.localeCompare(b.name, "ru")
    );

    orderedPlayers.forEach((player, index) => {
      const character =
        CHARACTERS[index % CHARACTERS.length];

      const score = Number(player.score) || 0;

      const percentage = Math.max(
        0,
        Math.min(100, (score / MAX_SCORE) * 100)
      );

      const item = document.createElement("li");
      item.className = "player";

      item.style.setProperty(
        "--player-color",
        character.color
      );

      const scoreElement = document.createElement("span");
      scoreElement.className = "player-score";
      scoreElement.textContent = String(score);

      const stage = document.createElement("div");
      stage.className = "player-stage";

      const track = document.createElement("div");
      track.className = "player-track";

      const trackInner = document.createElement("div");
      trackInner.className = "player-track-inner";

      const fill = document.createElement("div");
      fill.className = "player-fill";
      fill.style.height = percentage + "%";

      trackInner.appendChild(fill);
      track.appendChild(trackInner);

      const avatar = document.createElement("div");
      avatar.className = "player-avatar";

      const image = document.createElement("img");
      image.alt = "";

      image.addEventListener("error", () => {
        avatar.classList.add("no-image");
      });

      image.src = character.image;

      const letter = document.createElement("span");
      letter.className = "avatar-letter";

      letter.textContent = Array.from(
        player.name
      )[0]?.toUpperCase() || "?";

      avatar.append(image, letter);
      stage.append(track, avatar);

      const nameElement = document.createElement("p");
      nameElement.className = "player-name";
      nameElement.textContent = player.name;
      nameElement.title = player.name;

      item.append(scoreElement, stage, nameElement);
      scoreList.appendChild(item);
    });
  }
})();
