# S8 Approved request starting today + 2 cannot be cancelled (boundary just inside window)

**Verdict: BLOCKED** — Not checked: A1, A2. The scenario requires today's date from the Date header of an application response, but api_request returns only status, body and responseId (no headers), and no page or API body seen (/, /api/me, /api/requests) shows the current date. D = today + 2 cannot be determined, so the request cannot be created and A1/A2 were not checked.

- Steps chosen by: external model via HTTP bridge
- Environment: http://localhost:3100, commit 08e7842a56d2988b058d3e07853d2da1601a42f0
- Started 2026-11-18T18:58:01.159Z, took 37.7 s, 7 tool calls
- Basis: risk; requirements R14, R16, R17

## Objective

Work out today's date (use the Date header of a response from the application) and let D be today + 2 calendar days in YYYY-MM-DD. Sign in as the employee, create a request with first and last day D, note its id. Sign out, sign in as the manager and approve it. Sign out, sign in as the employee and record balance from GET /api/me as balanceApproved. POST /api/requests/<id>/cancel via the API and keep the response. Then record balance from GET /api/me as balanceAfter and read the request's status from GET /api/requests.

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | After the cancel attempt on the request starting today + 2: status field of the request in GET /api/requests equals Approved. | `Approved` |  |  | not checked |  |
| A2 | After the cancel attempt: balanceAfter equals balanceApproved. | `balanceApproved` |  |  | not checked |  |

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | See the starting page to find sign-in. |
| 2 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"s8-emp"} | URL: / | Sign in as employee. |
| 3 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"{{secret:emp.password}}"} | URL: / | Employee password. |
| 4 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit sign-in. |
| 5 | api_request | {"method":"GET","path":"/api/me"} | {"responseId":"R1","status":200,"body":{"handle":"s8-emp","name":"Employee s8-emp","role":"employee","balance":20}} | Get a response with Date header to compute today. |
| 6 | api_request | {"method":"GET","path":"/api/requests"} | {"responseId":"R2","status":200,"body":[]} | Look for any date information exposed by the application. |
| 7 | finish | {"outcome":"blocked","reason":"The scenario requires today's date from the Date header of an application response, but api_request returns only status, body and responseId (no headers), and no page or API body seen (/, /api/me, /api/requests) shows the current date. D = today + 2 cannot be determined, so the request cannot be created and A1/A2 were not checked."} | Scenario ended. | Cannot reach the needed state without the date source the plan specifies. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
