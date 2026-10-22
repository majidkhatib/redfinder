"use strict";
/* Browser front end: audio capture, alerts, learning. Matching lives in detector.js. */

const THRESHOLDS_KEY = "redfinder.thresholds";   // learned per-sound thresholds
const SETTINGS_KEY = "redfinder.settings";

const $ = id => document.getElementById(id);
const banner = $("banner");   // kept as a reference: it moves into the pop-out window
const isFirefox = /firefox/i.test(navigator.userAgent);

const state = {
  ctx: null, hasWorklet: false, templates: null, templatesRate: 0,
  stream: null, source: null, tap: null,
  feat: null, matcher: null,
  learn: null,          // {until, maxScores} while learning
  hideAt: 0, lastScoresDraw: 0,
  pip: null,
};

// ---------------------------------------------------------------- storage

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode or blocked storage: settings just won't persist */ }
}

const defaultThresholds = REDFINDER_DATA.thresholds;   // from data.js
const perSound = () => storageGet(THRESHOLDS_KEY, defaultThresholds);

// ---------------------------------------------------------------- templates

async function loadTemplates(ctx) {
  if (state.templates && state.templatesRate === ctx.sampleRate) return state.templates;
  setStatus("Loading merchant sounds...");
  // decodeAudioData resamples to the context's rate, so templates match the live audio.
  state.templates = await Promise.all(REDFINDER_DATA.sounds.map(async s => {
    const bytes = Uint8Array.from(atob(REDFINDER_DATA.audio[s.file]), c => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
    }
    return new Template(s, mono, ctx.sampleRate);
  }));
  state.templatesRate = ctx.sampleRate;
  const reds = state.templates.filter(t => t.redItems.length).length;
  addLog(`Loaded ${state.templates.length} merchant sounds (${reds} can be red items) at ${ctx.sampleRate} Hz`, "info");
  return state.templates;
}

function newMatcher() {
  return new Matcher(state.templates, Number($("threshold").value) || 0.65, perSound());
}

// ---------------------------------------------------------------- capture

// Mixes the input to mono and posts ~20 ms chunks to the page. When the input has no
// data it posts silence, so the gaps between sounds keep their length.
const TAP_SOURCE = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(960); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    const len = chans.length ? chans[0].length : 128;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][i];
      this.buf[this.n++] = chans.length ? s / chans.length : 0;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

async function ensureContext() {
  if (!state.ctx) {
    state.ctx = new AudioContext();
    try {
      const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: "text/javascript" }));
      await state.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      state.hasWorklet = true;
    } catch {
      // Pages opened from disk (file://) can't load worklet modules; createTap falls back.
      state.hasWorklet = false;
    }
  }
  await state.ctx.resume();
  return state.ctx;
}

/** Node that hands mono chunks of the input to onAudio. Its output is silence. */
function createTap(ctx) {
  if (state.hasWorklet) {
    const tap = new AudioWorkletNode(ctx, "tap");
    tap.port.onmessage = e => onAudio(e.data);
    return tap;
  }
  const tap = ctx.createScriptProcessor(1024, 2, 1);
  tap.onaudioprocess = e => {
    const input = e.inputBuffer, mono = new Float32Array(input.length);
    for (let c = 0; c < input.numberOfChannels; c++) {
      const ch = input.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / input.numberOfChannels;
    }
    e.outputBuffer.getChannelData(0).fill(0);
    onAudio(mono);
  };
  return tap;
}

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

async function startDisplayCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: RAW_AUDIO, systemAudio: "include",
  });
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('No sound was shared. Click "Capture system audio" again, choose the "Entire screen" tab ' +
                    '(a window has no sound) and tick "Share system audio".');
  }
  // Only the audio is needed.
  stream.getVideoTracks().forEach(t => t.stop());
  return stream;
}

async function startDeviceCapture() {
  const deviceId = $("deviceSelect").value;
  if (!deviceId) throw new Error('Pick an input device first (click "Refresh devices").');
  return navigator.mediaDevices.getUserMedia({
    audio: { ...RAW_AUDIO, deviceId: { exact: deviceId }, channelCount: { ideal: 2 } },
  });
}

async function refreshDevices() {
  // Device names are only visible after the page has been allowed to use a microphone once.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    addLog(`Microphone permission is needed to list devices: ${e.message}`, "info");
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
  const sel = $("deviceSelect"), saved = storageGet(SETTINGS_KEY, {}).device;
  sel.innerHTML = "";
  for (const d of devices) {
    const opt = new Option(d.label || `Input ${sel.length + 1}`, d.deviceId);
    sel.add(opt);
  }
  const loopback = devices.find(d => d.deviceId === saved) ||
                   devices.find(d => /stereo mix|cable output|loopback|what u hear|wave out/i.test(d.label));
  if (loopback) sel.value = loopback.deviceId;
  if (!devices.length) sel.add(new Option("(no input devices found)", ""));
}

async function start(kind) {
  stop();
  try {
    const ctx = await ensureContext();
    await loadTemplates(ctx);
    const stream = kind === "display" ? await startDisplayCapture() : await startDeviceCapture();
    if (kind === "device") saveSettings();
    state.stream = stream;
    state.source = ctx.createMediaStreamSource(stream);
    state.tap = createTap(ctx);
    state.source.connect(state.tap);
    // The tap outputs silence; connecting it keeps it running. Never route the capture to the speakers.
    state.tap.connect(ctx.destination);
    state.feat = new Featurizer(ctx.sampleRate);
    state.matcher = newMatcher();
    stream.getAudioTracks()[0].addEventListener("ended", () => { addLog("Audio sharing ended", "info"); stop(); });
    const label = stream.getAudioTracks()[0].label || (kind === "display" ? "system audio" : "input device");
    setRunning(true, `Listening on: ${label}`);
    addLog(`Listening on: ${label}`, "info");
  } catch (e) {
    stop();
    const msg = e.name === "NotAllowedError" ? "Permission was denied or the share dialog was cancelled." : e.message;
    setStatus(msg);
    addLog(msg, "info");
    banner.querySelector(".sub").textContent = msg;
  }
}

function stop() {
  if (state.learn) finishLearning(false);
  state.tap?.port?.close();
  if (state.tap) state.tap.onaudioprocess = null;
  state.tap?.disconnect();
  state.source?.disconnect();
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = state.source = state.tap = state.matcher = null;
  setRunning(false, "Idle");
  $("level").style.width = "0";
}

// ---------------------------------------------------------------- processing

function onAudio(mono) {
  if (!state.matcher) return;
  let sq = 0;
  for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
  const db = 20 * Math.log10(Math.sqrt(sq / mono.length) + 1e-9);
  $("level").style.width = `${Math.max(0, Math.min(100, (db + 70) * 100 / 70))}%`;

  const m = state.matcher;
  for (const { template, score } of m.push(state.feat.push(mono))) onDetection(template, score);
  while (m.rejected.length) {
    const r = m.rejected.shift();
    addLog(`too close to call: ${r.best.name} ${r.bestScore.toFixed(2)} vs ${r.second.name} ${r.secondScore.toFixed(2)}`, "info");
  }
  if (state.learn) {
    const max = state.learn.maxScores;
    m.lastScores.forEach((s, i) => { if (s > max[i]) max[i] = s; });
    const left = Math.ceil((state.learn.until - performance.now()) / 1000);
    $("learnStatus").textContent = left > 0 ? `Learning... ${left} s left` : "";
    if (left <= 0) finishLearning(true);
  }
  const now = performance.now();
  if (now - state.lastScoresDraw > 250) {
    state.lastScoresDraw = now;
    drawScores(m.lastScores);
  }
  if (state.hideAt && now > state.hideAt) showBanner(null);
}

function onDetection(t, score) {
  const rarities = [...new Set(t.items.map(i => RARITY_NAMES[i.rarity]))].sort().join("/");
  if (t.redItems.length) {
    const d = describe(t, score);
    addLog(`${d.title}: ${t.name}  score=${score.toFixed(2)}  red: ${t.redItems.join(", ")}`,
           t.redRatio === 1 ? "red" : "possible");
    showBanner(d.title, d.sub, d.color, 4000);
    if ($("beep").checked) beep();
    if ($("notify").checked) notify(d.title, d.sub);
  } else if ($("showAll").checked) {
    addLog(`merchant sound ${t.name}  score=${score.toFixed(2)}  (${rarities})`, "info");
    showBanner("merchant sound", `${t.name}  (${rarities})`, "#b0b0ff", 2000);
  }
}

function drawScores(scores) {
  const top = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, 3);
  $("scores").innerHTML = "";
  for (const i of top) {
    const row = document.createElement("div");
    row.className = "score";
    row.innerHTML = `<span class="name"></span><div class="meter"><div></div></div><span></span>`;
    row.children[0].textContent = state.templates[i].name;
    row.children[1].firstChild.style.width = `${Math.max(0, scores[i]) * 100}%`;
    row.children[2].textContent = scores[i].toFixed(2);
    $("scores").append(row);
  }
}

// ---------------------------------------------------------------- learning

function startLearning() {
  const seconds = Math.max(10, Number($("learnSeconds").value) || 300);
  // Never trigger; just record how high every template scores on this audio.
  state.matcher = new Matcher(state.templates, Infinity);
  state.learn = { until: performance.now() + seconds * 1000, maxScores: new Float64Array(state.templates.length) };
  $("learn").textContent = "Stop learning";
  addLog(`Learning for ${seconds} s. Play normally, but stay away from the merchant...`, "info");
}

function finishLearning(save) {
  const learn = state.learn;
  state.learn = null;
  $("learn").textContent = "Start learning";
  $("learnStatus").textContent = "";
  if (save) {
    const floor = Number($("threshold").value) || 0.65;
    const { learned, changed } = learnThresholds(state.templates, learn.maxScores, perSound(), floor);
    storageSet(THRESHOLDS_KEY, learned);
    addLog(`Done learning. Raised ${changed.length} thresholds:`, "info");
    for (const [name, oldTh, newTh] of changed) addLog(`  ${name}  ${oldTh.toFixed(2)} -> ${newTh.toFixed(2)}`, "info");
  } else {
    addLog("Learning stopped; thresholds not changed.", "info");
  }
  if (state.stream) state.matcher = newMatcher();
}

// ---------------------------------------------------------------- alerts

function showBanner(title, sub = "", color = "", ms = 0) {
  const b = banner;
  if (!title) {
    state.hideAt = 0;
    b.className = "idle";
    b.querySelector(".title").textContent = state.stream ? "Listening..." : "Not listening";
    b.querySelector(".title").style.color = "";
    b.querySelector(".sub").textContent = "";
    return;
  }
  b.className = "";
  void b.offsetWidth;   // restart the flash animation
  b.className = "flash";
  b.querySelector(".title").textContent = title;
  b.querySelector(".title").style.color = color;
  b.querySelector(".sub").textContent = sub;
  state.hideAt = performance.now() + ms;
  document.title = `${title} - ABI Red Item Detector`;
  setTimeout(() => { document.title = "ABI Red Item Detector"; }, ms);
}

function beep() {
  const ctx = state.ctx, osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = 1200;
  gain.gain.value = 0.25;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
}

function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body, tag: "redfinder", renotify: true }); } catch { /* unsupported options */ }
}

async function togglePopout() {
  if (state.pip) { state.pip.close(); return; }
  const pip = await documentPictureInPicture.requestWindow({ width: 520, height: 150 });
  for (const sheet of document.styleSheets) {
    const style = pip.document.createElement("style");
    style.textContent = [...sheet.cssRules].map(r => r.cssText).join("\n");
    pip.document.head.append(style);
  }
  pip.document.body.style.margin = "0";
  const placeholder = document.createElement("div");
  banner.before(placeholder);
  pip.document.body.append(banner);
  state.pip = pip;
  $("popout").textContent = "Close pop-out window";
  pip.addEventListener("pagehide", () => {
    placeholder.replaceWith(banner);
    state.pip = null;
    $("popout").textContent = "Pop out always-on-top alert window";
  });
}

// ---------------------------------------------------------------- UI

function setStatus(text) { $("status").textContent = text; }

function setRunning(on, text) {
  $("dot").classList.toggle("on", on);
  $("stop").disabled = !on;
  $("learn").disabled = !on;
  setStatus(text);
  showBanner(null);
}

function addLog(text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  $("log").prepend(li);
  while ($("log").children.length > 300) $("log").lastChild.remove();
}

function saveSettings() {
  storageSet(SETTINGS_KEY, {
    beep: $("beep").checked, notify: $("notify").checked, showAll: $("showAll").checked,
    threshold: $("threshold").value, learnSeconds: $("learnSeconds").value, device: $("deviceSelect").value,
  });
}

function loadSettings() {
  const s = storageGet(SETTINGS_KEY, {});
  for (const k of ["beep", "notify", "showAll"]) if (k in s) $(k).checked = s[k];
  for (const k of ["threshold", "learnSeconds"]) if (k in s) $(k).value = s[k];
  if ($("notify").checked && !("Notification" in window && Notification.permission === "granted")) $("notify").checked = false;
}

function init() {
  loadSettings();
  if (isFirefox || !navigator.mediaDevices?.getDisplayMedia) {
    $("displaySource").classList.add("hidden");
    $("firefoxNote").classList.remove("hidden");
  }
  if (!("documentPictureInPicture" in window)) {
    $("pipRow").classList.add("hidden");
    $("pipNote").classList.remove("hidden");
  }
  $("startDisplay").onclick = () => start("display");
  $("startDevice").onclick = () => start("device");
  $("refreshDevices").onclick = refreshDevices;
  $("stop").onclick = stop;
  $("popout").onclick = () => togglePopout().catch(e => addLog(`Pop-out failed: ${e.message}`, "info"));
  $("learn").onclick = () => (state.learn ? finishLearning(false) : startLearning());
  $("resetThresholds").onclick = () => {
    storageSet(THRESHOLDS_KEY, null);
    if (state.matcher && !state.learn) state.matcher = newMatcher();
    addLog("Per-sound thresholds reset to the defaults.", "info");
  };
  $("threshold").onchange = () => { saveSettings(); if (state.matcher && !state.learn) state.matcher = newMatcher(); };
  for (const id of ["beep", "showAll", "learnSeconds", "deviceSelect"]) $(id).addEventListener("change", saveSettings);
  $("notify").onchange = async () => {
    if ($("notify").checked && "Notification" in window && Notification.permission !== "granted") {
      $("notify").checked = (await Notification.requestPermission()) === "granted";
    }
    saveSettings();
  };
  window.addEventListener("beforeunload", e => { if (state.stream) e.preventDefault(); });
}

init();
