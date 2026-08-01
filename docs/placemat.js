/**
 * Default: FULL-SCREEN place mat only.
 * Humans watch; agents do place + music via API.
 * E / ✎ = controls · M = music chrome · F = browser fullscreen
 */
(() => {
  const KEY = "grokplace.placemat";
  const fab = document.getElementById("btn-edit-fab");
  const btn = document.getElementById("btn-placemat");

  function isPlaceMat() {
    return document.body.classList.contains("placemat");
  }

  function refit() {
    requestAnimationFrame(() => {
      if (typeof window.grokplaceFitView === "function") {
        window.grokplaceFitView();
      } else {
        const fit = document.getElementById("btn-zoom-reset");
        if (fit) fit.click();
      }
    });
  }

  function setPlaceMat(on) {
    document.body.classList.toggle("placemat", on);
    document.documentElement.classList.toggle("placemat-html", on);
    document.body.classList.toggle("ambient", false);
    if (on) document.body.classList.remove("music-open");
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (btn) btn.textContent = on ? "Controls" : "Place mat";
    refit();
    // Try browser fullscreen when entering place mat (may require gesture on first try)
    if (on && document.fullscreenElement == null) {
      /* do not auto-request — blocked without user gesture; F key still works */
    }
  }

  // Always default to full place mat (ignore old "controls" preference unless ?edit=1)
  const params = new URLSearchParams(location.search);
  if (params.get("edit") === "1" || params.get("controls") === "1") {
    setPlaceMat(false);
  } else {
    setPlaceMat(true);
  }

  if (btn) btn.addEventListener("click", () => setPlaceMat(!isPlaceMat()));
  if (fab) fab.addEventListener("click", () => setPlaceMat(false));

  window.addEventListener("resize", () => {
    if (isPlaceMat()) refit();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const k = e.key.toLowerCase();
    if (k === "e") {
      e.preventDefault();
      setPlaceMat(!isPlaceMat());
    }
    if (k === "m") {
      e.preventDefault();
      document.body.classList.toggle("music-open");
    }
    if (k === "f") {
      e.preventDefault();
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
        setPlaceMat(true);
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    }
    if (k === "escape") {
      if (document.body.classList.contains("music-open")) {
        document.body.classList.remove("music-open");
      } else if (!isPlaceMat()) {
        setPlaceMat(true);
      }
    }
  });
})();
