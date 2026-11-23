// Does it work at all: trust by key, marking, refusing, upstream verification.
import { httpsTarget, markProxy, isolatedBrowser, html, newMark, sleep } from "./tls-lib.mts";
const app = await httpsTarget("app.test", { "GET /": html(`<p id=which>home over https</p>`) });
const evil = await httpsTarget("evil.test", { "GET /": html(`<p id=which>evil</p>`) }, "evil.test.pem");
const mark = newMark();
const px = await markProxy({ resolve: { "app.test": app.port, "evil.test": evil.port, "other.test": app.port }, allow: ["app.test", "evil.test"], mark });
for (const trust of ["spki", "none"] as const) {
  const browser = await isolatedBrowser(px.url, [], trust);
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let marking = true;
  cdp.on("Fetch.requestPaused", (e) => cdp.send("Fetch.continueRequest", { requestId: e.requestId, headers: marking ? Object.entries({ ...e.request.headers, "x-rp-pass": mark }).map(([name, value]) => ({ name, value: String(value) })) : undefined }).catch(() => {}));
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  const go = async (url: string) => { const r = await page.goto(url, { timeout: 8000 }).then((r) => `status ${r?.status()} text=${"" }`, (e) => "ERR " + String(e).split("\n")[0]!.slice(0, 90)); return r + " | " + (await page.locator("#which").textContent({ timeout: 500 }).catch(() => "-")); };
  console.log(trust, "marked, allowed host:", await go("https://app.test/"));
  const sec = await cdp.send("Runtime.evaluate", { expression: "isSecureContext + ' ' + location.protocol", returnByValue: true }); console.log(trust, "  secure context:", sec.result.value);
  marking = false; console.log(trust, "unmarked:", await go("https://app.test/?unmarked")); marking = true;
  console.log(trust, "host not allowed:", await go("https://other.test/"));
  console.log(trust, "upstream cert not from the public authority:", await go("https://evil.test/"));
  console.log(trust, "plain http to target name:", await go("http://app.test/"));
  console.log(trust, "direct IP, https:", await go(`https://127.0.0.1:${app.port}/`));
  await browser.close();
}
await sleep(200);
console.log(px.log.map((l) => `${l.what}: ${l.line}`).join("\n"));
console.log("server got:", app.hits.map((h) => h.method + " " + h.url).join(", "), "| evil got:", evil.hits.length);
await px.close(); await app.close(); await evil.close();
