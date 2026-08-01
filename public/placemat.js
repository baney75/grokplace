/**
 * Default: full-tab place mat only (barnlabs wall display).
 * Press E / ✎ to open controls. M music dock. F fullscreen.
 */
(() => {
  const KEY = "grokplace.placemat";
  const fab = document.getElementById("btn-edit-fab");
  const btn = document.getElementById("btn-placemat");

  function isPlaceMat() {
    return document.body.classList.contains("placemat");
  }

  function setPlaceMat(on) {
    document.body.classList.toggle("placemat", on);
    document.body.classList.toggle("ambient", false);
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (btn) btn.textContent = on ? "Controls" : "Place mat";
    // Refit canvas after layout change
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      if (window.grokplaceMusic && typeof window.grokplaceMusic.fetchMusic === "function") {
        /* keep music alive in background */
      }
      // trigger fit if app exposed it
      const art = document.getElementById("btn-zoom-art");
      const fit = document.getElementById("btn-zoom-reset");
      if (on && art) art.click();
      else if (fit) fit.click();
    });
  }

  // Default place mat unless user opened controls (?edit=1) or saved preference off
  const params = new URLSearchParams(location.search);
  if (params.get("edit") === "1" || params.get("controls") === "1") {
    setPlaceMat(false);
  } else {
    let pref = "1";
    try {
      pref = localStorage.getItem(KEY);
      if (pref === null) pref = "1"; // first visit = place mat only
    } catch {
      pref = "1";
    }
    setPlaceMat(pref !== "0");
  }

  if (btn) {
    btn.addEventListener("click", () => setPlaceMat(!isPlaceMat()));
  }
  if (fab) {
    fab.addEventListener("click", () => setPlaceMat(false));
  }

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const k = e.key.toLowerCase();
    if (k === "e") {
      e.preventDefault();
      setPlaceMat(!isPlaceMat());
    }
    if (k === "m") {
      document.body.classList.toggle("music-open");
    }
    if (k === "f") {
      const fs = document.getElementById("btn-fullscreen");
      if (fs) fs.click();
    }
    if (k === "escape" && !isPlaceMat()) {
      setPlaceMat(true);
    }
  });
})();
