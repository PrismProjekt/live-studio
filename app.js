
const STORAGE_KEY = "live-studio-v1";
const DB_NAME = "live-studio-audio";
const DB_VERSION = 1;
const AUDIO_STORE = "audioFiles";

const defaultPads = [
  { name: "Applause", emoji: "👏", type: "applause", color: "#166534" },
  { name: "Laugh Track", emoji: "😂", type: "laugh", color: "#854d0e" },
  { name: "Drum Roll", emoji: "🥁", type: "drum", color: "#9a3412" },
  { name: "Ding", emoji: "🛎️", type: "ding", color: "#1d4ed8" },
  { name: "Air Horn", emoji: "🚨", type: "horn", color: "#991b1b" },
  { name: "Crickets", emoji: "🦗", type: "crickets", color: "#065f46" },
  { name: "Fail", emoji: "💀", type: "fail", color: "#6b21a8" },
  { name: "Jingle", emoji: "🎵", type: "jingle", color: "#4338ca" }
];

let pads = [];
let audioContext = null;
let masterGain = null;
let activeAudio = new Set();
let activeSources = new Set();
let masterVolume = 0.8;
let recorder = null;
let recordingStream = null;
let recordingChunks = [];

const padContainer = document.getElementById("sound-pads");
const statusDisplay = document.getElementById("studio-status");
const padCount = document.getElementById("pad-count");
const fileInput = document.getElementById("audio-input");
const masterSlider = document.getElementById("master-volume");
const masterValue = document.getElementById("master-volume-value");

function status(message) {
  statusDisplay.textContent = message;
}

// ----------------------------------
// AUDIO DATABASE
// ----------------------------------

function openAudioDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeAudio(id, blob) {
  const db = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readwrite");

    transaction.objectStore(AUDIO_STORE).put({
      id,
      blob,
      savedAt: Date.now()
    });

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function getStoredAudio(id) {
  const db = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readonly");
    const request = transaction.objectStore(AUDIO_STORE).get(id);

    request.onsuccess = () => {
      const result = request.result;
      db.close();
      resolve(result ? result.blob : null);
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function deleteStoredAudio(id) {
  if (!id) return;

  const db = await openAudioDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, "readwrite");

    transaction.objectStore(AUDIO_STORE).delete(id);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function makeId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return "audio-" + Date.now() + "-" + Math.random();
}

// ----------------------------------
// PAD SETTINGS
// ----------------------------------

function savePads() {
  try {
    const settings = pads.map(pad => {
      const savedPad = { ...pad };
      delete savedPad.audio;
      return savedPad;
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    status("Could not save pad settings.");
  }
}

function loadPads() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (saved) {
      pads = JSON.parse(saved).map(pad => ({
        ...pad,
        volume: pad.volume ?? 1
      }));
    } else {
      pads = defaultPads.map(pad => ({
        ...pad,
        volume: 1
      }));
    }
  } catch (error) {
    pads = defaultPads.map(pad => ({
      ...pad,
      volume: 1
    }));
  }
}

// ----------------------------------
// AUDIO ENGINE
// ----------------------------------

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();

    masterGain.gain.value = masterVolume;
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  return audioContext;
}

function setMasterVolume(value) {
  masterVolume = Math.max(0, Math.min(1, value));

  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(
      masterVolume,
      audioContext.currentTime,
      0.01
    );
  }

  activeAudio.forEach(audio => {
    audio.volume = Math.max(
      0,
      Math.min(1, audio.padVolume * masterVolume)
    );
  });

  if (masterValue) {
    masterValue.textContent = Math.round(masterVolume * 100) + "%";
  }
}

function trackSource(source) {
  activeSources.add(source);

  source.onended = () => {
    activeSources.delete(source);
  };
}

function makeTone(
  frequency,
  start,
  duration,
  volume,
  wave = "sine",
  endFrequency = null
) {
  const ctx = getAudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, start);

  if (endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(
      endFrequency,
      start + duration
    );
  }

  gain.gain.setValueAtTime(0.001, start);
  gain.gain.exponentialRampToValueAtTime(
    Math.max(0.002, volume),
    start + 0.02
  );
  gain.gain.exponentialRampToValueAtTime(
    0.001,
    start + duration
  );

  oscillator.connect(gain);
  gain.connect(masterGain);

  trackSource(oscillator);

  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function makeNoise(start, duration, volume) {
  const ctx = getAudioContext();

  const buffer = ctx.createBuffer(
    1,
    Math.ceil(ctx.sampleRate * duration),
    ctx.sampleRate
  );

  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();

  source.buffer = buffer;
  gain.gain.value = volume;

  source.connect(gain);
  gain.connect(masterGain);

  trackSource(source);

  source.start(start);
  source.stop(start + duration);
}

function playEffect(type, volume) {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const v = volume;

  switch (type) {
    case "ding":
      makeTone(880, t, 0.5, 0.3 * v);
      makeTone(1175, t + 0.08, 0.6, 0.25 * v);
      break;

    case "drum":
      for (let i = 0; i < 16; i++) {
        makeNoise(t + i * 0.09, 0.08, 0.14 * v);
        makeTone(90, t + i * 0.09, 0.07, 0.12 * v, "triangle");
      }
      break;

    case "horn":
      makeTone(180, t, 0.9, 0.35 * v, "sawtooth");
      makeTone(185, t, 0.9, 0.25 * v, "square");
      break;

    case "fail":
      makeTone(420, t, 0.4, 0.3 * v, "sawtooth", 220);
      makeTone(220, t + 0.35, 0.6, 0.3 * v, "sawtooth", 110);
      break;

    case "jingle":
      [523, 659, 784, 1047].forEach((note, i) => {
        makeTone(note, t + i * 0.22, 0.35, 0.2 * v);
      });
      break;

    case "crickets":
      for (let i = 0; i < 7; i++) {
        makeTone(4500, t + i * 0.35, 0.1, 0.08 * v, "sine", 3900);
        makeTone(4600, t + i * 0.35 + 0.12, 0.1, 0.08 * v);
      }
      break;

    case "laugh":
      for (let i = 0; i < 8; i++) {
        makeTone(
          350 + (i % 3) * 100,
          t + i * 0.18,
          0.12,
          0.18 * v,
          "triangle",
          200
        );
      }
      break;

    case "applause":
      for (let i = 0; i < 50; i++) {
        makeNoise(t + Math.random() * 2, 0.07, 0.08 * v);
      }
      break;
  }
}

// ----------------------------------
// PLAYBACK
// ----------------------------------

async function playPad(index) {
  const pad = pads[index];

  if (!pad) return;

  try {
    if (pad.audioId) {
      const blob = await getStoredAudio(pad.audioId);

      if (!blob) {
        status("Audio file missing: " + pad.name);
        return;
      }

      const audioURL = URL.createObjectURL(blob);
      const audio = new Audio(audioURL);

      audio.padVolume = pad.volume ?? 1;
      audio.volume = audio.padVolume * masterVolume;

      activeAudio.add(audio);

      audio.onended = () => {
        activeAudio.delete(audio);
        URL.revokeObjectURL(audioURL);
      };

      audio.onerror = () => {
        activeAudio.delete(audio);
        URL.revokeObjectURL(audioURL);
        status("Could not play: " + pad.name);
      };

      await audio.play();
    } else if (pad.audio) {
      // Support an older saved audio Data URL if one exists.
      const audio = new Audio(pad.audio);

      audio.padVolume = pad.volume ?? 1;
      audio.volume = audio.padVolume * masterVolume;

      activeAudio.add(audio);

      audio.onended = () => activeAudio.delete(audio);

      await audio.play();
    } else {
      playEffect(pad.type, pad.volume ?? 1);
    }

    status("Playing: " + pad.name);
  } catch (error) {
    status("Playback failed. Try clicking the pad again.");
  }
}

function stopAll() {
  activeAudio.forEach(audio => {
    audio.pause();
    audio.currentTime = 0;
  });

  activeAudio.clear();

  activeSources.forEach(source => {
    try {
      source.stop();
    } catch (error) {
      // Source may have already finished.
    }
  });

  activeSources.clear();

  if (audioContext) {
    audioContext.close();
    audioContext = null;
    masterGain = null;
  }

  status("All playback stopped.");
}

// ----------------------------------
// PAD DISPLAY
// ----------------------------------

function renderPads() {
  padContainer.innerHTML = "";

  pads.forEach((pad, index) => {
    const card = document.createElement("div");
    card.className = "sound-pad";
    card.style.background = pad.color || "#334155";

    const playButton = document.createElement("button");
    playButton.className = "pad-play";

    playButton.innerHTML = `
      <span class="pad-emoji">${pad.emoji || "🎧"}</span>
      <strong>${escapeHTML(pad.name)}</strong>
      <small>▶ PLAY</small>
    `;

    playButton.onclick = () => playPad(index);

    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = 0;
    volume.max = 1;
    volume.step = 0.05;
    volume.value = pad.volume ?? 1;
    volume.className = "pad-volume";

    volume.oninput = event => {
      pad.volume = Number(event.target.value);
      savePads();
    };

    const controls = document.createElement("div");
    controls.className = "pad-controls";

    const edit = document.createElement("button");
    edit.textContent = "✎";
    edit.title = "Edit pad";
    edit.onclick = () => editPad(index);

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Delete pad";
    remove.onclick = async () => {
      const removedPad = pads[index];

      stopAll();

      if (removedPad.audioId) {
        try {
          await deleteStoredAudio(removedPad.audioId);
        } catch (error) {
          status("Could not delete the stored audio file.");
        }
      }

      pads.splice(index, 1);
      savePads();
      renderPads();
    };

    controls.append(edit, remove);
    card.append(playButton, volume, controls);
    padContainer.appendChild(card);
  });

  padCount.textContent = pads.length + " SOUNDS";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function editPad(index) {
  const pad = pads[index];

  const name = prompt("Sound name:", pad.name);
  if (name === null) return;

  const emoji = prompt("Sound emoji:", pad.emoji);
  if (emoji === null) return;

  pad.name = name || "Sound Pad";
  pad.emoji = emoji || "🎧";

  savePads();
  renderPads();
}

function addPad() {
  const name = prompt("Name your new sound pad:");

  if (!name) return;

  pads.push({
    name,
    emoji: "🎧",
    color: "#334155",
    volume: 1,
    type: null
  });

  savePads();
  renderPads();
  status("New sound pad created.");
}

// ----------------------------------
// UPLOAD AUDIO
// ----------------------------------

async function uploadAudio(files) {
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("audio/")) {
      status("Please choose an audio file.");
      continue;
    }

    const audioId = makeId();

    try {
      await storeAudio(audioId, file);

      pads.push({
        name: file.name,
        emoji: "🎧",
        color: "#334155",
        volume: 1,
        type: null,
        audioId
      });

      savePads();
      renderPads();
      status("Uploaded and saved: " + file.name);
    } catch (error) {
      status("Could not save " + file.name + ". Check browser storage.");
    }
  }
}

// ----------------------------------
// VOICE RECORDING
// ----------------------------------

async function toggleRecording() {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status("Microphone recording is not supported in this browser.");
      return;
    }

    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    recordingChunks = [];

    recorder = new MediaRecorder(recordingStream);

    recorder.ondataavailable = event => {
      if (event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const blob = new Blob(recordingChunks, {
        type: recorder.mimeType || "audio/webm"
      });

      try {
        const audioId = makeId();

        await storeAudio(audioId, blob);

        pads.push({
          name: "My Voice Recording",
          emoji: "🎙️",
          color: "#7f1d1d",
          volume: 1,
          type: null,
          audioId
        });

        savePads();
        renderPads();

        status("Voice recording saved as a new pad.");
      } catch (error) {
        status("Recording finished, but could not be saved.");
      }

      if (recordingStream) {
        recordingStream.getTracks().forEach(track => track.stop());
        recordingStream = null;
      }

      document.getElementById("record-audio").textContent = "● Record Voice";
    };

    recorder.start();

    document.getElementById("record-audio").textContent = "■ Stop Recording";
    status("Recording. Press Stop Recording when finished.");
  } catch (error) {
    status("Microphone unavailable. Check browser permissions.");
  }
}

// ----------------------------------
// BUTTONS AND STARTUP
// ----------------------------------

document.getElementById("add-pad").addEventListener("click", addPad);

document.getElementById("upload-audio").addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", event => {
  uploadAudio(event.target.files);
  fileInput.value = "";
});

document.getElementById("record-audio").addEventListener(
  "click",
  toggleRecording
);

document.getElementById("stop-all").addEventListener("click", stopAll);

masterSlider.addEventListener("input", event => {
  setMasterVolume(Number(event.target.value) / 100);
});

async function startStudio() {
  loadPads();

  if (masterSlider) {
    masterSlider.value = 80;
  }

  setMasterVolume(0.8);
  renderPads();

  try {
    await openAudioDatabase();
    status("Live Studio ready. Audio storage is available.");
  } catch (error) {
    status("Live Studio ready, but audio storage is unavailable.");
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .catch(error => {
          console.error("Service worker registration failed:", error);
        });
    });
  }
}

startStudio();
