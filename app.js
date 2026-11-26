
const STORAGE_KEY = "live-studio-v1";

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
let activeAudio = new Set();
let masterVolume = 0.8;
let recorder = null;
let recordingStream = null;
let recordingChunks = [];

const padContainer = document.getElementById("sound-pads");
const statusDisplay = document.getElementById("studio-status");
const padCount = document.getElementById("pad-count");
const fileInput = document.getElementById("audio-input");

function status(message) {
  statusDisplay.textContent = message;
}

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (
      window.AudioContext || window.webkitAudioContext
    )();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  return audioContext;
}

function savePads() {
  try {
    const data = pads.map(pad => ({
      ...pad,
      audio: null
    }));

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    status("Storage unavailable. Your current session is still active.");
  }
}

function loadPads() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (saved) {
      pads = JSON.parse(saved);
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

function makeTone(frequency, start, duration, volume, wave = "sine", endFrequency = null) {
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
    Math.max(0.002, volume * masterVolume),
    start + 0.02
  );
  gain.gain.exponentialRampToValueAtTime(
    0.001,
    start + duration
  );

  oscillator.connect(gain);
  gain.connect(ctx.destination);

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
  gain.gain.value = volume * masterVolume;

  source.connect(gain);
  gain.connect(ctx.destination);

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
        makeTone(350 + (i % 3) * 100, t + i * 0.18, 0.12, 0.18 * v, "triangle", 200);
      }
      break;

    case "applause":
      for (let i = 0; i < 50; i++) {
        makeNoise(t + Math.random() * 2, 0.07, 0.08 * v);
      }
      break;
  }
}

function playPad(index) {
  const pad = pads[index];

  if (!pad) return;

  if (pad.audio) {
    const audio = new Audio(pad.audio);
    audio.volume = pad.volume ?? 1;
    audio.play();

    activeAudio.add(audio);

    audio.onended = () => activeAudio.delete(audio);
  } else {
    playEffect(pad.type, pad.volume ?? 1);
  }

  status("Playing: " + pad.name);
}

function stopAll() {
  activeAudio.forEach(audio => {
    audio.pause();
    audio.currentTime = 0;
  });

  activeAudio.clear();

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  status("All playback stopped.");
}

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
    remove.onclick = () => {
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

function uploadAudio(files) {
  Array.from(files).forEach(file => {
    const reader = new FileReader();

    reader.onload = () => {
      pads.push({
        name: file.name,
        emoji: "🎧",
        color: "#334155",
        volume: 1,
        type: null,
        audio: reader.result
      });

      savePads();
      renderPads();
      status("Uploaded: " + file.name);
    };

    reader.readAsDataURL(file);
  });
}

async function toggleRecording() {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }

  try {
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

    recorder.onstop = () => {
      const blob = new Blob(recordingChunks, {
        type: recorder.mimeType
      });

      const reader = new FileReader();

      reader.onload = () => {
        pads.push({
          name: "My Voice Recording",
          emoji: "🎙️",
          color: "#7f1d1d",
          volume: 1,
          type: null,
          audio: reader.result
        });

        savePads();
        renderPads();
        status("Voice recording saved as a new pad.");
      };

      reader.readAsDataURL(blob);

      recordingStream.getTracks().forEach(track => track.stop());

      document.getElementById("record-audio").textContent = "● Record Voice";
    };

    recorder.start();

    document.getElementById("record-audio").textContent = "■ Stop Recording";
    status("Recording. Press Stop Recording when finished.");

  } catch (error) {
    status("Microphone unavailable. Check browser permissions.");
  }
}

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

document.getElementById("master-volume").addEventListener("input", event => {
  masterVolume = Number(event.target.value) / 100;

  document.getElementById("master-volume-value").textContent =
    event.target.value + "%";
});

loadPads();
renderPads();
