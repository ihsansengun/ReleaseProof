import { chromium } from "playwright";
const base = process.argv[2]!;
const paths = process.argv.slice(3);
const browser = await chromium.launch();
for (const path of paths) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const scripts = new Map<string, string>();
  cdp.on("Debugger.scriptParsed", (e) => scripts.set(e.scriptId, e.url));
  await cdp.send("Debugger.enable");
  await cdp.send("Runtime.enable");
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  for (const target of ["window", "document"]) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: target });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
    for (const l of listeners.filter((l) => ["pagehide", "unload", "beforeunload", "visibilitychange", "freeze", "pageshow"].includes(l.type))) {
      const src = await cdp.send("Debugger.getScriptSource", { scriptId: l.scriptId }).catch(() => ({ scriptSource: "" }));
      const lines = src.scriptSource.split("\n");
      const line = lines[l.lineNumber] ?? "";
      console.log(JSON.stringify({ path, target, type: l.type, url: scripts.get(l.scriptId), line: l.lineNumber, col: l.columnNumber, around: line.slice(Math.max(0, l.columnNumber - 300), l.columnNumber + 500) }));
    }
  }
  await context.close();
}
await browser.close();
