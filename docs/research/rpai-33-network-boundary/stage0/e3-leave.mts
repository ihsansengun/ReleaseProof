// Leave-time activity through an owned proxy: is it always seen, how late can it come, and does sealing the
// proxy before a close keep it from the application?
import { target, proxy, launch, html, sleep, now } from "./lib.mts";
const P = (s: string) => `/w?s=${s}`;
const listeners: Record<string, string> = {
  "pagehide-beacon": `addEventListener("pagehide", () => navigator.sendBeacon("${P("X")}", "x"))`,
  "pagehide-keepalive": `addEventListener("pagehide", () => fetch("${P("X")}", { method: "POST", keepalive: true }))`,
  "visibility-beacon": `document.addEventListener("visibilitychange", () => navigator.sendBeacon("${P("X")}", "x"))`,
  "unload-beacon": `addEventListener("unload", () => navigator.sendBeacon("${P("X")}", "x"))`,
  "pagehide-10-beacons": `addEventListener("pagehide", () => { for (let i = 0; i < 10; i++) navigator.sendBeacon("${P("X")}&i=" + i, "x") })`,
  "pagehide-busy-then-beacon": `addEventListener("pagehide", () => { const t = performance.now(); while (performance.now() - t < 400); navigator.sendBeacon("${P("X")}", "x") })`,
  "pagehide-timer-fetch": `addEventListener("pagehide", () => setTimeout(() => fetch("${P("X")}", { method: "POST", keepalive: true }), 50))`,
  "frame-pagehide-beacon": `{ const f = document.createElement("iframe"); f.srcdoc = '<script>addEventListener("pagehide", () => navigator.sendBeacon("${P("X")}", "x"))<\\/script>'; document.body.appendChild(f) }`,
  "listener-no-network (as Next.js)": `addEventListener("pagehide", () => { window.__unloading = true })`,
};
const app = await target({ "GET /": html(`<p>home</p>`) });
const px = await proxy();
const browser = await launch(px.url);
const RUNS = Number(process.argv[2] ?? 15);
for (const mode of ["forward", "sealed"] as const) {
  for (const [name, code] of Object.entries(listeners)) {
    const lat: number[] = []; let seenRuns = 0, serverRuns = 0, expected = name.includes("10") ? 10 : name.includes("no-network") ? 0 : 1, shortRuns = 0;
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      const page = await context.newPage();
      const other = await context.newPage(); // the context lives on, as it does between the steps of a check
      await page.goto(app.origin + "/", { waitUntil: "load" });
      await page.evaluate(code.replaceAll("X", `${name}-${mode}-${run}`));
      await sleep(150);
      const p0 = px.seen.length, h0 = app.hits.length;
      if (mode === "sealed") px.state.hold = true;
      const t0 = now();
      await page.close();
      await sleep(1500);
      px.state.hold = false;
      const seen = px.seen.slice(p0).filter((h) => h.method === "POST");
      const got = app.hits.slice(h0).filter((h) => h.method === "POST");
      if (seen.length) { seenRuns++; lat.push(Math.max(...seen.map((h) => h.at - t0))); }
      if (seen.length < expected) shortRuns++;
      if (got.length) serverRuns++;
      await context.close();
    }
    console.log(JSON.stringify({ mode, name, runs: RUNS, proxySawIn: seenRuns, fewerThanExpected: shortRuns, serverReceivedIn: serverRuns, latestMsAfterCloseReturned: lat.length ? Math.max(...lat) : null, earliest: lat.length ? Math.min(...lat) : null }));
  }
}
await sleep(3000);
console.log("stragglers after everything (proxy total POST vs server total POST):", px.seen.filter((h) => h.method === "POST").length, app.hits.filter((h) => h.method === "POST").length);
await browser.close(); await px.close(); await app.close();
