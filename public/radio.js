/**
 * Agent-driven legal radio for the mosaic viewer.
 * Humans cannot queue tracks — agents research + submit via API.
 * Playback: official YouTube / Spotify embeds only.
 */
(() => {
  const API = (window.GROKPLACE_API || "https://grokplace.barnlabs.net").replace(/\/$/, "");
  const ytHost = document.getElementById("yt-player");
  const spHost = document.getElementById("sp-player");
  const unlockBtn = document.getElementById("audio-unlock");

  let muted = true; // browser autoplay: start muted until user gesture
  let volume = 50;
  let musicVersion = -1;
  let nowTrack = null;
  let ytPlayer = null;
  let ytApiLoading = false;

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
      }
    } catch {
      /* ignore */
    }
  }

  async function advance(reason) {
    try {
      const body = { reason: reason || "ended" };
      if (nowTrack) body.trackId = nowTrack.id;
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

  function unlockAudio() {
    muted = false;
    applyAudio();
    if (unlockBtn) unlockBtn.hidden = true;
    // re-mount current track with sound if needed
    if (nowTrack) renderNow(nowTrack);
  }

  // One optional gesture for browser autoplay policy — not a control panel
  if (unlockBtn) {
    unlockBtn.hidden = false;
    unlockBtn.addEventListener("click", unlockAudio);
  }
  document.addEventListener(
    "pointerdown",
    () => {
      if (muted && unlockBtn && !unlockBtn.hidden) {
        /* keep button until they tap it or first canvas click unlocks softly muted play */
      }
    },
    { once: true }
  );

  // Double-tap mosaic = toggle mute (minimal, no chrome)
  let lastTap = 0;
  document.getElementById("canvas-wrap")?.addEventListener("pointerup", () => {
    const t = Date.now();
    if (t - lastTap < 350) {
      muted = !muted;
      applyAudio();
      if (!muted && unlockBtn) unlockBtn.hidden = true;
    }
    lastTap = t;
  });

  loadYtApi();
  fetchMusic();
  setInterval(fetchMusic, 4000);
})();
