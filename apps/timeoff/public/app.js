// Single-page client: every screen is built here from API responses.
const root = document.getElementById("app");
let me = null;

async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) node.append(child);
  return node;
}

function field(id, label, type = "text") {
  return [el("label", { htmlFor: id, textContent: label }), el("input", { id, type })];
}

function table(headings, rows) {
  return el(
    "table",
    {},
    el("thead", {}, el("tr", {}, headings.map((h) => el("th", { textContent: h })))),
    el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((c) => el("td", {}, c))))),
  );
}

function shell(...content) {
  const header = el("header", {}, el("strong", { textContent: "Dayoff" }));
  if (me) {
    header.append(
      el("span", { textContent: `${me.name} (${me.role})` }),
      el("button", {
        className: "secondary",
        textContent: "Sign out",
        onclick: async () => {
          await call("DELETE", "/api/session");
          me = null;
          render();
        },
      }),
    );
  }
  root.replaceChildren(header, el("main", {}, ...content));
}

function signInScreen(message) {
  const error = el("p", { className: "error", role: "alert", textContent: message ?? "" });
  const form = el("form", {}, field("handle", "Username"), field("password", "Password", "password"), el("p", {}, el("button", { textContent: "Sign in" })));
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      me = await call("POST", "/api/session", {
        handle: form.querySelector("#handle").value,
        password: form.querySelector("#password").value,
      });
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  };
  shell(el("section", {}, el("h1", { textContent: "Sign in" }), error, form));
}

async function employeeScreen() {
  me = await call("GET", "/api/me");
  const requests = await call("GET", "/api/requests");
  const error = el("p", { className: "error", role: "alert" });
  const form = el(
    "form",
    {},
    field("start", "First day", "date"),
    field("end", "Last day", "date"),
    field("reason", "Reason"),
    el("p", {}, el("button", { textContent: "Submit request" })),
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await call("POST", "/api/requests", {
        start: form.querySelector("#start").value,
        end: form.querySelector("#end").value,
        reason: form.querySelector("#reason").value,
      });
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  };
  shell(
    el("section", {}, el("h1", { textContent: "My time off" }), el("p", {}, "Days remaining: ", el("strong", { textContent: String(me.balance) }))),
    el("section", {}, el("h2", { textContent: "Request time off" }), error, form),
    el(
      "section",
      {},
      el("h2", { textContent: "My requests" }),
      requests.length === 0
        ? el("p", { textContent: "You have not requested any time off." })
        : table(["First day", "Last day", "Days", "Reason", "Status"], requests.map((r) => [r.start, r.end, String(r.days), r.reason, r.status])),
    ),
  );
}

async function managerScreen() {
  const requests = await call("GET", "/api/requests");
  const decide = (request, decision, label) =>
    el("button", {
      textContent: label,
      ariaLabel: `${label} request ${request.id} from ${request.employeeName}`,
      className: decision === "reject" ? "secondary" : "",
      onclick: async () => {
        await call("POST", `/api/requests/${request.id}/decision`, { decision });
        render();
      },
    });
  const pending = requests.filter((r) => r.status === "Pending");
  const decided = requests.filter((r) => r.status !== "Pending");
  shell(
    el(
      "section",
      {},
      el("h1", { textContent: "Requests awaiting a decision" }),
      pending.length === 0
        ? el("p", { textContent: "Nothing is waiting for you." })
        : table(
            ["Request", "Employee", "First day", "Last day", "Days", "Reason", "Decision"],
            pending.map((r) => [`#${r.id}`, r.employeeName, r.start, r.end, String(r.days), r.reason, el("span", {}, decide(r, "approve", "Approve"), " ", decide(r, "reject", "Reject"))]),
          ),
    ),
    el(
      "section",
      {},
      el("h2", { textContent: "Decided" }),
      decided.length === 0
        ? el("p", { textContent: "No decisions yet." })
        : table(["Request", "Employee", "Days", "Status"], decided.map((r) => [`#${r.id}`, r.employeeName, String(r.days), r.status])),
    ),
  );
}

async function render() {
  try {
    if (!me) me = await call("GET", "/api/me").catch(() => null);
    if (!me) return signInScreen();
    await (me.role === "manager" ? managerScreen() : employeeScreen());
  } catch (e) {
    me = null;
    signInScreen(e.message);
  }
}

render();
