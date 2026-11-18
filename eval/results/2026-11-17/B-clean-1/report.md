# SC-101 Approved leave is deducted from the balance; pending and rejected leave is not

**Verdict: PASSED** — All 3 assertions matched.

- Steps chosen by: Claude subagent (Opus) via HTTP bridge
- Environment: http://localhost:3100, commit clean
- Started 2026-11-17T23:49:24.102Z, took 74.6 s, 37 tool calls
- Basis: requirement; requirements REQ-2, REQ-3, REQ-4

## Objective

As the employee, note the remaining leave days, then submit one request covering three consecutive days and a second request covering two consecutive days in a different week. As the manager, approve the three-day request and reject the two-day request. Check the employee's remaining days at each stage the assertions describe.

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | Employee's remaining days while both requests are still pending | `startingDays` | 20 | 20 | match | [check-A1.png](check-A1.png) |
| A2 | Employee's remaining days after the three-day request is approved and before the other request is decided | `startingDays - 3` | 17 | 17 | match | [check-A2.png](check-A2.png) |
| A3 | Employee's remaining days after the two-day request is rejected | `startingDays - 3` | 17 | 17 | match | [check-A3.png](check-A3.png) |

## Observations

- `startingDays` = 20

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | Discover the application landing page. |
| 2 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Log in as employee. |
| 3 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Log in as employee. |
| 4 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit login. |
| 5 | observe | {"name":"startingDays","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+)"}} | Recorded startingDays = 20 | Record the starting balance before any requests. |
| 6 | fill | {"element":{"by":"role","role":"textbox","value":"First day"},"text":"2026-12-07"} | URL: / | First request start. |
| 7 | fill | {"element":{"by":"role","role":"textbox","value":"Last day"},"text":"2026-12-09"} | URL: / | First request end (3 days). |
| 8 | fill | {"element":{"by":"role","role":"textbox","value":"Reason"},"text":"Three-day trip"} | URL: / | Reason. |
| 9 | click | {"element":{"by":"role","role":"button","value":"Submit request"}} | URL: / | Submit the three-day request. |
| 10 | fill | {"element":{"by":"role","role":"textbox","value":"First day"},"text":"2026-12-14"} | URL: / | Second request start, different week. |
| 11 | fill | {"element":{"by":"role","role":"textbox","value":"Last day"},"text":"2026-12-15"} | URL: / | Second request end (2 days). |
| 12 | fill | {"element":{"by":"role","role":"textbox","value":"Reason"},"text":"Two-day break"} | URL: / | Reason. |
| 13 | click | {"element":{"by":"role","role":"button","value":"Submit request"}} | URL: / | Submit the two-day request. |
| 14 | navigate | {"path":"/"} | URL: / | Reload to get a fresh balance with both requests pending. |
| 15 | check | {"assertionId":"A1","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+)"}} | Recorded A1: expected 20, actual 20 -> match. This result is final. | Both requests are pending. |
| 16 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to manager. |
| 17 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-manager"} | URL: / | Log in as manager. |
| 18 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-manager"} | URL: / | Log in as manager. |
| 19 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit manager login. |
| 20 | click | {"element":{"by":"role","role":"button","value":"Approve request 1 from Employee sc-101-employee"}} | URL: / | Approve the three-day request. |
| 21 | navigate | {"path":"/"} | URL: / | Reload manager page to confirm the approval persisted. |
| 22 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to employee. |
| 23 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Log in as employee. |
| 24 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Log in as employee. |
| 25 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit employee login. |
| 26 | check | {"assertionId":"A2","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+)"}} | Recorded A2: expected 17, actual 17 -> match. This result is final. | Three-day request approved, two-day still pending. |
| 27 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to manager. |
| 28 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-manager"} | URL: / | Log in as manager. |
| 29 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-manager"} | URL: / | Log in as manager. |
| 30 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit manager login. |
| 31 | click | {"element":{"by":"role","role":"button","value":"Reject request 2 from Employee sc-101-employee"}} | URL: / | Reject the two-day request. |
| 32 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to employee. |
| 33 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Log in as employee. |
| 34 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Log in as employee. |
| 35 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Submit employee login. |
| 36 | check | {"assertionId":"A3","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+)"}} | Recorded A3: expected 17, actual 17 -> match. This result is final. | Two-day request now rejected. |
| 37 | finish | {"outcome":"completed","reason":"All three assertions checked at the scenario-described states."} | Scenario ended. | Every assertion has been checked. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
- A1: ![A1](check-A1.png)
- A2: ![A2](check-A2.png)
- A3: ![A3](check-A3.png)
