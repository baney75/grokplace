/**
 * grok/place radio: original agent composition data synthesized with Web Audio.
 * Contract: at/duration are sixteenth-note steps; bpm and waveform are per composition.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const soundBtn = document.getElementById("sound-btn");
  const NOTE_RE = /^[A-G](?:#|b)?[0-8]$/;
  const WAVEFORMS = new Set(["sine", "square", "triangle", "sawtooth"]);
  const MAX_NOTES = 128;
  let muted = true;
  let nowTrack = null;
  let context = null;
  let masterGain = null;
  let endTimer = 0;
  let pollTimer = 0;
  let musicRequest = null;
  let advanceRequest = null;
  let pollingStopped = false;
  let refreshAfterPoll = false;
  const voices = new Set();

  function noteFrequency(note) {
    if (typeof note !== "string" || !NOTE_RE.test(note)) return null;
    const match = note.match(/^([A-G])([#b]?)([0-8])$/);
    const semitones = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
    const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
    return 440 * 2 ** ((semitones[match[1]] + accidental + (Number(match[3]) - 4) * 12) / 12);
  }

  function parseComposition(track) {
    const composition = track?.composition;
    if (!composition || typeof composition !== "object") return null;
    const bpm = Number(composition.bpm);
    const waveform = composition.waveform;
    if (!Number.isInteger(bpm) || bpm < 60 || bpm > 180 || !WAVEFORMS.has(waveform)) return null;
    if (!Array.isArray(composition.notes) || !composition.notes.length || composition.notes.length > MAX_NOTES) return null;
    const notes = [];
    let lastAt = -1;
    for (const value of composition.notes) {
      const at = Number(value?.at);
      const duration = Number(value?.duration);
      const velocity = value?.velocity == null ? 0.7 : Number(value.velocity);
      const frequency = noteFrequency(value?.note);
      if (!frequency || !Number.isInteger(at) || at < 0 || at > 255 || at < lastAt || !Number.isInteger(duration) || duration < 1 || duration > 16 || !Number.isFinite(velocity) || velocity < 0.05 || velocity > 1) return null;
      notes.push({ at, duration, velocity, frequency });
      lastAt = at;
    }
    return { bpm, waveform, notes };
  }

  function ensureAudio() {
    if (!context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return false;
      context = new AudioContext();
      masterGain = context.createGain();
      masterGain.gain.value = 0.35;
      masterGain.connect(context.destination);
    }
    if (context.state === "suspended") context.resume().catch(() => {});
    return true;
  }

  function releaseVoice(voice, stop) {
    if (!voices.has(voice)) return;
    voices.delete(voice);
    if (stop) {
      try { voice.oscillator.stop(); } catch { /* already stopped */ }
    }
    voice.oscillator.disconnect();
    voice.envelope.disconnect();
  }

  function clearPlayback() {
    clearTimeout(endTimer);
    endTimer = 0;
    for (const voice of [...voices]) releaseVoice(voice, true);
  }

  function scheduleVoice(note, waveform, start, duration) {
    if (!context || !masterGain || voices.size >= MAX_NOTES || duration <= 0) return;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const voice = { oscillator, envelope };
    voices.add(voice);
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(note.frequency, start);
    const peak = Math.max(0.008, Math.min(0.18, note.velocity * 0.16));
    const attackEnd = start + Math.min(0.015, duration / 4);
    const releaseStart = Math.max(attackEnd, start + duration - Math.min(0.04, duration / 3));
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(peak, attackEnd);
    envelope.gain.setValueAtTime(peak, releaseStart);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope).connect(masterGain);
    oscillator.onended = () => releaseVoice(voice, false);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  function scheduleTrack(track) {
    clearPlayback();
    if (muted || !track || !ensureAudio()) return;
    const composition = parseComposition(track);
    const startedAt = Number(track.startedAt);
    const endsAt = Number(track.endsAt);
    if (!composition || !Number.isFinite(startedAt) || !Number.isFinite(endsAt) || endsAt <= startedAt) return;
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    const remaining = (endsAt - Date.now()) / 1000;
    if (remaining <= 0) { advance(); return; }
    const stepSeconds = 60 / composition.bpm / 4;
    const audioOrigin = context.currentTime + 0.025;
    for (const note of composition.notes) {
      const noteStart = note.at * stepSeconds;
      const noteEnd = (note.at + note.duration) * stepSeconds;
      const audibleStart = Math.max(elapsed, noteStart);
      const audibleEnd = Math.min(elapsed + remaining, noteEnd);
      if (audibleEnd <= audibleStart) continue;
      scheduleVoice(note, composition.waveform, audioOrigin + Math.max(0, noteStart - elapsed), audibleEnd - audibleStart);
    }
    endTimer = setTimeout(advance, Math.max(0, endsAt - Date.now() - 75));
  }

  async function fetchMusic(signal) {
    const response = await fetch(`${API}/v1/music`, { cache: "no-store", signal });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.ok) return;
    const next = data.now || null;
    const changed = next?.id !== nowTrack?.id || next?.startedAt !== nowTrack?.startedAt;
    nowTrack = next;
    if (changed) scheduleTrack(nowTrack);
  }

  function scheduleMusicPoll(delay) {
    if (pollingStopped) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollMusic, delay);
  }

  async function pollMusic() {
    pollTimer = 0;
    if (pollingStopped) return;
    if (musicRequest) {
      refreshAfterPoll = true;
      return;
    }
    const controller = new AbortController();
    musicRequest = controller;
    try {
      await fetchMusic(controller.signal);
    } catch {
      /* Radio failure must not affect the canvas. */
    } finally {
      if (musicRequest === controller) musicRequest = null;
      const delay = refreshAfterPoll ? 0 : 4000;
      refreshAfterPoll = false;
      scheduleMusicPoll(delay);
    }
  }

  async function advance() {
    if (!nowTrack || advanceRequest || pollingStopped) return;
    const compositionId = nowTrack.id;
    const controller = new AbortController();
    advanceRequest = controller;
    try {
      const response = await fetch(`${API}/v1/music/advance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ compositionId, advanceToken: nowTrack.advanceToken }), signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok) {
        nowTrack = data.now || null;
        scheduleTrack(nowTrack);
      }
      // A delayed timer may race server auto-promotion and receive stale; reconcile now.
      refreshAfterPoll = true;
      scheduleMusicPoll(0);
    } catch {
      refreshAfterPoll = true;
      scheduleMusicPoll(0);
    }
    finally {
      if (advanceRequest === controller) advanceRequest = null;
    }
  }

  function syncSoundUi() {
    if (!soundBtn) return;
    soundBtn.classList.toggle("is-on", !muted);
    soundBtn.setAttribute("aria-pressed", String(!muted));
    soundBtn.setAttribute("aria-label", muted ? "Enable original agent-composed music" : "Mute music");
    soundBtn.title = muted ? "Enable music" : "Mute music";
    const icon = soundBtn.querySelector(".sound-icon");
    const label = soundBtn.querySelector(".sound-label");
    if (icon) icon.textContent = muted ? "🔇" : "🔊";
    if (label) label.textContent = muted ? "Music" : "Mute";
  }

  function setMuted(next) {
    muted = Boolean(next);
    if (muted) clearPlayback();
    else scheduleTrack(nowTrack);
    syncSoundUi();
    return muted;
  }

  soundBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setMuted(!muted);
  });
  window.grokplaceToggleMute = () => setMuted(!muted);
  window.grokplaceSetMuted = setMuted;
  window.grokplaceEnableSound = () => setMuted(false);
  syncSoundUi();
  scheduleMusicPoll(0);

  window.addEventListener("pagehide", () => {
    pollingStopped = true;
    clearTimeout(pollTimer);
    pollTimer = 0;
    musicRequest?.abort();
    advanceRequest?.abort();
    clearPlayback();
    try { masterGain?.disconnect(); } catch { /* already disconnected */ }
    context?.close?.().catch(() => {});
    context = null;
    masterGain = null;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pollingStopped = false;
    if (!muted && nowTrack) scheduleTrack(nowTrack);
    scheduleMusicPoll(0);
  });
})();
