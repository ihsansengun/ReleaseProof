# QA report: LEAVE-58 — pull request #2

**LEAVE-58 Let employees cancel their own time-off requests** · ihsansengun/ReleaseProof @ `08e7842a56`

## Summary

- Scenarios executed: 10 — 5 passed, 3 failed, 2 blocked during execution, 0 unverified
- Scenarios planned but not run: 6 (waiting on a decision or a missing capability)
- Documented requirements compared against the application: 25 of 29
- Clarification requests: 7
- Environment: http://localhost:3100, commit `08e7842a56d2988b058d3e07853d2da1601a42f0`
- Model work done by: external model via HTTP bridge

## Failures

### S1 Employee cancels a Pending request from My requests; balance unchanged

- **Before cancelling: the accessible name of that row's Cancel button contains the first day 2027-03-08.**: expected 2027-03-08, actual Cancel
  - Requirement R3: "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day."
  - Evidence: [screenshot](scenarios/S1/check-A2.png), [steps](scenarios/S1/report.md)
- **Before cancelling: the accessible name of that row's Cancel button contains the last day 2027-03-10.**: expected 2027-03-10, actual Cancel
  - Requirement R3: "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day."
  - Evidence: [screenshot](scenarios/S1/check-A3.png), [steps](scenarios/S1/report.md)
- Replayed without a model: reproduced

### S2 Employee cancels an Approved far-future request in the UI; days returned immediately and after reload

- **After approval: the accessible name of that Approved row's Cancel button contains the last day 2027-03-10.**: expected 2027-03-10, actual Cancel
  - Requirement R3: "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day."
  - Evidence: [screenshot](scenarios/S2/check-A2.png), [steps](scenarios/S2/report.md)
- Replayed without a model: replay diverged

### S3 Non-owner employee cannot cancel someone else's Approved request

- **HTTP status code of other's POST /api/requests/<owner request id>/cancel (otherCancelStatus) equals 403.**: expected 403, actual 200
  - Requirement R18: "Only the employee who made a request can cancel it. Another employee or a manager who tries gets 403 from the API and nothing changes."
  - Evidence: [screenshot](scenarios/S3/check-A1.png), [steps](scenarios/S3/report.md)
- **After other's attempt, signed in as owner: status field of the request in GET /api/requests equals Approved.**: expected Approved, actual Cancelled
  - Requirement R20: "Another employee or a manager who tries gets 403 from the API and nothing changes."
  - Evidence: [screenshot](scenarios/S3/check-A2.png), [steps](scenarios/S3/report.md)
- **After other's attempt: owner's Days remaining (ownerBalanceAfter) equals ownerBalanceBefore.**: expected 17, actual 20
  - Requirement R20: "Another employee or a manager who tries gets 403 from the API and nothing changes."
  - Evidence: [screenshot](scenarios/S3/check-A3.png), [steps](scenarios/S3/report.md)
- Replayed without a model: replay diverged

## Requirement coverage

| Id | Requirement | Source quote | Compared by |
|---|---|---|---|
| R1 | In "My requests" every Pending request has a Cancel button. | "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day." | S1/A1 match<br>S9/A3 match |
| R2 | In "My requests" every Approved request has a Cancel button. | "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day." | S2/A1 match |
| R3 | The Cancel button's accessible name includes the request's first day and last day. | "In "My requests" every Pending and every Approved request has a Cancel button whose accessible name includes the request's first and last day." | S1/A2 MISMATCH<br>S1/A3 MISMATCH<br>S2/A2 MISMATCH |
| R4 | Rejected requests have no Cancel button. | "Rejected and Cancelled requests have no Cancel button." | S9/A1 match<br>S9/A2 match |
| R5 | Cancelled requests have no Cancel button. | "Rejected and Cancelled requests have no Cancel button." | S1/A7 match |
| R6 | Cancelling a Pending request sets its status to Cancelled. | "Cancelling a Pending request sets its status to Cancelled." | S1/A8 match |
| R7 | Cancelling a Pending request does not change the employee's days remaining. | "The employee's days remaining do not change." | S1/A5 match<br>S1/A6 match |
| R8 | A Pending request can be cancelled at any time (the 3-day notice rule does not apply to it). | "This only applies to Approved requests; a Pending request can be cancelled whenever, since payroll has not seen it yet." | **not compared** |
| R9 | Cancelling an Approved request (outside the notice window) sets its status to Cancelled. | "Cancelling an Approved request sets its status to Cancelled and returns the request's days to the employee's balance." | S2/A3 match |
| R10 | Cancelling an Approved request returns the request's days to the employee's balance. | "Cancelling an Approved request sets its status to Cancelled and returns the request's days to the employee's balance." | S2/A5 match<br>S6/A2 match |
| R11 | "Days remaining" shows the new balance immediately after cancelling, without a reload. | ""Days remaining" shows the new balance straight away and after a reload." | S2/A4 match |
| R12 | "Days remaining" still shows the new balance after a page reload. | ""Days remaining" shows the new balance straight away and after a reload." | S2/A6 match |
| R13 | An Approved request whose first day is exactly today + 3 days (or later) can be cancelled. This overrides the original 'any time before its first day' criterion. | "So an Approved request can be cancelled only when its first day is 3 or more days after today (first day today + 3 is fine, today + 2 is not)." | **not compared** |
| R14 | Cancelling an Approved request whose first day is today + 2 days or sooner (including today and past first days) is refused. | "So an Approved request can be cancelled only when its first day is 3 or more days after today (first day today + 3 is fine, today + 2 is not)." | **not compared** |
| R15 | When an Approved cancel is refused inside the notice window, an error message is shown that states the 3 days. | "Inside that window the cancel is refused with a message that states the 3 days." | S7/A3 match |
| R16 | When an Approved cancel is refused, the request stays Approved. | "cancelling is refused with an error message, the request stays Approved and the balance does not change." | S7/A1 match |
| R17 | When an Approved cancel is refused, the balance does not change. | "cancelling is refused with an error message, the request stays Approved and the balance does not change." | S7/A2 match |
| R18 | Another employee who tries to cancel a request they did not make gets 403 from the API. | "Only the employee who made a request can cancel it. Another employee or a manager who tries gets 403 from the API and nothing changes." | S3/A1 MISMATCH |
| R19 | A manager who tries to cancel a request gets 403 from the API. | "Only the employee who made a request can cancel it. Another employee or a manager who tries gets 403 from the API and nothing changes." | S4/A1 match |
| R20 | After a refused (403) cancel attempt by a non-owner, the request status and the owner's balance are unchanged. | "Another employee or a manager who tries gets 403 from the API and nothing changes." | S3/A2 MISMATCH<br>S3/A3 MISMATCH<br>S4/A2 match<br>S4/A3 match |
| R21 | A Cancelled request cannot be approved: the decision endpoint returns 409. | "A Cancelled request can no longer be approved or rejected (409)." | S5/A3 match<br>S5/A5 match<br>S5/A6 match |
| R22 | A Cancelled request cannot be rejected: the decision endpoint returns 409. | "A Cancelled request can no longer be approved or rejected (409)." | S5/A4 match |
| R23 | For the manager, a cancelled request no longer appears under "Requests awaiting a decision". | "For the manager it leaves "Requests awaiting a decision" and is listed under "Decided" with status Cancelled." | S5/A1 match |
| R24 | For the manager, a cancelled request is listed under "Decided" with status Cancelled. | "For the manager it leaves "Requests awaiting a decision" and is listed under "Decided" with status Cancelled." | S5/A2 match |
| R25 | POST /api/requests/:id/cancel returns the updated request (with status Cancelled) on success. | "The API is POST /api/requests/:id/cancel and returns the updated request." | S6/A1 match |
| R26 | Cancelling a request that is already Cancelled returns 409. | "Cancelling a request that is already Cancelled returns 409 and does not change the balance a second time." | S6/A3 match |
| R27 | Cancelling an already-Cancelled (formerly Approved) request does not return the days to the balance a second time. | "Cancelling a request that is already Cancelled returns 409 and does not change the balance a second time." | S6/A4 match |
| R28 | A cancelled request shows as Cancelled in the employee's "My requests" list. | "A cancelled request shows as Cancelled and can no longer be decided." | S1/A4 match |
| R29 | No notification is sent to the manager when approved leave is cancelled; seeing it under Decided is sufficient. | "Seeing it under Decided is enough for this ticket. Notifications are a separate piece of work." | **not compared** |

Inferred, not stated in any source (never used as an expected value):

- R30: Attempting to cancel a Rejected request via the API is refused and leaves the request Rejected and the balance unchanged.
- R31: Cancelling a non-existent request id returns 404.
- R32: When an Approved cancel is refused in the UI, the error message is displayed on the "My requests" screen (alert above the table) and the row keeps its Cancel button and Approved status.
- R33: An unauthenticated call to POST /api/requests/:id/cancel is rejected (401) and changes nothing.

## Clarification requests

- **Q1** What HTTP status should the API return when an Approved cancel is refused because of the 3-day notice rule (409, 400, 422)?
  - The ticket only says the cancel is refused with a message; the PR returns 409. A tester cannot assert the status code of the notice refusal until this is decided.
- **Q2** Which time zone defines 'today' for the 3-day notice rule: the employee's local date, the company's time zone, or the server's UTC date?
  - Near midnight the date differs between zones, so the boundary case (first day = today + 3 vs today + 2) cannot be given a definite expected outcome until the reference clock is fixed.
- **Q3** Are the 3 days of notice calendar days, or working days (excluding weekends/holidays)?
  - The comment says 'today + 3' which reads as calendar days, but 'days' is used elsewhere for leave days which may be working days; boundary tests over a weekend have no defined expected result.
- **Q4** Should a Cancel button still be shown on an Approved request that is already inside the 3-day window (or already started/past), or should it be hidden or disabled?
  - The description says every Approved request has a Cancel button, while the comment makes such cancels always fail; the expected UI for in-window Approved rows cannot be asserted until clarified.
- **Q5** What should the API return when an employee tries to cancel another employee's request: 403 (as the ticket says) even though that reveals the request exists, or 404?
  - The ticket says 403 for another employee; confirming this avoids a dispute if the implementation chooses 404 to hide other people's requests.
- **Q6** What exact status code and message are expected when cancelling a Rejected request through the API?
  - The ticket only says Rejected requests have no Cancel button; it does not define the API response for a direct call, so the test can only be inferred.
- **Q7** Does a Cancelled request still count against overlap/duplicate checks when the employee creates a new request for the same dates?
  - The ticket does not say whether cancelled leave frees the dates for a new request; a tester cannot know whether re-requesting the same days should succeed.

## Scenarios

| Id | Basis | Title | Result | Detail |
|---|---|---|---|---|
| [S1](scenarios/S1/report.md) | requirement | Employee cancels a Pending request from My requests; balance unchanged | failed | A2: expected 2027-03-08, got Cancel; A3: expected 2027-03-10, got Cancel |
| [S2](scenarios/S2/report.md) | requirement | Employee cancels an Approved far-future request in the UI; days returned immediately and after reload | failed | A2: expected 2027-03-10, got Cancel |
| [S3](scenarios/S3/report.md) | risk | Non-owner employee cannot cancel someone else's Approved request | failed | A1: expected 403, got 200; A2: expected Approved, got Cancelled; A3: expected 17, got 20 |
| [S4](scenarios/S4/report.md) | requirement | Manager cannot cancel an employee's request | passed | All 3 assertions matched. |
| [S5](scenarios/S5/report.md) | requirement | Cancelled request leaves the manager's queue, shows under Decided and cannot be approved or rejected | passed | All 6 assertions matched. |
| [S6](scenarios/S6/report.md) | risk | Double cancel of an Approved request via API: 409 and no second refund | passed | All 4 assertions matched. |
| [S7](scenarios/S7/report.md) | requirement | Approved request starting tomorrow cannot be cancelled (inside notice window) | passed | All 3 assertions matched. |
| [S8](scenarios/S8/report.md) | risk | Approved request starting today + 2 cannot be cancelled (boundary just inside window) | blocked | Not checked: A1, A2. The scenario requires today's date from the Date header of an application response, but api_request returns only status, body and responseId (no headers), and no page or API body seen (/, /api/me, /api/requests) shows the current date. D = today + 2 cannot be determined, so the request cannot be created and A1/A2 were not checked. |
| [S9](scenarios/S9/report.md) | requirement | Rejected request has no Cancel button while a Pending one does | passed | All 3 assertions matched. |
| [S10](scenarios/S10/report.md) | risk | Pending request starting tomorrow can still be cancelled (notice rule only for Approved) | blocked | Not checked: A1, A2. The scenario requires today's date from the Date header of an application response, but the api_request tool returns only responseId, status and body (checked GET /api/requests -> R1 and GET / -> R2); no response headers are exposed and no page shows today's date, so D (today+1) could not be determined. balanceBefore = 20 was recorded; no request was created and A1/A2 were not checked. |
| S11 | risk | Approved request starting exactly today + 3 can be cancelled (boundary) | not run | The outcome at exactly today + 3 depends on whether the 3 days are calendar or working days (over a weekend they differ) and on which time zone defines today (server UTC vs local). Decide both before this boundary can be asserted. |
| S12 | requirement | HTTP status of a notice-window refusal | not run | The ticket only says the cancel is refused with a message; the expected status code (409, 400 or 422) is not documented. |
| S13 | requirement | Cancel button and UI error for an Approved request inside the notice window | not run | The description says every Approved request has a Cancel button, while the payroll rule makes in-window cancels always fail; it must be decided whether the button is shown, hidden or disabled for such rows before the UI can be asserted. |
| S14 | risk | Cancelling a Rejected request through the API | not run | Only an inferred requirement covers a direct API cancel of a Rejected request; the expected status code and outcome are not documented. |
| S15 | risk | Re-requesting the same dates after cancelling | not run | It is not documented whether a Cancelled request still counts in overlap or duplicate checks for a new request on the same dates. |
| S16 | risk | Unauthenticated cancel and cancel of a non-existent id | not run | The 401 and 404 responses are inferred requirements only; the documentation does not state the expected codes. Confirm them before asserting. |

## Risks identified

- **K1** Off-by-one in the notice check: an Approved request starting today + 2 is allowed to be cancelled (and its days refunded), contradicting the payroll rule. — probed by S8, S11
- **K2** No ownership check: any employee can cancel another employee's request, and for Approved leave the days are refunded to the owner without their action. — probed by S3
- **K3** Time zone mismatch on 'today': the server uses the UTC date while employees and payroll likely think in local dates, so the boundary may shift by a day near midnight. — probed by S8, S11
- **K4** Manager's Decided list may not show Cancelled requests (or may show them still awaiting decision) if the existing manager screen filters on Approved/Rejected or on status !== Pending in ways that were not checked. — probed by S5
- **K5** Decision endpoint behaviour for Cancelled requests is assumed, not changed: if decide() checks only for 'Approved'/'Rejected' rather than 'not Pending', a manager could approve a Cancelled request and deduct days again. — probed by S5
- **K6** Balance display may be stale after cancel if render() does not re-fetch /api/me, or the cancel error alert may persist after a later successful action. — probed by S2, S13
- **K7** Balance consistency: double cancels, concurrent cancels, or cancel racing with a manager decision could refund days twice or leave status and balance inconsistent. — probed by S6
- **K8** Refusal message wording must state the 3 days; a change to CANCEL_NOTICE_DAYS or message text could break this requirement. — probed by S7
- **K9** Accessible name uses raw ISO dates ('Cancel request from YYYY-MM-DD to YYYY-MM-DD'); screen-reader tests that look for the dates as displayed must match the same format, and identical date ranges would give duplicate names. — probed by S1
- **K10** Pending requests whose dates are already in the past can be cancelled; also a Pending cancel must not touch the balance, which depends on balance being deducted only on approval. — probed by S1, S10

## Inputs and timing

- Documentation read: README.md
- Changed files: apps/timeoff/README.md, apps/timeoff/public/app.js, apps/timeoff/server.mjs
- Stages: ingest 0s, discover 58s, analyse 71.3s, plan 127.8s, execute 214.9s, confirm 17.3s
- Tool calls in execution: 243
