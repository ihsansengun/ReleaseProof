# SEALED answer key: timeoff, LEAVE-58 "Employees can cancel their own time-off requests"

- Feature branch: `claude/heldout-timeoff-cancel-requests` (commit `08e7842`), base `965be18`
- Fixed branch: `claude/heldout-timeoff-cancel-requests-fixed` (commit `88372b5`)
- Line numbers below refer to `apps/timeoff/server.mjs` on the feature branch.

## Feature

Employees can cancel their own Pending or Approved requests, through a Cancel button in "My requests" or `POST /api/requests/:id/cancel`. The request becomes `Cancelled`. Cancelling Approved leave returns its days to the employee's balance and, per the last ticket comment (which replaces "any time before the first day" in the description), needs at least 3 days' notice: the first day must be today + 3 or later. Pending requests can be cancelled at any time. A cancelled request cannot be decided and shows under the manager's "Decided" list.

"Today" is the server's current date in UTC (`new Date().toISOString().slice(0, 10)`).

## Acceptance criteria

| # | Criterion (short) | Feature branch |
|---|---|---|
| 1 | Cancel button (accessible name includes first and last day) on Pending and Approved rows only | Correct (`aria-label` "Cancel request from YYYY-MM-DD to YYYY-MM-DD"; Rejected/Cancelled rows have an empty Action cell) |
| 2 | Cancel Pending -> Cancelled, balance unchanged | Correct |
| 3 | Cancel Approved -> Cancelled, days returned, "Days remaining" updated immediately and after reload | Correct |
| 4 | (Refined by comment) Approved needs 3 days' notice: first day >= today + 3 is cancellable, today + 2 or sooner is refused with a message stating the 3 days; request stays Approved, balance unchanged. Pending is exempt | **Defect 1** (today + 2 is accepted); today + 3 and today + 1 behave correctly; Pending exemption correct |
| 5 | Only the requesting employee can cancel; another employee or a manager gets 403 and nothing changes | **Defect 2** (another employee can cancel); manager correctly gets 403 |
| 6 | Cancelled request cannot be decided (409); leaves the manager's awaiting list and appears under Decided as Cancelled | Correct |
| 7 | `POST /api/requests/:id/cancel` returns the updated request; cancelling twice returns 409 and does not refund twice | Correct |

## Planted defects

### Defect 1: the notice period is counted inclusively, so 2 days' notice is accepted (different rule/number than the ticket; boundary)

- Where: line 54, `noticeDays`: `Math.round((Date.parse(date) - Date.parse(today)) / DAY) + 1`. The `+ 1` makes a first day of today + 2 count as 3 days. It is compared with `CANCEL_NOTICE_DAYS = 3` on line 65. The fixed branch drops the `+ 1`.
- Violates: criterion 4 as refined by the last comment ("first day today + 3 is fine, today + 2 is not").
- Steps (T = today's date in UTC): employee with balance 20 requests a 1-day leave with first day = last day = T + 2. Manager approves it (balance 19). Employee clicks Cancel on it (or `POST /api/requests/<id>/cancel`).
  - Expected: 409 with error "Approved leave can only be cancelled at least 3 days before its first day." (shown in the alert above "My requests"); status stays Approved; balance stays 19.
  - Actual: 200, status Cancelled, balance back to 20.
- Only T + 2 shows it. T + 3 and later are cancellable on both branches; T + 1, T and past dates are refused on both branches. With the verification run on 2026-11-18: first day 2026-11-20 was cancelled on the feature branch and refused on the fixed branch.

### Defect 2: any employee can cancel another employee's request (second user)

- Where: lines 156-159, the cancel route. It checks `user.role !== "employee"` (403 for managers) and that the request exists, but never compares `request.employee` with `user.handle`. The fixed branch adds `if (request.employee !== user.handle) return send(res, 403, ...)` after the 404 check.
- Violates: criterion 5 ("Only the employee who made a request can cancel it. Another employee ... gets 403 from the API and nothing changes").
- Steps: employee A (balance 20) requests 4 days with first day T + 30; manager approves (A's balance 16). Sign in as employee B and call `POST /api/requests/<A's request id>/cancel` (request ids are sequential and are shown to the manager as "#N"; B has no button for it in the UI, so this is an API-level check).
  - Expected: 403 `{"error":"Only the employee who made a request can cancel it."}`; A's request stays Approved; A's balance stays 16.
  - Actual: 200 with A's request, status Cancelled; A's balance is 20 again. A sees the request as Cancelled in "My requests"; the manager sees it under Decided as Cancelled. The same works for A's Pending requests (status becomes Cancelled).
- A manager calling the endpoint correctly gets 403 on both branches, so a tester who only tries "a manager cannot cancel" will see a pass.

## Deliberately missing business rules (the ticket does not say; the code does something)

1. **Cancelling a Rejected request through the API.** The ticket only says Rejected rows have no Cancel button; it does not say what `POST /api/requests/:id/cancel` does for one. The code returns 409 `{"error":"Only pending or approved requests can be cancelled."}` and changes nothing. (Verified by running, both branches.)
2. **Which "today" the 3 days are counted from.** The ticket does not name a time zone or cut-off time. The code uses the server's current UTC date and compares whole calendar dates, so the result can differ by one day from the tester's local date around midnight UTC.

Also not addressed and worth knowing: an unknown request id returns 404 `{"error":"No such request."}`; an unauthenticated call returns 401.

A tester should raise these as questions about the requirement, not as defects.

## Easy to mistake for a defect, but correct

- **The description's "any time before its first day" is superseded.** The last comment sets the rule to 3 days' notice. An Approved request starting tomorrow (T + 1) is correctly REFUSED even though it is "before the first day". An Approved request starting T + 3 is correctly cancellable (boundary is inclusive).
- **A Pending request starting tomorrow (or even today) can be cancelled.** The notice rule only applies to Approved requests, as the comment says. Verified: Pending request with first day T + 1 -> 200 Cancelled.
- **Cancelling a Pending request does not change "Days remaining".** Days are only deducted on approval, so there is nothing to return. A tester expecting the balance to go up after cancelling a Pending request would be wrong.
- **Cancelling Approved leave returns exactly the request's `days`** (inclusive day count, e.g. 28-30 Nov = 3 days). Balance 9 -> 12 in the verification run.
- **Deciding a cancelled request returns 409 with "This request was already decided."** The wording is the existing message for any non-Pending request; the criterion only requires the 409.
- **Cancelling twice returns 409 "This request was already cancelled."** and the balance is not changed again.
- **A manager gets 403**, not 404, from the cancel endpoint, with the message "Only the employee who made a request can cancel it."
- **The Cancel button is still shown on an Approved request inside the notice window.** The ticket puts the button on every Approved request; the refusal comes as an error message (alert above the table) when it is clicked.
- **The app keeps state in memory**, so restarting the server clears requests; "after a reload" means a page reload, not a server restart.

## Verification performed

Both branches: server started with `TEST_MODE=1`, two employees (balance 20) and one manager created through `/api/test/users`, exercised with `curl`; `node --check public/app.js` passes and the served `app.js` contains the Cancel button code. The browser UI itself was not driven (no browser run); the client was reviewed by reading it.

| Check | Feature branch | Fixed branch |
|---|---|---|
| Cancel Pending starting T + 1 | 200 Cancelled, balance unchanged | same |
| Cancel Approved starting T + 10 (3 days) | 200, balance 9 -> 12 | same |
| Cancel same request again | 409, balance still 12 | same |
| Cancel Approved starting T + 3 | 200, days returned | same |
| Cancel Approved starting T + 2 | 200 Cancelled, day returned (defect 1) | 409 with 3-day message, unchanged |
| Cancel Approved starting T + 1 | 409 with 3-day message | same |
| Cancel Rejected | 409 "Only pending or approved requests can be cancelled." | same |
| Employee B cancels A's Approved request | 200, A refunded 4 days (defect 2) | 403, unchanged |
| Manager calls cancel | 403 | same |
| Manager decides a Cancelled request | 409 | same |
| Unknown id / not signed in | 404 / 401 | same |
| Manager's request list shows Cancelled status | yes | yes |
