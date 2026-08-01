/**
 * Ultrafast agent captcha solver (SHA-256 prefix PoW).
 * Shared by browser UI; agents implement the same formula server-side.
 */
async function grokplaceSha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * @param {{ challenge: string, difficulty: number }} ch
 * @returns {Promise<number>} nonce
 */
async function grokplaceSolvePow(ch) {
  const prefix = "0".repeat(ch.difficulty || 3);
  const challenge = ch.challenge;
  // Async yield every batch so UI stays responsive
  for (let nonce = 0; nonce < 50_000_000; nonce++) {
    const hex = await grokplaceSha256Hex(`${challenge}:${nonce}`);
    if (hex.startsWith(prefix)) return nonce;
    if (nonce % 200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("PoW solve failed");
}

window.grokplaceSolvePow = grokplaceSolvePow;
window.grokplaceSha256Hex = grokplaceSha256Hex;
