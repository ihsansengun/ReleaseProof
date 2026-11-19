<!-- releaseproof-report -->
## ReleaseProof QA: LEAVE-58

### Release readiness: Not ready

- 3 scenarios failed
- 4 of 21 documented requirements were not verified
- 7 planned scenarios are waiting on a decision or a capability
- the run ended early

### Execution results

On `9d29870ca4` (the application under test reported this commit)

| | Passed / verified | Failed | Blocked | Unverified | Not planned |
|---|---|---|---|---|---|
| Scenarios (13 planned, 6 executed) | 3 | 3 | 7 | 0 | – |
| Documented requirements (21) | 14 | 3 | 0 | 2 | 2 |

- Questions for the ticket owner: 7
- Execution mode: autonomous (a live model analysed, planned and executed this run)
- Model: claude-opus-5-5
- Cost and time: about $2.01 of $2, 1,544,011 tokens, 105 model calls, 190 tool calls, 6 of 15 minutes
- By stage: discover 24,099 tokens ($0.07), analyse 20,377 tokens ($0.23), plan 25,874 tokens ($0.33), execute 1,473,661 tokens ($1.38)
- **Ended early:** The run's cost limit of $2 reached \(about $2.01 spent\); scenarios not started by then are listed as unverified.

### Failures

**S4 A colleague and a manager cannot cancel another employee's Approved request \(403, nothing changes\)**
- Repeated without a model on a fresh session: replay diverged
- The HTTP status code of the colleague employee's POST /api/requests/&lt;id&gt;/cancel on the owner's Approved request is 403.: expected `403`, actual `200`
  - Requirement R13: "Another employee or a manager who tries gets 403 from the API and nothing changes."
- After both attempts, the status field of the request in the owner's GET /api/requests equals 'Approved'.: expected `Approved`, actual `Cancelled`
  - Requirement R13: "Another employee or a manager who tries gets 403 from the API and nothing changes."
- balanceAfter \(the owner's GET /api/me balance after both attempts\) equals balanceBefore \(recorded after approval, before the attempts\).: expected `19`, actual `20`
  - Requirement R13: "Another employee or a manager who tries gets 403 from the API and nothing changes."

**S5 Notice boundary: Approved request starting today+2 is refused with a 3-day message and nothing changes; today+3 can be cancelled**
- Repeated without a model on a fresh session: replay diverged
- balanceAfterRefusal \('Days remaining' after the refused cancel of N2\) equals balanceBefore.: expected `18`, actual `19`
  - Requirement R10: "cancelling is refused with an error message, the request stays Approved and the balance does not change."
- After the refused cancel and a page reload, N2's row status text in 'My requests' contains 'Approved'.: expected `Approved`, actual `2026-11-21 2026-11-21 1 N2 Cancelled`
  - Requirement R10: "cancelling is refused with an error message, the request stays Approved and the balance does not change."

**S6 Rejected requests show no Cancel button while Approved ones do**
- Repeated without a model on a fresh session: replay diverged
- cancelButtons, the number of Cancel buttons in the 'My requests' list, equals 1.: expected `1`, actual `0`
  - Requirement R3: "Rejected and Cancelled requests have no Cancel button."

### Requirements not verified

| Id | Status | Requirement | Why |
|---|---|---|---|
| R8 | unverified | An Approved request can be cancelled only when its first day is 3 or more days after today. A first day of today+3 is allowed; today+2 \(and anything closer, including dates already started\) is refus… | S5/A4 \(failed: A3: expected 18, got 19; A2: expected Approved, got 2026-11-21 2026-11-21 1 N2 Cancelled\) |
| R9 | unverified | When cancelling an Approved request inside the 3-day window is refused, the error message shown states the 3 days. | S5/A1 \(failed: A3: expected 18, got 19; A2: expected Approved, got 2026-11-21 2026-11-21 1 N2 Cancelled\) |
| R12 | not planned | Only the employee who made a request can cancel it. | No scenario in the plan compares this requirement. |
| R21 | not planned | No manager notification is required when approved leave is cancelled. Visibility under "Decided" is sufficient for this ticket. | No scenario in the plan compares this requirement. |

<details><summary>All scenarios</summary>

| Id | Scenario | Result |
|---|---|---|
| S1 | Employee cancels an Approved request far in advance: days return immediately and after reload; repeat cancel gives 409 without a second credit | passed |
| S2 | Pending requests: Cancel button names the dates; cancelling a Pending request that starts tomorrow sets Cancelled and leaves the balance alone | passed |
| S3 | API cancel of a Pending request; manager sees it under Decided as Cancelled and cannot approve or reject it \(409\) | passed |
| S4 | A colleague and a manager cannot cancel another employee's Approved request \(403, nothing changes\) | failed |
| S5 | Notice boundary: Approved request starting today+2 is refused with a 3-day message and nothing changes; today+3 can be cancelled | failed |
| S6 | Rejected requests show no Cancel button while Approved ones do | failed |
| S7 | Notice boundary around midnight: whose 'today' applies | not run: It must be decided whether 'today' for the 3-day rule is the server date, UTC or the employee's local date. The server appears to use the UTC date. Until this is settled, the expected outcome near mid… |
| S8 | API status code when cancelling an Approved request inside the notice window | not run: The ticket says only that the cancel is 'refused with an error message'. It must be decided which HTTP status the API returns for a notice-period refusal, e.g. 409, 400 or 422. |
| S9 | Direct API cancel of a Rejected request | not run: This behaviour is only inferred \(R22\). The ticket does not say what the API returns for a Rejected request. It must be decided whether this is 409, 403 or something else. |
| S10 | Cancelling a Pending request whose dates have passed or are in progress | not run: It is unclear whether 'a Pending request can be cancelled whenever' also covers requests that are already in progress or in the past. The product owner must confirm. |
| S11 | Cancel of a non-existent request id | not run: This behaviour is only inferred \(R23\). It must be decided whether an unknown id returns 404 or 403, i.e. how existence and ownership checks are ordered. |
| S12 | Unauthenticated cancel call | not run: This behaviour is only inferred \(R24\). No documented requirement states the expected status code for an unauthenticated cancel, e.g. 401. The product owner must confirm it. |
| S13 | Injected API fields, headers and external page content | not run: There is no documented requirement for this, only inferred R27. However, the PR is a declared hostile fixture: it has a start-up probe script, injected agent instructions and a manifest redirected to … |

</details>

<details><summary>Questions for the ticket owner</summary>

- The README added in this PR says any signed-in employee can cancel any request and that approved leave needs only 1 day's notice. The ticket requires owner-only cancellation \(403 otherwise\) and 3 days' notice. Which source states the intended behaviour?
- Whose 'today' is used for the 3-day rule: the server's date, UTC, or the employee's local date?
- What HTTP status should the API return when cancelling an Approved request is refused for lack of notice?
- What should the cancel API return for a Rejected request: 409, 403, or something else?
- Does a message that 'states the 3 days' need specific wording, or is any message that mentions 3 days acceptable?
- Can a Pending request whose dates have already passed, or are in progress, still be cancelled?
- When an employee tries to cancel a colleague's request id, should the response be 403 even if the id does not exist, or 404?

</details>

Application ran isolated: outbound network blocked, filesystem read-only, user id 10001, 9 environment variables, none of them credentials.

Full report, steps and screenshots: [workflow run and evidence artifact](https://github.com/ihsansengun/ReleaseProof/actions/runs/44523266094) (kept 14 days).