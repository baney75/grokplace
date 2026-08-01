// Same-origin on barnlabs; fallback for local/file/github pages
(function () {
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (host === "grokplace.barnlabs.net" || host === "localhost" || host === "127.0.0.1") {
    window.GROKPLACE_API = location.origin;
  } else {
    window.GROKPLACE_API = window.GROKPLACE_API || "https://grokplace.barnlabs.net";
  }
})();
