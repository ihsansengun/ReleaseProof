import { DEFAULT_ROUTING } from "../src/routing.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Budget, BudgetExceeded, DEFAULT_PRICES } from "../src/budget.ts";
import { ApiDriver } from "../src/drivers/driver.ts";
import type { Session } from "../src/execute/tools.ts";
import { SecretVault } from "../src/secrets.ts";

// These tests run the real SDK against a local stand-in for the model API.
// They check our request shape, retry behaviour, usage accounting and error
// handling. They cannot show that the real API accepts every parameter.

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };
type Seen = { path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };

function message(content: unknown[], stop_reason: string, usage = { input_tokens: 100, output_tokens: 20 }) {
  return { id: "msg_1", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage };
}

function sse(msg: ReturnType<typeof message>): string {
  const text = (msg.content[0] as { text: string }).text;
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

async function fakeApi(script: Scripted[]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ path: req.url ?? "", body, headers: req.headers });
      const next = script.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "script exhausted" } } };
      if (next.status !== 200) {
        res.writeHead(next.status, { "content-type": "application/json", "retry-after-ms": "5", ...next.headers });
        return res.end(JSON.stringify(next.body ?? { type: "error", error: { type: "overloaded_error", message: "busy" } }));
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(sse(next.body as ReturnType<typeof message>));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

const fakeSession = () =>
  ({ steps: [], assertionResults: [], observations: {}, vault: new SecretVault(), scenario: { assertions: [] } }) as unknown as Session;
const job = { name: "S1", system: "sys", briefing: "do it", tools: ["navigate", "finish"] as const, maxToolCalls: 5 };
const finishCall = { type: "tool_use", id: "tu_1", name: "finish", input: { outcome: "completed", reason: "done", rationale: "r" } };
const driverFor = (url: string, budget: Budget) =>
  new ApiDriver({
    routing: { models: { analyse: "claude-sonnet-5-5", plan: "claude-sonnet-5-5", discover: "claude-sonnet-5-5", execute: "claude-sonnet-5-5", escalate: "claude-sonnet-5-5" }, efforts: DEFAULT_ROUTING.efforts, escalation: false },
    budget,
    client: { baseURL: url, apiKey: "test-key" },
  });

test("a session retries an overloaded API, runs the tool call and accounts for usage", async () => {
  const api = await fakeApi([
    { status: 529 },
    { status: 200, body: message([finishCall], "tool_use", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } as never) },
  ]);
  const budget = new Budget({ maxTokens: 1e6, maxUsd: 10, maxMinutes: 10 }, DEFAULT_PRICES);
  budget.enter("execute");
  const session = fakeSession();
  const usage = await driverFor(api.url, budget).session(session, job);
  api.server.close();

  assert.deepEqual(session.outcome, { kind: "completed", reason: "done" });
  assert.equal(api.seen.length, 2, "one failed attempt, one retry");
  const request = api.seen[1]!;
  assert.equal(request.body.model, "claude-sonnet-5-5");
  assert.equal(request.body.system, "sys");
  assert.deepEqual((request.body.tools as { name: string }[]).map((t) => t.name), ["navigate", "finish"]);
  // The credential travels in whichever header this SDK version uses.
  assert.match(`${request.headers["x-api-key"] ?? ""} ${request.headers.authorization ?? ""}`, /test-key/);
  assert.match(String(request.headers["anthropic-beta"]), /server-side-fallback/);
  assert.equal(usage?.turns, 1);
  const total = budget.summary();
  assert.deepEqual(
    [total.total.calls, total.total.inputTokens, total.total.outputTokens, total.total.cacheReadTokens, total.total.toolCalls],
    [1, 100, 20, 40, 1],
  );
  assert.equal(total.estimatedUsd, Math.round(((100 * 4 + 20 * 20 + 40 * 0.2) / 1e6) * 10_000) / 10_000);
  assert.ok(total.byStage.execute);
});

test("a session stops, without another call, once the run budget is spent", async () => {
  const unknownTool = { type: "tool_use", id: "tu_1", name: "navigate", input: {} };
  const api = await fakeApi([
    { status: 200, body: message([unknownTool], "tool_use", { input_tokens: 900, output_tokens: 200 }) },
    { status: 200, body: message([finishCall], "tool_use") },
  ]);
  const budget = new Budget({ maxTokens: 1000, maxUsd: 10, maxMinutes: 10 }, DEFAULT_PRICES);
  const session = fakeSession();
  await driverFor(api.url, budget).session(session, job);
  api.server.close();
  assert.equal(api.seen.length, 1);
  assert.equal(session.outcome?.kind, "stopped");
  assert.match(session.outcome!.reason, /Run budget exhausted: token limit of 1000 reached/);
});

test("a refusal and a persistent server error end the session with a stated reason", async () => {
  const refused = await fakeApi([{ status: 200, body: message([], "refusal") }]);
  const s1 = fakeSession();
  await driverFor(refused.url, new Budget()).session(s1, job);
  refused.server.close();
  assert.deepEqual(s1.outcome, { kind: "stopped", reason: "The model declined to continue." });

  const down = await fakeApi(Array.from({ length: 6 }, () => ({ status: 500 })));
  const s2 = fakeSession();
  await driverFor(down.url, new Budget()).session(s2, job);
  down.server.close();
  assert.equal(down.seen.length, 5, "first attempt plus four retries");
  assert.deepEqual(s2.outcome, { kind: "stopped", reason: "The model API returned HTTP 500 after retries." });
});

test("bad credentials fail the run instead of being recorded as a test outcome", async () => {
  const api = await fakeApi([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
  await assert.rejects(driverFor(api.url, new Budget()).session(fakeSession(), job), Anthropic.AuthenticationError);
  api.server.close();
});

test("a structured task is parsed against its schema, charged to the budget and refused when the budget is spent", async () => {
  const schema = z.object({ answer: z.number() });
  const api = await fakeApi([
    { status: 200, body: message([{ type: "text", text: '{"answer": 42}' }], "end_turn", { input_tokens: 500, output_tokens: 600 }) },
  ]);
  const budget = new Budget({ maxTokens: 1000, maxUsd: 10, maxMinutes: 10 }, DEFAULT_PRICES);
  const driver = driverFor(api.url, budget);
  const result = await driver.task({ name: "analyse", instructions: "i", input: "x", schema });
  assert.deepEqual(result, { answer: 42 });
  assert.equal(api.seen[0]!.body.stream, true);
  assert.ok((api.seen[0]!.body.output_config as { format?: unknown }).format, "a JSON schema is sent");
  assert.equal(budget.summary().total.outputTokens, 600);
  await assert.rejects(driver.task({ name: "plan", instructions: "i", input: "x", schema }), BudgetExceeded);
  assert.equal(api.seen.length, 1, "no request is made once the budget is spent");
  api.server.close();
});
