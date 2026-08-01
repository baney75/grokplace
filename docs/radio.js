/**
 * Agent-driven legal radio for the mosaic viewer.
 * Humans cannot queue tracks — agents research + submit via API.
 * Playback: official YouTube / Spotify embeds only.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const ytHost = document.getElementById("yt-player");
  const spHost = document.getElementById("sp-player");

  let muted = true; // browser autoplay: start muted until first gesture (no UI)
  let volume = 50;
  let musicVersion = -1;
  let nowTrack = null;
  let ytPlayer = null;
  let ytApiLoading = false;
  let endsTimer = null;

  function clearEndsTimer() {
    if (endsTimer) {
      clearTimeout(endsTimer);
      endsTimer = null;
    }
  }

  function scheduleEndsAt(track) {
    clearEndsTimer();
    if (!track || !track.endsAt) return;
    const ms = Math.max(1000, track.endsAt - Date.now());
    endsTimer = setTimeout(() => {
      advance("timeout");
    }, ms);
  }

  function isLegalEmbedUrl(url, source) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return false;
      if (source === "youtube") {
        return (
          (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") &&
          /^\/embed\/[\w-]{11}$/.test(u.pathname)
        );
      }
      if (source === "spotify") {
        return (
          u.hostname === "open.spotify.com" &&
          /^\/embed\/(track|album|playlist|episode)\/[a-zA-Z0-9]{10,32}$/.test(u.pathname)
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  function loadYtApi() {
    if (ytApiLoading || window.YT) return;
    ytApiLoading = true;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      if (nowTrack && nowTrack.source === "youtube") mountYoutube(nowTrack);
    };
  }

  function destroyPlayers() {
    clearEndsTimer();
    if (ytPlayer && typeof ytPlayer.destroy === "function") {
      try {
        ytPlayer.destroy();
      } catch {
        /* ignore */
      }
    }
    ytPlayer = null;
    if (ytHost) {
      ytHost.innerHTML = "";
      ytHost.hidden = true;
    }
    if (spHost) {
      spHost.innerHTML = "";
      spHost.hidden = true;
    }
  }

  function applyAudio() {
    if (ytPlayer && typeof ytPlayer.setVolume === "function") {
      try {
        ytPlayer.setVolume(muted ? 0 : volume);
        if (muted) ytPlayer.mute();
        else ytPlayer.unMute();
      } catch {
        /* ignore */
      }
    }
  }

  function mountYoutube(track) {
    if (!track || track.source !== "youtube" || !/^[\w-]{11}$/.test(track.ref || "")) return;
    const embedUrl = `https://www.youtube.com/embed/${track.ref}?enablejsapi=1&rel=0&modestbranding=1&playsinline=1`;
    if (!isLegalEmbedUrl(embedUrl, "youtube")) return;
    loadYtApi();
    if (spHost) spHost.hidden = true;
    if (ytHost) ytHost.hidden = false;

    if (!window.YT || !window.YT.Player) {
      if (ytHost) {
        ytHost.innerHTML = `<iframe title="YouTube" src="${embedUrl}&autoplay=1&mute=${
          muted ? 1 : 0
        }" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      }
      return;
    }
    if (ytHost) ytHost.innerHTML = "";
    const div = document.createElement("div");
    div.id = "yt-player-inner";
    ytHost.appendChild(div);
    ytPlayer = new window.YT.Player("yt-player-inner", {
      videoId: track.ref,
      host: "https://www.youtube.com",
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
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
          if (e.data === 0) advance("ended");
        },
        onError: () => advance("ended"),
      },
    });
  }

  function mountSpotify(track) {
    if (!track || track.source !== "spotify") return;
    const [kind, id] = String(track.ref || "").split("/");
    if (!["track", "album", "playlist", "episode"].includes(kind) || !/^[a-zA-Z0-9]{10,32}$/.test(id || "")) {
      return;
    }
    const embedUrl = `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator&theme=0`;
    if (!isLegalEmbedUrl(embedUrl, "spotify")) return;
    if (ytPlayer && typeof ytPlayer.destroy === "function") {
      try {
        ytPlayer.destroy();
      } catch {
        /* ignore */
      }
      ytPlayer = null;
    }
    if (ytHost) ytHost.hidden = true;
    if (!spHost) return;
    spHost.hidden = false;
    spHost.innerHTML = `<iframe title="Spotify" src="${embedUrl}" width="100%" height="152" frameBorder="0" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
  }

  function renderNow(track) {
    nowTrack = track;
    if (!track) {
      destroyPlayers();
      return;
    }
    if (track.source === "youtube") mountYoutube(track);
    else if (track.source === "spotify") mountSpotify(track);
    scheduleEndsAt(track);
  }

  async function fetchMusic() {
    try {
      const res = await fetch(`${API}/v1/music`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;
      if (data.version !== musicVersion) {
        musicVersion = data.version;
        const id = data.now && data.now.id;
        const prev = nowTrack && nowTrack.id;
        if (id !== prev) renderNow(data.now);
        else if (!data.now) renderNow(null);
        else if (data.now) {
          // same track: refresh advanceToken / endsAt for client advance
          nowTrack = data.now;
          scheduleEndsAt(data.now);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function advance(reason) {
    try {
      const body = { reason: reason === "timeout" ? "timeout" : "ended" };
      if (nowTrack) {
        body.trackId = nowTrack.id;
        if (nowTrack.advanceToken) body.advanceToken = nowTrack.advanceToken;
      }
      const res = await fetch(`${API}/v1/music/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        musicVersion = -1;
        await fetchMusic();
      }
    } catch {
      /* ignore */
    }
  }

  const soundBtn = document.getElementById("sound-btn");

  function syncSoundUi() {
    if (!soundBtn) return;
    const icon = soundBtn.querySelector(".sound-icon");
    const label = soundBtn.querySelector(".sound-label");
    soundBtn.classList.toggle("needs-enable", muted);
    soundBtn.classList.toggle("is-on", !muted);
    soundBtn.hidden = false;
    soundBtn.style.display = "inline-flex";
    soundBtn.setAttribute("aria-pressed", muted ? "false" : "true");
    if (muted) {
      soundBtn.setAttribute("aria-label", "Enable sound");
      soundBtn.title = "Enable sound";
      if (icon) icon.textContent = "🔇";
      if (label) label.textContent = "Enable sound";
    } else {
      soundBtn.setAttribute("aria-label", "Mute");
      soundBtn.title = "Mute";
      if (icon) icon.textContent = "🔊";
      if (label) label.textContent = "Mute";
    }
  }

  function setMuted(next) {
    muted = Boolean(next);
    applyAudio();
    // Spotify iframes: remount when unmuting so playback can start after gesture
    if (!muted && nowTrack) renderNow(nowTrack);
    else if (muted && ytPlayer && typeof ytPlayer.mute === "function") {
      try {
        ytPlayer.mute();
        ytPlayer.setVolume(0);
      } catch {
        /* ignore */
      }
    }
    syncSoundUi();
    return muted;
  }

  function enableSound() {
    setMuted(false);
  }

  // Bottom-center mute / enable control
  if (soundBtn) {
    soundBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (muted) enableSound();
      else setMuted(true);
    });
    // Ensure visible even if older CSS cached
    soundBtn.hidden = false;
    syncSoundUi();
  }

  window.grokplaceToggleMute = () => setMuted(!muted);
  window.grokplaceSetMuted = setMuted;
  window.grokplaceEnableSound = enableSound;

  loadYtApi();
  fetchMusic();
  setInterval(fetchMusic, 4000);
  syncSoundUi();
})();
