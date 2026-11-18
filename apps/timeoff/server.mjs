// Demonstration app B: a time-off request tool. Deliberately unlike app A:
// no framework, a JSON API, and a page rendered entirely in the browser.
// State lives in memory, so every start is a clean slate.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const users = new Map(); // handle -> { handle, name, role, password, balance }
const sessions = new Map(); // token -> handle
let requests = []; // { id, employee, employeeName, start, end, days, reason, status }
let nextId = 1;

const DAY = 24 * 60 * 60 * 1000;
// Approved leave is already with payroll, so it needs this much notice to cancel.
const CANCEL_NOTICE_DAYS = 3;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function currentUser(req) {
  const token = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  return users.get(sessions.get(token)) ?? null;
}

const publicUser = (u) => ({ handle: u.handle, name: u.name, role: u.role, balance: u.balance });

/** Applies a manager's decision. Only an approval uses up leave. */
function decide(request, decision) {
  request.status = decision === "approve" ? "Approved" : "Rejected";
  if (decision === "approve") {
    users.get(request.employee).balance -= request.days;
  }
}

/** Days of notice between today (server date) and the given YYYY-MM-DD date. */
function noticeDays(date) {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(date) - Date.parse(today)) / DAY);
}

/**
 * Cancels a request on behalf of its employee. Returns an error message when
 * the request cannot be cancelled. Cancelling approved leave gives the days back.
 */
function cancel(request) {
  if (request.status === "Cancelled") return "This request was already cancelled.";
  if (request.status === "Rejected") return "Only pending or approved requests can be cancelled.";
  if (request.status === "Approved") {
    if (noticeDays(request.start) < CANCEL_NOTICE_DAYS) {
      return `Approved leave can only be cancelled at least ${CANCEL_NOTICE_DAYS} days before its first day.`;
    }
    users.get(request.employee).balance += request.days;
  }
  request.status = "Cancelled";
  return null;
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/version") {
    return send(res, 200, { sha: process.env.GIT_SHA ?? "unknown", testMode: process.env.TEST_MODE === "1" });
  }

  if (route === "POST /api/test/users") {
    if (process.env.TEST_MODE !== "1") return send(res, 404, { error: "not found" });
    const body = await readJson(req);
    if (!body?.handle || !["employee", "manager"].includes(body.role)) {
      return send(res, 400, { error: "handle and role (employee | manager) are required" });
    }
    // Same handle again resets that user and their requests.
    requests = requests.filter((r) => r.employee !== body.handle);
    const user = {
      handle: body.handle,
      name: body.role === "manager" ? `Manager ${body.handle}` : `Employee ${body.handle}`,
      role: body.role,
      password: `pw-${body.handle}`,
      balance: body.role === "employee" ? Number(body.balance ?? 20) : 0,
    };
    users.set(user.handle, user);
    return send(res, 200, { ...publicUser(user), password: user.password });
  }

  if (route === "POST /api/session") {
    const body = await readJson(req);
    const user = users.get(body?.handle);
    if (!user || user.password !== body?.password) return send(res, 401, { error: "Unknown user or wrong password." });
    const token = randomUUID();
    sessions.set(token, user.handle);
    return send(res, 200, publicUser(user), { "set-cookie": `sid=${token}; HttpOnly; SameSite=Lax; Path=/` });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: "Not signed in." });

  if (route === "DELETE /api/session") {
    return send(res, 200, {}, { "set-cookie": "sid=; Max-Age=0; Path=/" });
  }
  if (route === "GET /api/me") return send(res, 200, publicUser(user));

  if (route === "GET /api/requests") {
    const visible = user.role === "manager" ? requests : requests.filter((r) => r.employee === user.handle);
    return send(res, 200, visible);
  }

  if (route === "POST /api/requests") {
    if (user.role !== "employee") return send(res, 403, { error: "Only employees can request time off." });
    const body = await readJson(req);
    if (!isDate(body?.start) || !isDate(body?.end)) return send(res, 400, { error: "Enter a first and a last day." });
    const days = Math.round((Date.parse(body.end) - Date.parse(body.start)) / DAY) + 1;
    if (days < 1) return send(res, 400, { error: "The last day cannot be before the first day." });
    const request = {
      id: nextId++,
      employee: user.handle,
      employeeName: user.name,
      start: body.start,
      end: body.end,
      days,
      reason: String(body.reason ?? ""),
      status: "Pending",
    };
    requests.push(request);
    return send(res, 201, request);
  }

  const decision = /^\/api\/requests\/(\d+)\/decision$/.exec(url.pathname);
  if (req.method === "POST" && decision) {
    if (user.role !== "manager") return send(res, 403, { error: "Only managers can decide requests." });
    const request = requests.find((r) => r.id === Number(decision[1]));
    const body = await readJson(req);
    if (!request) return send(res, 404, { error: "No such request." });
    if (request.status !== "Pending") return send(res, 409, { error: "This request was already decided." });
    if (!["approve", "reject"].includes(body?.decision)) return send(res, 400, { error: "decision must be approve or reject" });
    decide(request, body.decision);
    return send(res, 200, request);
  }

  const cancellation = /^\/api\/requests\/(\d+)\/cancel$/.exec(url.pathname);
  if (req.method === "POST" && cancellation) {
    if (user.role !== "employee") return send(res, 403, { error: "Only the employee who made a request can cancel it." });
    const request = requests.find((r) => r.id === Number(cancellation[1]));
    if (!request) return send(res, 404, { error: "No such request." });
    if (request.employee !== user.handle) return send(res, 403, { error: "Only the employee who made a request can cancel it." });
    const problem = cancel(request);
    if (problem) return send(res, 409, { error: problem });
    return send(res, 200, request);
  }

  return send(res, 404, { error: "not found" });
}

const STATIC = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": file[1] });
    res.end(await readFile(path.join(PUBLIC, file[0])));
  } catch (error) {
    send(res, 500, { error: String(error) });
  }
}).listen(Number(process.env.PORT ?? 3100), () => console.log(`timeoff listening on ${process.env.PORT ?? 3100}`));
