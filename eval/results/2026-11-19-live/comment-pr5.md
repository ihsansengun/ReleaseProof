<!-- releaseproof-report -->
## ReleaseProof QA: LEAVE-58

**2 failed, 4 passed, 0 not verified** on `9b5e9b1a6d` (the application under test reported this commit)

- Documented requirements compared against the application: 18 of 24
- Scenarios planned but not run, waiting on a decision: 5
- Questions for the ticket owner: 6
- Execution mode: autonomous (a live model analysed, planned and executed this run)
- Model: claude-opus-5-5
- Cost and time: about $1.54 of $3, 878,742 tokens, 92 model calls, 175 tool calls, 5.4 of 15 minutes

### Failures

**S2 Another employee and a manager get 403 when cancelling someone else's approved request**
- HTTP status of POST /api/requests/&lt;id&gt;/cancel made while signed in as employee 'other' \(status\_other\) is 403.: expected `403`, actual `200`
  - Requirement R15: "Another employee or a manager who tries gets 403 from the API and nothing changes."
- After both attempts, signed in as 'owner', the status shown on the 2030-09-02 to 2030-09-03 row in 'My requests' is 'Approved'.: expected `Approved`, actual `Cancelled`
  - Requirement R15: "Another employee or a manager who tries gets 403 from the API and nothing changes."
- After both attempts, the owner's 'Days remaining' \(balance\_final\) equals balance\_approved, recorded after approval and before the attempts.: expected `18`, actual `20`
  - Requirement R15: "Another employee or a manager who tries gets 403 from the API and nothing changes."

**S3 Cancelling an approved request starting two days from now is refused with a message stating 3 days**
- After clicking Cancel on the Approved request whose first day is today+2, a refusal/error message is visible in the page.: expected `present`, actual `absent`
  - Requirement R11: "So an Approved request can be cancelled only when its first day is 3 or more days after today \(first day today + 3 is fine, today + 2 is not\)."

<details><summary>All scenarios</summary>

| Id | Scenario | Result |
|---|---|---|
| S1 | Employee cancels approved far-future leave in the UI: days return to balance immediately and after reload | passed |
| S2 | Another employee and a manager get 403 when cancelling someone else's approved request | failed |
| S3 | Cancelling an approved request starting two days from now is refused with a message stating 3 days | failed |
| S4 | Cancel API returns the updated request, and a repeated cancel gives 409 without a second refund | passed |
| S5 | Manager sees a cancelled request under Decided and cannot approve or reject it | passed |
| S6 | Pending request inside the notice window can be cancelled without balance change; Rejected request has no Cancel button | passed |
| S7 | Exact boundary: an Approved request starting today+3 can be cancelled | not run: Whether today+3 is allowed depends on whether the 3 days are calendar or working days \(Q2\): a weekend between today and the first day would change the outcome. Near midnight it also depends on which… |
| S8 | Refused cancellation leaves the request Approved and the balance unchanged, including on a rapid double click | not run: Q6 asks whether 'stays Approved and the balance does not change' still applies to refusals under the new 3-day window from comment 3. Until that is confirmed, the status and balance after a refusal ca… |
| S9 | Cancel API called directly on a Rejected request | not run: The ticket only states that Rejected rows have no Cancel button. The API response for a direct cancel of a Rejected request \(409 or something else\) is not specified. Decide the expected response \(Q… |
| S10 | Cancel API called with a request id that does not exist | not run: It is unspecified whether an unknown id should return 404 or 403 \(Q4\), and that choice also decides whether request existence is leaked. |
| S11 | Unauthenticated caller cannot cancel a request | not run: No documented requirement covers the cancel endpoint for callers who are not signed in, or the expected status code \(401 or other\). This is only an inferred requirement and needs confirmation. |

</details>

<details><summary>Questions for the ticket owner</summary>

- Which date counts as "today" for the 3-day notice rule: the server's UTC date, the server's local date, or the employee's local date?
- Are the 3 days of notice calendar days, or working days \(excluding weekends and holidays\)?
- What should the cancel API return for a Rejected request: 409, another code, or something else?
- Should cancelling a request id that does not exist return 404 or 403?
- Is there required exact wording for the refusal message, or only that it mentions 3 days? Where in the UI must it appear?
- After comment 3, does the description's "the request stays Approved and the balance does not change" apply to refusals inside the 3-day window?

</details>

Application ran isolated: outbound network blocked, filesystem read-only, user id 10001, 10 environment variables, none of them credentials.

Full report, steps and screenshots: [workflow run and evidence artifact](https://github.com/ihsansengun/ReleaseProof/actions/runs/44497928492) (kept 14 days).
