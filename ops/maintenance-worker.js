export default {
  fetch() {
    return new Response("grok/place is briefly offline while polling protection is installed. Please retry shortly.\n", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "900",
        "x-content-type-options": "nosniff",
      },
    });
  },
};

// Cloudflare requires the existing class export in every version that shares its DO namespace.
// Keep the real class so scheduled music alarms remain safe while HTTP is offline.
export { GrokPlaceCanvas } from "../worker/index.js";
