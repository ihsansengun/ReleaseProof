import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { SessionJob } from "../execute/loop.ts";
import { runTool, toolDefinitions, type Session } from "../execute/tools.ts";
import type { Usage } from "../schema.ts";
import type { Driver, TaskJob } from "./driver.ts";

type Job = { id: string; name: string; claimed: boolean; done: boolean; briefing: string } & (
  | {
      kind: "task";
      schema: z.ZodType<unknown>;
      attempts: number;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  | { kind: "session"; session: Session; job: SessionJob; calls: number; chain: Promise<unknown>; resolve: () => void }
);

const MAX_TASK_ATTEMPTS = 3;

/**
 * Lets a model outside this process do the work. Each task or session becomes
 * a job; an external driver claims one, reads its briefing and answers over
 * HTTP. Validation, tool execution and everything that decides a verdict stay
 * here, exactly as with the API driver.
 *
 *   POST /claim                -> {id, briefing: url} | {none: true}
 *   GET  /status               -> {unclaimed, active, done}
 *   GET  /jobs/:id             -> the job's instructions as text
 *   POST /jobs/:id/result      -> for tasks: {ok} or {ok: false, errors}
 *   POST /jobs/:id/tool        -> for sessions: {ok, output}
 */
export class BridgeDriver implements Driver {
  private jobs: Job[] = [];
  private server: Server;
  private base: string;

  constructor(
    port: number,
    readonly label: string,
  ) {
    this.base = `http://127.0.0.1:${port}`;
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.listen(port, "127.0.0.1");
  }

  task<T>(job: TaskJob<T>): Promise<T> {
    const id = `${this.jobs.length + 1}-${job.name}`;
    const url = `${this.base}/jobs/${id}`;
    const briefing = [
      job.instructions,
      "",
      "=== INPUT ===",
      job.input,
      "",
      "=== HOW TO ANSWER ===",
      `POST one JSON object to ${url}/result (content-type application/json).`,
      'The reply is {"ok": true} if it was accepted, or {"ok": false, "errors": ...} if it does not fit the schema; correct it and POST again.',
      "It must match this JSON Schema:",
      JSON.stringify(z.toJSONSchema(job.schema), null, 2),
    ].join("\n");
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        id,
        name: job.name,
        kind: "task",
        claimed: false,
        done: false,
        briefing,
        schema: job.schema,
        attempts: 0,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  session(session: Session, job: SessionJob & { name: string }): Promise<Usage | undefined> {
    const id = `${this.jobs.length + 1}-${job.name}`;
    const url = `${this.base}/jobs/${id}`;
    const briefing = [
      job.system,
      "",
      "---",
      job.briefing,
      "",
      "---",
      "Tools:",
      JSON.stringify(
        toolDefinitions.filter((t) => job.tools.includes(t.name)),
        null,
        2,
      ),
      "",
      `To call a tool, POST JSON {"name": ..., "input": {...}} to ${url}/tool.`,
      'The response is JSON {"ok": boolean, "output": string}. Call tools one at a time.',
    ].join("\n");
    return new Promise((resolve) => {
      this.jobs.push({
        id,
        name: job.name,
        kind: "session",
        claimed: false,
        done: false,
        briefing,
        session,
        job,
        calls: 0,
        chain: Promise.resolve(),
        resolve: () => resolve(undefined),
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = req.url ?? "";

    if (req.method === "GET" && url === "/status") {
      return reply(200, {
        unclaimed: this.jobs.filter((j) => !j.claimed && !j.done).map((j) => j.id),
        active: this.jobs.filter((j) => j.claimed && !j.done).map((j) => j.id),
        done: this.jobs.filter((j) => j.done).length,
      });
    }
    if (req.method === "POST" && url === "/claim") {
      const job = this.jobs.find((j) => !j.claimed && !j.done);
      if (!job) return reply(200, { none: true });
      job.claimed = true;
      return reply(200, { id: job.id, briefing: `${this.base}/jobs/${job.id}` });
    }

    const match = /^\/jobs\/([^/]+)(\/result|\/tool)?$/.exec(url);
    const job = match && this.jobs.find((j) => j.id === match[1]);
    if (!match || !job) return reply(404, { error: "not found" });
    if (req.method === "GET" && !match[2]) return reply(200, job.briefing, "text/plain");
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { ok: false, errors: "The body is not valid JSON." });
      }
      if (job.done) return reply(200, { ok: false, output: "Error: this job has ended.", errors: "This job has ended." });

      if (job.kind === "task" && match[2] === "/result") {
        const parsed = job.schema.safeParse(body);
        if (parsed.success) {
          job.done = true;
          job.resolve(parsed.data);
          return reply(200, { ok: true });
        }
        job.attempts++;
        if (job.attempts >= MAX_TASK_ATTEMPTS) {
          job.done = true;
          job.reject(new Error(`The ${job.name} task did not produce valid output in ${MAX_TASK_ATTEMPTS} attempts.`));
        }
        return reply(200, { ok: false, errors: z.prettifyError(parsed.error) });
      }

      if (job.kind === "session" && match[2] === "/tool") {
        // One browser per session, so its calls run strictly one at a time.
        const call = body as { name?: unknown; input?: unknown };
        const run = async () => {
          if (job.session.outcome) return reply(200, { ok: false, output: "Error: this session has ended." });
          job.calls++;
          const result = await runTool(job.session, String(call.name), call.input, job.job.tools);
          if (!job.session.outcome && job.calls >= job.job.maxToolCalls) {
            job.session.outcome = {
              kind: "stopped",
              reason: `Step budget of ${job.job.maxToolCalls} tool calls exhausted.`,
            };
          }
          reply(200, result);
          if (job.session.outcome) {
            job.done = true;
            job.resolve();
          }
        };
        job.chain = job.chain.then(run, run);
        return;
      }
      reply(404, { error: "not found" });
    });
  }
}
