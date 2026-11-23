// Can a navigation be held while the engine acts? What does the old document do meanwhile? How is a held one ended?
import { target, launch, html, sleep, now } from "./lib.mts";
const second = `<input aria-label="Name" autofocus oninput="fetch('/taken?typed=' + this.value)"><p id=which>second</p>`;
const app = await target({
  "GET /enter-replace": html(`<input aria-label="Name" onfocus="location.replace('/second')"><p id=which>first</p>`),
  "GET /enter-form": html(`<form method=post action=/second-post></form><input aria-label="Name" onfocus="document.forms[0].submit()"><p id=which>first</p>`),
  "GET /enter-href-later": html(`<input aria-label="Name"><p id=which>first</p><script>setTimeout(() => location.href = '/second', 300)</script>`),
  "GET /enter-meta": html(`<meta http-equiv=refresh content="0.3;url=/second"><input aria-label="Name"><p id=which>first</p>`),
  "GET /enter-js": html(`<input aria-label="Name" onfocus="location.href = 'javascript:&quot;<input aria-label=Name autofocus oninput=fetch(\\'/taken?typed=\\'+this.value)><p id=which>jsdoc</p>&quot;'"><p id=which>first</p>`),
  "GET /enter-open": html(`<input aria-label="Name" onfocus="document.open(); document.write('<input aria-label=Name autofocus oninput=&quot;fetch(\\'/taken?typed=\\'+this.value)&quot;><p id=which>opened</p>'); document.close(); document.querySelector('input').focus()"><p id=which>first</p>`),
  "GET /enter-blob": html(`<input aria-label="Name" onfocus="location.href = URL.createObjectURL(new Blob(['<input aria-label=Name autofocus oninput=fetch(\\'/taken?typed=\\'+this.value)><p id=which>blob</p>'], { type: 'text/html' }))"><p id=which>first</p>`),
  "GET /enter-reload": html(`<input aria-label="Name" onfocus="location.reload()"><p id=which>first</p>`),
  "GET /enter-back": html(`<input aria-label="Name" onfocus="history.back()"><p id=which>first-after-push</p>`),
  "GET /second": html(second),
  "POST /second-post": html(second),
  "GET /taken": (_q, res) => { res.writeHead(200); res.end("{}"); },
});
const browser = await launch();
type End = "fail" | "204" | "never";
async function run(path: string, end: End, input: "keyboard" | "none" = "keyboard") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const main = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const held: { id: string; url: string; method: string; at: number; type?: string }[] = [];
  let holding = false;
  cdp.on("Fetch.requestPaused", (e) => {
    const isMainDocument = e.resourceType === "Document" && e.frameId === main;
    if (holding && isMainDocument) return void held.push({ id: e.requestId, url: e.request.url.replace(app.origin, ""), method: e.request.method, at: now(), type: e.resourceType });
    cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.send("Page.enable");
  const navs: string[] = [];
  cdp.on("Page.frameNavigated", (e) => void (e.frame.parentId === undefined && navs.push(e.frame.url.replace(app.origin, "").slice(0, 40))));
  if (path === "/enter-back") { await page.goto(app.origin + "/second"); }
  await page.goto(app.origin + path, { waitUntil: "load" });
  navs.length = 0;
  const h0 = app.hits.length;
  holding = true;
  const t0 = now();
  // The engine's act: focus the field with a real click, then type with the real keyboard.
  let typed = "ok";
  if (input === "keyboard") {
    const box = await page.locator("input").first().boundingBox();
    await page.mouse.click(box!.x + 5, box!.y + 5);
    await sleep(600); // long enough for any navigation the page starts to have been asked for
    await page.keyboard.type("SECRET", { delay: 20 }).catch((e) => (typed = String(e).slice(0, 60)));
  } else await sleep(900);
  // While held: does the old document answer, and what does it say?
  const t1 = now();
  const during = await Promise.race([cdp.send("Runtime.evaluate", { expression: "document.getElementById('which')?.textContent + '|' + (document.querySelector('input')?.value ?? '')", returnByValue: true }).then((r) => r.result.value as string, (e) => "ERR " + String(e).slice(0, 50)), sleep(3000).then(() => "NO ANSWER in 3s")]);
  const answeredIn = now() - t1;
  const arrivedWhileHeld = app.hits.slice(h0).map((h) => h.method + " " + h.url);
  // End the held navigation.
  for (const h of held) {
    if (end === "fail") await cdp.send("Fetch.failRequest", { requestId: h.id, errorReason: "Aborted" }).catch((e) => console.log("fail err", String(e).slice(0, 80)));
    if (end === "204") await cdp.send("Fetch.fulfillRequest", { requestId: h.id, responseCode: 204 }).catch((e) => console.log("204 err", String(e).slice(0, 80)));
  }
  await sleep(800);
  const after = await Promise.race([page.evaluate("document.getElementById('which')?.textContent + '|' + (document.querySelector('input')?.value ?? '') + '|' + location.href").catch((e) => "ERR " + String(e).slice(0, 60)), sleep(3000).then(() => "NO ANSWER")]);
  console.log(JSON.stringify({ path, end, held: held.map((h) => `${h.method} ${h.url} +${h.at - t0}ms`), typed, during, answeredIn, arrivedWhileHeld, navs, after: String(after).replace(app.origin, ""), taken: app.hits.slice(h0).filter((h) => h.url.includes("/taken")).map((h) => h.url) }));
  await context.close();
}
for (const path of ["/enter-replace", "/enter-form", "/enter-href-later", "/enter-meta", "/enter-reload", "/enter-back", "/enter-js", "/enter-open", "/enter-blob"]) {
  for (const end of (path.match(/replace|form/) ? ["fail", "204"] : ["204"]) as End[]) await run(path, end).catch((e) => console.log(path, end, "THREW", String(e).slice(0, 200)));
}
await browser.close(); await app.close();
