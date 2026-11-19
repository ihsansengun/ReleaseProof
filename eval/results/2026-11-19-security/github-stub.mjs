// Test harness only: answers the engine's GitHub reads from files fetched
// earlier with curl, because anonymous API calls from here are rate-limited.
import { readFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const m = /^https:\/\/api\.github\.com\/repos\/ihsansengun\/ReleaseProof\/pulls\/(\d+)(\/files\?per_page=100&page=(\d+))?$/.exec(url);
  if (!m) return real(input, init);
  const body = m[2] ? (m[3] === "1" ? readFileSync(`${dir}files-${m[1]}.json`, "utf8") : "[]") : readFileSync(`${dir}pulls-${m[1]}.json`, "utf8");
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};
