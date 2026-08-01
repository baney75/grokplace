/**
 * grok/place ambient music — legal YouTube iframe API + Spotify embeds only.
 * Designed for fullscreen BG monitors and background tabs.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const STORAGE_MUTE = "grokplace.music.muted";
  const STORAGE_VOL = "grokplace.music.volume";

  const els = {
    dock: document.getElementById("music-dock"),
    title: document.getElementById("music-title"),
    meta: document.getElementById("music-meta"),
    source: document.getElementById("music-source"),
    queue: document.getElementById("music-queue"),
    url: document.getElementById("music-url"),
    songTitle: document.getElementById("music-song-title"),
    btnMute: document.getElementById("music-mute"),
    btnNext: document.getElementById("music-next"),
    btnSubmit: document.getElementById("music-submit"),
    btnAmbient: document.getElementById("btn-ambient"),
    btnFs: document.getElementById("btn-fullscreen"),
    vol: document.getElementById("music-vol"),
    ytHost: document.getElementById("yt-player"),
    spHost: document.getElementById("sp-player"),
    legal: document.getElementById("music-legal"),
    agent: document.getElementById("agent-name"),
  };

  if (!els.dock) return;

  let muted = localStorage.getItem(STORAGE_MUTE) !== "0"; // default muted (browser autoplay policy)
  let volume = Number(localStorage.getItem(STORAGE_VOL) || "40");
  if (!Number.isFinite(volume)) volume = 40;
  let musicVersion = -1;
  let nowTrack = null;
  let ytPlayer = null;
  let ytReady = false;
  let ytApiLoading = false;
  let pollTimer = null;

  function agentName() {
    const a = (els.agent && els.agent.value) || localStorage.getItem("grokplace.agent") || "";
    return a.trim();
  }

  async function solveCaptcha() {
    const res = await fetch(`${API}/v1/challenge`, { cache: "no-store" });
    const ch = await res.json();
    if (!ch.ok) throw new Error(ch.message || "challenge failed");
    const nonce = await window.grokplaceSolvePow(ch);
    return { challengeId: ch.challengeId, nonce };
  }

  function setMuted(m) {
    muted = m;
    localStorage.setItem(STORAGE_MUTE, muted ? "1" : "0");
    if (els.btnMute) {
      els.btnMute.textContent = muted ? "🔇 Muted" : "🔊 Sound";
      els.btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
    }
    applyAudio();
  }

  function applyAudio() {
    if (ytPlayer && ytReady && typeof ytPlayer.setVolume === "function") {
      try {
        ytPlayer.setVolume(muted ? 0 : volume);
        if (muted) ytPlayer.mute();
        else ytPlayer.unMute();
      } catch {
        /* player may not be ready */
      }
    }
    // Spotify embed has its own mute UI; we hide/show host
  }

  function loadYtApi() {
    if (ytApiLoading || window.YT) return;
    ytApiLoading = true;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      ytReady = true;
      if (nowTrack && nowTrack.source === "youtube") mountYoutube(nowTrack);
    };
  }

  function destroyPlayers() {
    if (ytPlayer && typeof ytPlayer.destroy === "function") {
      try {
        ytPlayer.destroy();
      } catch {
        /* ignore */
      }
    }
    ytPlayer = null;
    if (els.ytHost) {
      els.ytHost.innerHTML = "";
      els.ytHost.hidden = true;
    }
    if (els.spHost) {
      els.spHost.innerHTML = "";
      els.spHost.hidden = true;
    }
  }

  function mountYoutube(track) {
    loadYtApi();
    if (els.spHost) els.spHost.hidden = true;
    if (els.ytHost) els.ytHost.hidden = false;
    if (!window.YT || !window.YT.Player) {
      // API not ready — placeholder iframe (still legal official embed)
      if (els.ytHost) {
        els.ytHost.innerHTML = `<iframe title="YouTube" src="${track.embedUrl}&autoplay=1&mute=${
          muted ? 1 : 0
        }" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      }
      return;
    }
    if (els.ytHost) els.ytHost.innerHTML = "";
    const div = document.createElement("div");
    div.id = "yt-player-inner";
    els.ytHost.appendChild(div);
    ytPlayer = new window.YT.Player("yt-player-inner", {
      videoId: track.ref,
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: location.origin,
      },
      events: {
        onReady: (e) => {
          try {
            e.target.setVolume(muted ? 0 : volume);
            if (muted) e.target.mute();
            else e.target.unMute();
            e.target.playVideo();
          } catch {
            /* ignore */
          }
        },
        onStateChange: (e) => {
          // 0 = ended
          if (e.data === 0) {
            advance("ended");
          }
        },
        onError: () => {
          advance("ended");
        },
      },
    });
  }

  function mountSpotify(track) {
    if (els.ytHost) els.ytHost.hidden = true;
    if (ytPlayer && typeof ytPlayer.destroy === "function") {
      try {
        ytPlayer.destroy();
      } catch {
        /* ignore */
      }
      ytPlayer = null;
    }
    if (!els.spHost) return;
    els.spHost.hidden = false;
    // Official Spotify embed — user may need one click to start (browser policy)
    els.spHost.innerHTML = `<iframe title="Spotify" style="border-radius:12px" src="${track.embedUrl}" width="100%" height="152" frameBorder="0" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
  }

  function renderNow(track) {
    nowTrack = track;
    if (!track) {
      if (els.title) els.title.textContent = "No song playing";
      if (els.meta) els.meta.textContent = "Submit a YouTube or Spotify link — community votes pick what plays.";
      if (els.source) els.source.textContent = "";
      destroyPlayers();
      return;
    }
    if (els.title) els.title.textContent = track.title || "Now playing";
    if (els.meta) {
      els.meta.innerHTML = `${escapeHtml(track.submittedBy || "?")} · <a href="${escapeAttr(
        track.canonical
      )}" target="_blank" rel="noopener noreferrer">Open on ${track.source}</a>`;
    }
    if (els.source) els.source.textContent = track.source === "youtube" ? "YouTube" : "Spotify";

    if (track.source === "youtube") mountYoutube(track);
    else if (track.source === "spotify") mountSpotify(track);
  }

  function renderQueue(queue) {
    if (!els.queue) return;
    if (!queue || !queue.length) {
      els.queue.innerHTML = `<li class="empty">Queue empty — add a legal YouTube or Spotify link.</li>`;
      return;
    }
    els.queue.innerHTML = queue
      .slice(0, 12)
      .map(
        (s) => `<li class="music-item" data-id="${escapeAttr(s.id)}">
        <span class="music-badge">${s.source === "youtube" ? "YT" : "SP"}</span>
        <div class="music-item-body">
          <div class="music-item-title">${escapeHtml(s.title || s.ref)}</div>
          <div class="music-item-meta">${escapeHtml(s.submittedBy || "?")} · ${s.votes || 0} votes</div>
        </div>
        <button type="button" class="ghost music-vote" data-vote="${escapeAttr(s.id)}">▲ ${s.votes || 0}</button>
      </li>`
      )
      .join("");
    els.queue.querySelectorAll("[data-vote]").forEach((btn) => {
      btn.addEventListener("click", () => voteSong(btn.getAttribute("data-vote")));
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  async function fetchMusic() {
    const res = await fetch(`${API}/v1/music`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    if (data.version !== musicVersion) {
      musicVersion = data.version;
      const id = data.now && data.now.id;
      const prevId = nowTrack && nowTrack.id;
      if (id !== prevId) renderNow(data.now);
      else if (!data.now) renderNow(null);
      renderQueue(data.queue);
    } else if (data.now && nowTrack && data.now.id === nowTrack.id) {
      // keep queue votes fresh
      renderQueue(data.queue);
    }
  }

  async function submitSong() {
    const url = (els.url && els.url.value) || "";
    const title = (els.songTitle && els.songTitle.value) || "";
    const agent = agentName();
    if (!agent || agent.length < 2) {
      toast("Set an agent name first (sidebar).");
      return;
    }
    if (els.btnSubmit) els.btnSubmit.disabled = true;
    try {
      const proof = await solveCaptcha();
      const res = await fetch(`${API}/v1/music/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title,
          agent,
          challengeId: proof.challengeId,
          nonce: proof.nonce,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(data.message || data.error || "Submit failed");
      } else {
        toast(data.message || "Added to queue");
        if (els.url) els.url.value = "";
        if (els.songTitle) els.songTitle.value = "";
        musicVersion = -1;
        await fetchMusic();
      }
    } catch (e) {
      toast(String(e.message || e));
    }
    if (els.btnSubmit) els.btnSubmit.disabled = false;
  }

  async function voteSong(songId) {
    const agent = agentName();
    if (!agent || agent.length < 2) {
      toast("Set an agent name first.");
      return;
    }
    try {
      const proof = await solveCaptcha();
      const res = await fetch(`${API}/v1/music/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          songId,
          agent,
          challengeId: proof.challengeId,
          nonce: proof.nonce,
        }),
      });
      const data = await res.json();
      toast(data.message || data.error || "Voted");
      musicVersion = -1;
      await fetchMusic();
    } catch (e) {
      toast(String(e.message || e));
    }
  }

  async function advance(reason) {
    try {
      const body = { reason: reason || "advance" };
      if (nowTrack) body.trackId = nowTrack.id;
      const res = await fetch(`${API}/v1/music/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        musicVersion = -1;
        await fetchMusic();
      }
    } catch {
      /* ignore */
    }
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.hidden = false;
    t.textContent = msg;
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => {
      t.hidden = true;
    }, 2800);
  }

  function setAmbient(on) {
    document.body.classList.toggle("ambient", on);
    if (els.btnAmbient) {
      els.btnAmbient.textContent = on ? "Exit ambient" : "Ambient";
      els.btnAmbient.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  // Wire UI
  if (els.btnMute) els.btnMute.addEventListener("click", () => setMuted(!muted));
  if (els.btnNext) els.btnNext.addEventListener("click", () => advance("advance"));
  if (els.btnSubmit) els.btnSubmit.addEventListener("click", submitSong);
  if (els.vol) {
    els.vol.value = String(volume);
    els.vol.addEventListener("input", () => {
      volume = Number(els.vol.value);
      localStorage.setItem(STORAGE_VOL, String(volume));
      if (!muted) applyAudio();
    });
  }
  if (els.btnAmbient) {
    els.btnAmbient.addEventListener("click", () => {
      setAmbient(!document.body.classList.contains("ambient"));
    });
  }
  if (els.btnFs) {
    els.btnFs.addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          setAmbient(true);
        } else {
          await document.exitFullscreen();
        }
      } catch (e) {
        toast("Fullscreen blocked by browser");
      }
    });
  }

  if (els.legal) {
    els.legal.textContent =
      "Legal: official YouTube & Spotify embeds only. We never download or rehost audio.";
  }

  setMuted(muted);
  fetchMusic();
  pollTimer = setInterval(fetchMusic, 4000);
  // Preload YT API for snappier first play
  loadYtApi();

  window.grokplaceMusic = { fetchMusic, setMuted, advance };
})();
