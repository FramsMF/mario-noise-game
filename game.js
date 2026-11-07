
const SUPABASE_URL = "https://juchryyubxkuapnaqelj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_l75mr1kAzXwX6aPUEvruEA_GfmLKIE-";

const ROOM = "party-1";
const LOUD_START = 35;
const LOUD_END = 25;
const SCORE_COOLDOWN_MS = 1000;

const nameInput = document.getElementById("playerName");
const roomInput = document.getElementById("roomName");
const joinButton = document.getElementById("joinButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusElement = document.getElementById("status");
const meterFill = document.getElementById("meterFill");
const scoreList = document.getElementById("scoreList");
const errorElement = document.getElementById("error");

const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

let playerName = "";
let roomName = ROOM;
let audioContext = null;
let audioStream = null;
let analyser = null;
let animationFrame = null;

let isLoud = false;
let canScore = true;
let isRunning = false;

joinButton.addEventListener("click", joinGame);
startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);

async function joinGame() {
  const name = nameInput.value.trim();
  roomName = roomInput.value.trim() || ROOM;

  if (!name) {
    showError("Введи имя игрока.");
    return;
  }

  hideError();
  playerName = name;

  const { error } = await supabase
    .from("players")
    .upsert(
      {
        room: roomName,
        name: playerName,
        score: 0
      },
      { onConflict: "room,name" }
    );

  if (error) {
    showError("Не удалось войти: " + error.message);
    return;
  }

  document.querySelector(".setup").classList.add("hidden");
  document.getElementById("controls").classList.remove("hidden");

  await loadScores();
  subscribeToScores();

  statusElement.textContent = "Нажми «Начать», чтобы включить микрофон";
}

async function startListening() {
  if (isRunning) return;

  try {
    hideError();

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;

    source.connect(analyser);

    isRunning = true;
    isLoud = false;
    canScore = true;

    startButton.disabled = true;
    stopButton.disabled = false;
    statusElement.textContent = "Микрофон активен";

    listenToMicrophone();
  } catch (err) {
    showError("Нет доступа к микрофону: " + err.message);
  }
}

function listenToMicrophone() {
  const data = new Uint8Array(analyser.fftSize);

  function check() {
    if (!isRunning) return;

    analyser.getByteTimeDomainData(data);

    let sum = 0;

    for (let i = 0; i < data.length; i++) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }

    const rms = Math.sqrt(sum / data.length);
    const level = Math.min(100, Math.round(rms * 300));

    meterFill.style.width = level + "%";

    if (level >= LOUD_START) {
      isLoud = true;
    }

    if (isLoud && level < LOUD_END && canScore) {
      addPoint();
      isLoud = false;
      canScore = false;

      setTimeout(() => {
        canScore = true;
      }, SCORE_COOLDOWN_MS);
    }

    animationFrame = requestAnimationFrame(check);
  }

  check();
}

async function addPoint() {
  const { data, error } = await supabase
    .from("players")
    .select("score")
    .eq("room", roomName)
    .eq("name", playerName)
    .single();

  if (error || !data) {
    showError("Не удалось получить очки.");
    return;
  }

  const newScore = data.score + 1;

  await supabase
    .from("players")
    .update({ score: newScore })
    .eq("room", roomName)
    .eq("name", playerName);
}

function stopListening() {
  isRunning = false;

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  meterFill.style.width = "0%";

  startButton.disabled = false;
  stopButton.disabled = true;
  statusElement.textContent = "Микрофон выключен";
}

async function loadScores() {
  const { data, error } = await supabase
    .from("players")
    .select("name, score")
    .eq("room", roomName)
    .order("score", { ascending: false });

  if (error) {
    showError("Не удалось загрузить очки: " + error.message);
    return;
  }

  renderScores(data || []);
}

function subscribeToScores() {
  supabase
    .channel("scores-" + roomName)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "players",
        filter: "room=eq." + roomName
      },
      () => {
        loadScores();
      }
    )
    .subscribe();
}

function renderScores(players) {
  scoreList.innerHTML = "";

  players.forEach(player => {
    const item = document.createElement("li");
    item.textContent = player.name + ": " + player.score;
    scoreList.appendChild(item);
  });
}

function showError(message) {
  errorElement.textContent = message;
  errorElement.classList.remove("hidden");
}

function hideError() {
  errorElement.textContent = "";
  errorElement.classList.add("hidden");
}
