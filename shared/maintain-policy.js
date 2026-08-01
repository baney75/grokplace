/** Canonical path policy for maintainer auto-merge and tile awards. */
export function isMaintainAwardPath(input) {
  const path = String(input || "").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".github")) return false;
  if (/secret|\.env|favicon-embed/i.test(path)) return false;
  if (/^(README|AGENTS|CONTRIBUTING|MAINTAIN|ADVERSARIAL)\.md$/.test(path)) return true;
  if (/^public\/(styles\.css|logo\.svg|robots\.txt)$/.test(path)) return true;
  return /^docs\/[A-Za-z0-9._/-]+\.(md|css|svg|txt|png|jpg|jpeg|webp|ico|webmanifest|map)$/.test(path);
}
