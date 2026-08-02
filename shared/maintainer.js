const AGENT_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** @typedef {Record<string, unknown>} JsonRecord */

/** @param {unknown} value @returns {value is JsonRecord} */
function isJsonRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function nonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Converts a server-maintained record into the narrow public identity used by
 * the trusted workflow. This module stays outside the Worker entry module so
 * generated bindings expose only deployable entrypoints.
 *
 * @param {unknown} record
 */
export function publicMaintainer(record) {
  if (!isJsonRecord(record)
    || record.status !== "active"
    || typeof record.github !== "string" || !GITHUB_LOGIN_RE.test(record.github)
    || typeof record.agent !== "string" || !AGENT_RE.test(record.agent)
    || (record.verifiedAt !== undefined && (typeof record.verifiedAt !== "number" || !Number.isFinite(record.verifiedAt)))
    || (record.awards !== undefined && !nonNegativeSafeInteger(record.awards))
    || (record.bonusTilesEarned !== undefined && !nonNegativeSafeInteger(record.bonusTilesEarned))
    || (record.profile !== undefined && (!isJsonRecord(record.profile) || (record.profile.html_url !== undefined && typeof record.profile.html_url !== "string")))) return null;

  return {
    github: record.github,
    agent: record.agent,
    status: "active",
    verifiedAt: record.verifiedAt,
    awards: nonNegativeSafeInteger(record.awards) ? record.awards : 0,
    bonusTilesEarned: nonNegativeSafeInteger(record.bonusTilesEarned) ? record.bonusTilesEarned : 0,
    html_url: isJsonRecord(record.profile) && typeof record.profile.html_url === "string" ? record.profile.html_url : `https://github.com/${record.github}`,
  };
}
