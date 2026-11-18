# S10 Pending request starting tomorrow can still be cancelled (notice rule only for Approved)

**Verdict: BLOCKED** — Not checked: A1, A2. The scenario requires today's date from the Date header of an application response, but the api_request tool returns only responseId, status and body (checked GET /api/requests -> R1 and GET / -> R2); no response headers are exposed and no page shows today's date, so D (today+1) could not be determined. balanceBefore = 20 was recorded; no request was created and A1/A2 were not checked.

- Steps chosen by: external model via HTTP bridge
- Environment: http://localhost:3100, commit 08e7842a56d2988b058d3e07853d2da1601a42f0
- Started 2026-11-18T18:58:04.287Z, took 36.7 s, 8 tool calls
- Basis: risk; requirements R8, R6, R7

## Objective

Work out today's date (use the Date header of a response from the application) and let D be today + 1 day in YYYY-MM-DD. Sign in as the employee, record Days remaining as balanceBefore, create a request with first and last day D and leave it Pending. In My requests click the Cancel button of that row. Read the row's status and record Days remaining as balanceAfter.

## Assertions

Expected values were fixed in the plan; actual values were read and compared in code.

| Id | What | Expected (plan) | Expected (evaluated) | Actual | Result | Evidence |
|---|---|---|---|---|---|---|
| A1 | After clicking Cancel on the Pending request starting tomorrow: status field of that request in GET /api/requests equals Cancelled. | `Cancelled` |  |  | not checked |  |
| A2 | After the cancel: Days remaining (balanceAfter) equals balanceBefore. | `balanceBefore` |  |  | not checked |  |

## Observations

- `balanceBefore` = 20

## Steps

| # | Tool | Input | Outcome | Stated reason |
|---|---|---|---|---|
| 1 | navigate | {"path":"/"} | URL: / | Open the application to find the sign-in page. |
| 2 | fill | {"element":{"by":"label","value":"Username"},"text":"s10-emp"} | URL: / | Enter the employee username. |
| 3 | fill | {"element":{"by":"label","value":"Password"},"text":"{{secret:emp.password}}"} | URL: / | Enter the employee password. |
| 4 | click | {"element":{"by":"role","role":"button","value":"Sign in"}} | URL: / | Sign in as the employee. |
| 5 | api_request | {"method":"GET","path":"/api/requests"} | {"responseId":"R1","status":200,"body":[]} | Read the Date header to determine today. |
| 6 | observe | {"name":"balanceBefore","target":{"source":"page","by":"text","value":"Days remaining:","count":false,"pattern":"Days remaining:\\s*(\\d+)"}} | Recorded balanceBefore = 20 | Record the balance before creating the request. |
| 7 | api_request | {"method":"GET","path":"/"} | {"responseId":"R2","status":200,"body":"<!doctype html>\n<html lang=\"en\">\n <head>\n <meta charset=\"utf-8\" />\n <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n <title>Dayoff</title>\n <link rel=\"stylesheet\" href=\"/style.css\" />\n </head>\n <body>\n | Check whether this response exposes the Date header. |
| 8 | finish | {"outcome":"blocked","reason":"The scenario requires today's date from the Date header of an application response, but the api_request tool returns only responseId, status and body (checked GET /api/requests -> R1 and GET / -> R2); no response headers are exposed and no page shows today's date, so D (today+1) could not be determined. balanceBefore = 20 was recorded; no request was created and A1/A2 were not checked."} | Scenario ended. | The required date source is not reachable with the provided tools, and the briefing forbids substituting another source. |

## Evidence

- Playwright trace: `trace.zip` (open with `npx playwright show-trace`)
