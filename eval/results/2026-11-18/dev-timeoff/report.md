# QA report: HR-201 — pull request #0

**HR-201 Manager decisions update the leave balance** · ihsansengun/ReleaseProof @ `dev-timeof`

## Summary

- Scenarios executed: 3 — 3 passed, 0 failed, 0 blocked during execution, 0 unverified
- Scenarios planned but not run: 3 (waiting on a decision or a missing capability)
- Documented requirements compared against the application: 7 of 10
- Clarification requests: 5
- Environment: http://localhost:3100, commit `dev-timeoff`
- Model work done by: external model via HTTP bridge

## Failures

None.

## Requirement coverage

| Id | Requirement | Source quote | Compared by |
|---|---|---|---|
| R1 | An employee sees their remaining leave days on the "My time off" screen. | "An employee sees their remaining leave days on the "My time off" screen." | S1/A1 match |
| R2 | Submitting a time-off request does not change the employee's remaining days while the request is pending. | "Submitting a request does not change the remaining days while the request is pending." | S1/A2 match |
| R3 | When a manager approves a request, the request's number of days is deducted from that employee's remaining days. | "When a manager approves a request, the requested number of days is deducted from the employee's remaining days." | S1/A4 match |
| R4 | When a manager rejects a request, the employee's remaining days do not change. | "When a manager rejects a request, the employee's remaining days do not change." | S2/A1 match |
| R5 | A request's number of days is the count of calendar days from the first day to the last day, inclusive (e.g. a single-day request is 1 day; weekends are counted). | "The number of days in a request is the count of calendar days from the first day to the last day, inclusive." | **not compared** |
| R6 | A newly submitted request starts with status Pending. | "A request has a first day, a last day and a reason, and starts as Pending." | S1/A3 match |
| R7 | A manager can approve or reject each pending request. | "A manager approves or rejects each pending request." | **not compared** |
| R8 | A request that has already been decided cannot be decided again (and so cannot change the balance a second time). | "A decided request cannot be decided again." | S2/A2 match<br>S3/A3 match |
| R9 | GET /api/me returns the current user, including the balance for employees. | "The current user, including `balance` for employees" | **not compared** |
| R10 | Only employees can create requests and only managers can decide them. | "Employees request leave; managers decide requests." | S3/A1 match<br>S3/A2 match |

Inferred, not stated in any source (never used as an expected value):

- R11: After an approval, the employee's "My time off" screen shows the reduced remaining days the next time it is loaded.
- R12: A decision on one employee's request does not change any other employee's remaining days.
- R13: A request whose last day is before its first day is rejected and does not affect the balance.
- R14: The Days value shown in the employee's and the manager's request lists equals the inclusive calendar-day count and is the amount deducted on approval.

## Clarification requests

- **Q1** Can a manager approve a request for more days than the employee has remaining, and if so may the balance go negative?
  - Neither the ticket nor the README sets a limit, so a test that approves more days than the balance has no expected outcome (block, cap, or negative balance).
- **Q2** Should an employee be able to submit a request for more days than they have remaining, or more than the remaining days minus their other pending requests?
  - No source covers validation against the balance at submission time, so over-balance submissions cannot be judged pass or fail.
- **Q3** Should the "My time off" screen show pending days in any way (e.g. a 'pending' or 'reserved' figure), or only the remaining days?
  - R2 says pending requests do not change the remaining days, but it does not say whether pending totals must be displayed. Expected screen content for an employee with pending requests is undefined.
- **Q4** Are requests with dates in the past, or requests that overlap an existing pending or approved request, allowed, and are their days deducted again on approval?
  - Overlapping approvals could deduct the same calendar day twice. Without a rule, the expected balance after approving overlapping requests cannot be stated.
- **Q5** What should happen to a request with an impossible calendar date (e.g. 2026-02-30) or a very long range spanning months or years?
  - R5 defines the count only for valid dates. The expected response for invalid dates, and any maximum length, cannot be tested until this is decided.

## Scenarios

| Id | Basis | Title | Result | Detail |
|---|---|---|---|---|
| [S1](scenarios/S1/report.md) | requirement | Submitting leaves the balance unchanged; approving a 3-day range that includes a weekend deducts 3 days | passed | All 4 assertions matched. |
| [S2](scenarios/S2/report.md) | risk | Rejecting leaves the balance unchanged, and a rejected request cannot later be approved | passed | All 2 assertions matched. |
| [S3](scenarios/S3/report.md) | risk | Employee cannot decide own request; approval deducts once even if approved twice | passed | All 3 assertions matched. |
| S4 | risk | Approving a request for more days than the employee has remaining | not run | It is not decided whether submitting or approving a request larger than the remaining balance is allowed, and whether the balance may go negative, be capped, or the action be refused. |
| S5 | risk | Overlapping or past-dated requests both approved | not run | It is not decided whether overlapping or past-dated requests are allowed, or whether shared days are deducted twice on approval. |
| S6 | risk | Invalid calendar dates, very long ranges, and end-before-start ranges | not run | The expected handling of invalid dates and very long ranges is undecided (Q5), and refusing end-before-start ranges (R13) is only an inferred requirement, not documented. |

## Risks identified

- **K1** Approval can drive the balance negative because there is no balance check at submission or decision time. — probed by S4
- **K2** The day count may be wrong around month ends, leap years (29 Feb), year boundaries or invalid dates, since it is computed from Date.parse differences and rounded. — probed by S1, S5, S6
- **K3** A request could be double-decided (e.g. approve then approve or reject, or two concurrent clicks), deducting twice or deducting then marking Rejected. — probed by S2, S3
- **K4** Rejection, or an invalid decision value, might still change the balance or status. — probed by S2
- **K5** The balance shown to the employee can be stale. It is fetched only when the page renders, so a decision made in another session does not appear until reload. — not probed
- **K6** Decision failures in the manager UI are not shown to the user. — not probed
- **K7** Deduction applies to the wrong employee, or affects other employees, if the request-to-user mapping is wrong. — not probed
- **K8** Authorization boundaries: an employee might decide requests, or a manager might create them. — probed by S3
- **K9** Submission itself might alter the balance, or end-before-start ranges might be accepted. — probed by S1, S6

## Notes from automatic checks

- First draft: Scenario S7 was dropped: the plan is limited to 3 blocked scenarios.

## Inputs and timing

- Documentation read: README.md
- Changed files: apps/timeoff/server.mjs, apps/timeoff/public/app.js
- Stages: ingest 0s, discover 54.6s, analyse 53.8s, plan 137.1s, execute 93s, confirm 0s
- Tool calls in execution: 97
