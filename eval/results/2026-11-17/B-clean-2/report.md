# SC-101 Approved leave is deducted from the balance; pending and rejected leave is not

**Verdict: PASSED** — All 3 assertions matched.

- Steps chosen by: Claude subagent (Opus) via HTTP bridge
- Environment: http://localhost:3100, commit clean
- Started 2026-11-17T23:51:13.850Z, took 67.0 s, 35 tool calls
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
| 1 | navigate | {"path":"/"} | URL: / | Discover the app entry page. |
| 2 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Enter employee username. |
| 3 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Enter employee password. |
| 4 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as employee. |
| 5 | observe | {"name":"startingDays","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+(?:\\.\\d+)?)"}} | Recorded startingDays = 20 | Record the starting balance before any requests. |
| 6 | fill | {"element":{"by":"role","role":"textbox","value":"First day"},"text":"2026-12-07"} | URL: / | First day of the three-day request. |
| 7 | fill | {"element":{"by":"role","role":"textbox","value":"Last day"},"text":"2026-12-09"} | URL: / | Last day of the three-day request. |
| 8 | fill | {"element":{"by":"role","role":"textbox","value":"Reason"},"text":"SC-101 three-day"} | URL: / | Reason for the three-day request. |
| 9 | click | {"element":{"by":"role","role":"button","value":"Submit request"}} | URL: / | Submit the three-day request. |
| 10 | fill | {"element":{"by":"role","role":"textbox","value":"First day"},"text":"2026-12-14"} | URL: / | First day of the two-day request. |
| 11 | fill | {"element":{"by":"role","role":"textbox","value":"Last day"},"text":"2026-12-15"} | URL: / | Last day of the two-day request. |
| 12 | fill | {"element":{"by":"role","role":"textbox","value":"Reason"},"text":"SC-101 two-day"} | URL: / | Reason for the two-day request. |
| 13 | click | {"element":{"by":"role","role":"button","value":"Submit request"}} | URL: / | Submit the two-day request. |
| 14 | check | {"assertionId":"A1","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+(?:\\.\\d+)?)"}} | Recorded A1: expected 20, actual 20 -> match. This result is final. | Both requests are pending; balance should be unchanged. |
| 15 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to the manager. |
| 16 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-manager"} | URL: / | Enter manager username. |
| 17 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-manager"} | URL: / | Enter manager password. |
| 18 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as manager. |
| 19 | click | {"element":{"by":"role","role":"button","value":"Approve request 3 from Employee sc-101-employee"}} | URL: / | Approve the three-day request. |
| 20 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to the employee to view balance. |
| 21 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Enter employee username. |
| 22 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Enter employee password. |
| 23 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as employee. |
| 24 | check | {"assertionId":"A2","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+(?:\\.\\d+)?)"}} | Recorded A2: expected 17, actual 17 -> match. This result is final. | Three-day request approved, two-day still pending. |
| 25 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to manager. |
| 26 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-manager"} | URL: / | Enter manager username. |
| 27 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-manager"} | URL: / | Enter manager password. |
| 28 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as manager. |
| 29 | click | {"element":{"by":"role","role":"button","value":"Reject request 4 from Employee sc-101-employee"}} | URL: / | Reject the two-day request. |
| 30 | click | {"element":{"by":"role","role":"button","value":"Sign out"}} | URL: / | Switch to employee. |
| 31 | fill | {"element":{"by":"role","role":"textbox","value":"Username"},"text":"sc-101-employee"} | URL: / | Enter employee username. |
| 32 | fill | {"element":{"by":"role","role":"textbox","value":"Password"},"text":"pw-sc-101-employee"} | URL: / | Enter employee password. |
| 33 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as employee. |
| 34 | check | {"assertionId":"A3","target":{"source":"page","by":"text","value":"Days remaining:","pattern":"Days remaining:\\s*(\\d+(?:\\.\\d+)?)"}} | Recorded A3: expected 17, actual 17 -> match. This result is final. | Two-day request rejected; balance should reflect only the approved request. |
| 35 | finish | {"outcome":"completed","reason":"All three assertions (A1, A2, A3) were checked at the required stages."} | Scenario ended. | Every planned assertion has been checked. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
- A1: ![A1](check-A1.png)
- A2: ![A2](check-A2.png)
- A3: ![A3](check-A3.png)
