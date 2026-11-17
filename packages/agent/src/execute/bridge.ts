import { createServer } from "node:http";
import type { ScenarioResult } from "../schema.ts";
import { briefing, SYSTEM } from "./briefing.ts";
import { closeSession, openSession, type SessionOptions } from "./run.ts";
import { runTool, toolDefinitions } from "./tools.ts";

/**
 * Runs one scenario with the model attached from outside the process.
 *
 * The built-in loop calls a model API directly. The bridge serves the same
 * system prompt, briefing and tool definitions over localhost and executes
 * tool calls it receives, so any model that can make HTTP requests can drive
 * the scenario. Everything that decides the verdict is unchanged.
 *
 *   GET  /briefing              instructions, scenario and tool definitions
 *   POST /tool {name, input}    runs one tool call -> {ok, output}
 *
 * The session ends when the finish tool is called or the budget runs out.
 */
export async function serveScenario(
  options: SessionOptions & { port: number; maxToolCalls: number; driver: string },
): Promise<ScenarioResult> {
  const open = await openSession(options);
  const { session } = open;
  if (session.outcome) return closeSession(open, { mode: "agent", driver: options.driver });

  const instructions = [
    SYSTEM,
    "",
    "---",
    briefing(session.scenario, open.manifest, open.fixtures),
    "",
    "---",
    "Tools:",
    JSON.stringify(toolDefinitions, null, 2),
    "",
    `To call a tool, POST JSON {"name": ..., "input": {...}} to http://127.0.0.1:${options.port}/tool.`,
    'The response is JSON {"ok": boolean, "output": string}. Call tools one at a time.',
  ].join("\n");

  let calls = 0;
  let busy = Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reply = (status: number, body: string, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };
      if (req.method === "GET" && req.url === "/briefing") return reply(200, instructions, "text/plain");
      if (req.method !== "POST" || req.url !== "/tool") return reply(404, '{"error":"not found"}');

      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        // Tool calls are serialised: browser state is shared.
        busy = busy.then(async () => {
          let call: { name?: unknown; input?: unknown };
          try {
            call = JSON.parse(raw);
          } catch {
            return reply(400, JSON.stringify({ ok: false, output: "Error: body is not valid JSON." }));
          }
          if (session.outcome) {
            return reply(200, JSON.stringify({ ok: false, output: "Error: the scenario has ended." }));
          }
          calls++;
          const result = await runTool(session, String(call.name), call.input);
          if (!session.outcome && calls >= options.maxToolCalls) {
            session.outcome = { kind: "stopped", reason: `Step budget of ${options.maxToolCalls} tool calls exhausted.` };
          }
          reply(200, JSON.stringify(result));
          if (session.outcome) {
            server.close();
            closeSession(open, { mode: "agent", driver: options.driver }).then(resolve, reject);
          }
        });
      });
    });
    server.on("error", reject);
    server.listen(options.port, "127.0.0.1");
  });
}
