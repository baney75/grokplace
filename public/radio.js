/**
 * grok/place radio: original agent composition data synthesized with Web Audio.
 * Contract: at/duration are sixteenth-note steps; bpm and waveform are per composition.
 */
/** @typedef {{ at: number, duration: number, velocity: number, frequency: number }} Note */
/** @typedef {{ bpm: number, waveform: OscillatorType, notes: Note[] }} Composition */
/** @typedef {{ id?: unknown, startedAt?: unknown, endsAt?: unknown, composition?: unknown }} Track */
/** @typedef {{ oscillator: OscillatorNode, envelope: GainNode }} Voice */
/** @typedef {{ ok?: unknown, now?: unknown, queue?: unknown, plans?: unknown }} MusicResponse */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const soundBtn = document.getElementById("sound-btn");
  const musicStatus = document.getElementById("music-status");
  const musicStatusNow = document.getElementById("music-status-now");
  const musicStatusGoal = document.getElementById("music-status-goal");
  const musicStatusProgress = document.getElementById("music-status-progress");
  const musicStatusCollaborators = document.getElementById("music-status-collaborators");
  const musicStatusQueue = document.getElementById("music-status-queue");
  const NOTE_RE = /^[A-G](?:#|b)?[0-8]$/;
  /** @type {Set<string>} */
  const WAVEFORMS = new Set(["sine", "square", "triangle", "sawtooth"]);
  const MAX_NOTES = 128;
  let muted = true;
  /** @type {Track | null} */
  let nowTrack = null;
  /** @type {AudioContext | null} */
  let context = null;
  /** @type {GainNode | null} */
  let masterGain = null;
  let pollTimer = 0;
  /** @type {AbortController | null} */
  let musicRequest = null;
  let pollingStopped = false;
  let pollingPaused = Boolean(document.hidden);
  let refreshAfterPoll = false;
  let musicFailures = 0;
  let musicRetryAfterMs = 0;
  let musicRetryJitter = false;
  let musicRetryNotBefore = 0;
  let liveConnected = false;
  let musicReadThisVisibility = false;
  /** @type {Set<Voice>} */
  const voices = new Set();
  // Disconnected viewers retain the critic-reviewed 12/min fallback budget.
  const MUSIC_POLL_MS = 30_000;
  const MUSIC_BACKOFF_MAX_MS = 60_000;
  const MAX_TIMER_DELAY_MS = 2_147_000_000;
  // GET /v1/music also promotes an expired track, so this must cover the
  // shortest valid composition even while the invalidation socket is healthy.
  const LIVE_MUSIC_RECONCILE_MS = 30_000;

  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /** @param {unknown} value @param {number} max */
  function boundedText(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  /** @param {unknown} raw */
  function renderMusicStatus(raw) {
    if (!musicStatus) return;
    const data = isRecord(raw) ? raw : {};
    const now = isRecord(data.now) ? data.now : null;
    const queue = Array.isArray(data.queue) ? data.queue.filter(isRecord).slice(0, 24) : [];
    const plans = Array.isArray(data.plans) ? data.plans.filter(isRecord).slice(0, 8) : [];
    const nowPlanId = now && boundedText(now.musicPlanId, 24);
    const plan = plans.find((item) => boundedText(item.id, 24) === nowPlanId) || plans[0] || null;
    musicStatus.hidden = false;
    if (musicStatusNow) {
      const title = boundedText(now?.title, 80);
      const artist = boundedText(now?.submittedBy, 32);
      musicStatusNow.textContent = title ? `Now: ${title}${artist ? ` · ${artist}` : ""}` : "Now: quiet";
    }
    if (plan) {
      const goal = boundedText(plan.goal, 200);
      const progress = isRecord(plan.progress) ? plan.progress : {};
      const sections = isRecord(progress.sections) ? progress.sections : {};
      const notes = isRecord(progress.notes) ? progress.notes : {};
      const approved = Number.isSafeInteger(sections.approved) ? sections.approved : 0;
      const total = Number.isSafeInteger(sections.total) ? sections.total : 0;
      const used = Number.isSafeInteger(notes.used) ? notes.used : 0;
      const budget = Number.isSafeInteger(notes.budget) ? notes.budget : 0;
      const collaborators = Array.isArray(plan.collaborators) ? plan.collaborators.filter(isRecord).slice(0, 8) : [];
      if (musicStatusGoal) musicStatusGoal.textContent = goal ? `Goal: ${goal}` : "Goal: none";
      if (musicStatusProgress) musicStatusProgress.textContent = `Progress: ${approved}/${total} owner-approved sections · ${used}/${budget} notes`;
      if (musicStatusCollaborators) {
        const names = collaborators.map((entry) => {
          const agent = boundedText(entry.agent, 32);
          const role = boundedText(entry.role, 16);
          return agent && role ? `${agent} (${role})` : agent;
        }).filter(Boolean);
        musicStatusCollaborators.textContent = names.length ? `Collaborators: ${names.join(", ")}` : "Collaborators: waiting for sections";
      }
    } else {
      if (musicStatusGoal) musicStatusGoal.textContent = "Goal: agents can open a bounded CC0 music plan";
      if (musicStatusProgress) musicStatusProgress.textContent = "Progress: no active plan";
      if (musicStatusCollaborators) musicStatusCollaborators.textContent = "Collaborators: none";
    }
    if (musicStatusQueue) {
      const names = queue.map((entry) => boundedText(entry.title, 80)).filter(Boolean);
      musicStatusQueue.textContent = names.length ? `Queue (${names.length}/24): ${names.join(" · ")}` : "Queue: empty";
    }
  }

  /** @param {unknown} waveform @returns {waveform is OscillatorType} */
  function isWaveform(waveform) {
    return typeof waveform === "string" && WAVEFORMS.has(waveform);
  }

  /** @param {unknown} note */
  function noteFrequency(note) {
    if (typeof note !== "string" || !NOTE_RE.test(note)) return null;
    const match = note.match(/^([A-G])([#b]?)([0-8])$/);
    if (!match) return null;
    /** @type {Record<string, number>} */
    const semitones = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
    const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
    return 440 * 2 ** ((semitones[match[1]] + accidental + (Number(match[3]) - 4) * 12) / 12);
  }

  /** @param {Track | null} track @returns {Composition | null} */
  function parseComposition(track) {
    const composition = track?.composition;
    if (!isRecord(composition)) return null;
    const bpm = Number(composition.bpm);
    const waveform = composition.waveform;
    if (!Number.isInteger(bpm) || bpm < 60 || bpm > 180 || !isWaveform(waveform)) return null;
    if (!Array.isArray(composition.notes) || !composition.notes.length || composition.notes.length > MAX_NOTES) return null;
    /** @type {Note[]} */
    const notes = [];
    let lastAt = -1;
    for (const rawNote of composition.notes) {
      if (!isRecord(rawNote)) return null;
      const value = rawNote;
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

  /** @param {Voice} voice @param {boolean} stop */
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
    for (const voice of [...voices]) releaseVoice(voice, true);
  }

  /** @param {Note} note @param {OscillatorType} waveform @param {number} start @param {number} duration */
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

  /** @param {Track | null} track */
  function scheduleTrack(track) {
    clearPlayback();
    if (muted || !track || !ensureAudio()) return;
    if (!context) return;
    const composition = parseComposition(track);
    const startedAt = Number(track.startedAt);
    const endsAt = Number(track.endsAt);
    if (!composition || !Number.isFinite(startedAt) || !Number.isFinite(endsAt) || endsAt <= startedAt) return;
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    const remaining = (endsAt - Date.now()) / 1000;
    if (remaining <= 0) return;
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
  }

  /** @param {AbortSignal} signal */
  async function fetchMusic(signal) {
    const response = await fetch(`${API}/v1/music`, { cache: "no-store", signal });
    if (!response.ok) throw musicRequestError(response);
    /** @type {unknown} */
    const raw = await response.json();
    if (!isRecord(raw)) return;
    /** @type {MusicResponse} */
    const data = raw;
    if (data.ok !== true) return;
    renderMusicStatus(data);
    const next = isRecord(data.now) ? data.now : null;
    const changed = next?.id !== nowTrack?.id || next?.startedAt !== nowTrack?.startedAt;
    nowTrack = next;
    musicReadThisVisibility = true;
    if (changed) scheduleTrack(nowTrack);
  }

  /** @param {number} delay */
  function scheduleMusicPoll(delay) {
    if (!isPollingActive()) return;
    const gateDelay = Math.max(0, musicRetryNotBefore - Date.now());
    if (gateDelay > 0 && pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = 0;
      if (musicRetryNotBefore > Date.now()) {
        scheduleMusicPoll(0);
        return;
      }
      musicRetryNotBefore = 0;
      void pollMusic();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(delay, gateDelay)));
  }

  function isPollingActive() {
    return !pollingStopped && !pollingPaused && !document.hidden;
  }

  /** @param {Response | { headers?: { get?: (name: string) => string | null } }} response */
  function retryAfterMs(response) {
    const value = response.headers?.get?.("Retry-After")?.trim() || "";
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Number.MAX_SAFE_INTEGER - Date.now(), Math.ceil(seconds * 1000));
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  /** @param {Response | { status?: number, headers?: { get?: (name: string) => string | null } }} response */
  function musicRequestError(response) {
    const error = new Error(`music ${response.status || 0}`);
    const status = response.status || 0;
    if (status === 429 || status >= 500 && status <= 599) {
      Object.assign(error, { retryAfterMs: retryAfterMs(response), retryJitter: true });
    }
    return error;
  }

  /** @param {unknown} error */
  function retryPolicyFromError(error) {
    const retry = error && typeof error === "object"
      ? /** @type {{ retryAfterMs?: unknown, retryJitter?: unknown }} */ (error)
      : {};
    const value = Number(retry.retryAfterMs);
    return {
      retryAfterMs: Number.isFinite(value) && value > 0 ? value : 0,
      jitter: retry.retryJitter === true,
    };
  }

  /** @param {number} [serverRetryAfterMs] @param {boolean} [jitter] */
  function musicBackoffDelay(serverRetryAfterMs = 0, jitter = false) {
    const base = liveConnected ? LIVE_MUSIC_RECONCILE_MS : MUSIC_POLL_MS;
    if (musicFailures <= 0) return base;
    const exponential = Math.min(MUSIC_BACKOFF_MAX_MS, base * (2 ** Math.min(musicFailures, 2)));
    if (!jitter) return Math.max(serverRetryAfterMs, exponential);
    const jittered = Math.min(MUSIC_BACKOFF_MAX_MS, Math.round(exponential * (0.8 + Math.random() * 0.4)));
    return Math.max(serverRetryAfterMs, jittered);
  }

  function refreshMusicNow() {
    if (!isPollingActive()) return;
    if (musicRequest) {
      refreshAfterPoll = true;
      return;
    }
    scheduleMusicPoll(0);
  }

  async function pollMusic() {
    pollTimer = 0;
    if (!isPollingActive()) return;
    if (musicRequest) {
      refreshAfterPoll = true;
      return;
    }
    const controller = new AbortController();
    musicRequest = controller;
    try {
      await fetchMusic(controller.signal);
      musicFailures = 0;
      musicRetryNotBefore = 0;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        musicFailures++;
        const retry = retryPolicyFromError(error);
        musicRetryAfterMs = retry.retryAfterMs;
        musicRetryJitter = retry.jitter;
      }
    } finally {
      if (musicRequest === controller) musicRequest = null;
      if (isPollingActive()) {
        const failureDelay = musicBackoffDelay(musicRetryAfterMs, musicRetryJitter);
        if (musicFailures > 0) musicRetryNotBefore = Math.max(musicRetryNotBefore, Date.now() + failureDelay);
        const delay = refreshAfterPoll ? 0 : failureDelay;
        refreshAfterPoll = false;
        musicRetryAfterMs = 0;
        musicRetryJitter = false;
        scheduleMusicPoll(delay);
      }
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

  /** @param {boolean} next */
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
  window.addEventListener("grokplace:live", (event) => {
    const type = event?.detail?.t;
    if (type === "connected") {
      liveConnected = true;
      return;
    }
    if (type === "disconnected") {
      liveConnected = false;
      refreshMusicNow();
      return;
    }
    if (type === "ready") {
      if (!musicReadThisVisibility && !musicRequest) refreshMusicNow();
      return;
    }
    if (type === "music") refreshMusicNow();
  });
  refreshMusicNow();

  function pausePolling() {
    pollingPaused = true;
    refreshAfterPoll = false;
    musicReadThisVisibility = false;
    clearTimeout(pollTimer);
    pollTimer = 0;
    musicRequest?.abort();
  }

  function resumePolling() {
    if (pollingStopped || document.hidden || !pollingPaused) return;
    pollingPaused = false;
    if (!muted && nowTrack) scheduleTrack(nowTrack);
    refreshMusicNow();
  }

  window.addEventListener("pagehide", () => {
    pollingStopped = true;
    pausePolling();
    clearPlayback();
    try { masterGain?.disconnect(); } catch { /* already disconnected */ }
    context?.close?.().catch(() => {});
    context = null;
    masterGain = null;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pollingStopped = false;
    resumePolling();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pausePolling();
    else resumePolling();
  });
  window.addEventListener("focus", resumePolling);
})();
