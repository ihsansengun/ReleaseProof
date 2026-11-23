// A page that embeds a frame from another site (a payment or sign-in widget), and loads a script from it.
import { httpsTarget, markProxy, isolatedBrowser, html, js, newMark, sleep } from "./tls-lib.mts";
const widget = await httpsTarget("widget.test", { "GET /frame": html(`<p>widget</p><script>fetch("/collect?s=widget-own", { method: "POST" }); fetch("https://app.test/w?s=widget-to-app", { method: "POST", mode: "no-cors" })</script>`), "GET /lib.js": js(`window.libLoaded = true; fetch("/w?s=by-third-party-script", { method: "POST" })`) });
const app = await httpsTarget("app.test", { "GET /": html(`<p id=which>home</p><script src="https://widget.test/lib.js"></script><iframe src="https://widget.test/frame"></iframe>`) });
const mark = newMark();
const px = await markProxy({ resolve: { "app.test": app.port, "widget.test": widget.port }, allow: ["app.test", "widget.test"], mark });
for (const attachFrames of [false, true]) {
  const browser = await isolatedBrowser(px.url);
  const context = await browser.newContext(); const page = await context.newPage();
  const paused: string[] = [];
  const arm = async (cdp: any, who: string) => {
    cdp.on("Fetch.requestPaused", (e: any) => { paused.push(`${who}: ${e.request.method} ${e.request.url.replace("https://", "")} type=${e.resourceType}`); cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) }).catch(() => {}); });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  };
  await arm(await context.newCDPSession(page), "page");
  if (attachFrames) page.on("frameattached", async (f) => { try { await arm(await context.newCDPSession(f), "frame"); } catch (e) { paused.push("attach to frame failed: " + String(e).slice(0, 70)); } });
  const l0 = px.log.length, a0 = app.hits.length, w0 = widget.hits.length;
  await page.goto(app.origin + "/", { waitUntil: "load" }).catch((e) => console.log(String(e).slice(0, 100))); await sleep(1200);
  console.log(JSON.stringify({ attachFrames, frames: page.frames().map((f) => f.url().replace("https://", "")), libLoaded: await page.evaluate("window.libLoaded === true"), paused, appGot: app.hits.slice(a0).filter((h) => h.method !== "GET").map((h) => h.url), widgetGot: widget.hits.slice(w0).map((h) => `${h.method} ${h.url}`), proxyRefused: px.log.slice(l0).filter((l) => l.what.startsWith("refused")).map((l) => l.line.replace("https://", "")) }, null, 1));
  await browser.close();
}
await px.close(); await app.close(); await widget.close();
