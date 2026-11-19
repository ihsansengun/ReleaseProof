<!-- releaseproof-report -->
## ReleaseProof QA: LEAVE-58

**0 failed, 4 passed, 0 not verified** on `2151181a0b` (the application under test reported this commit)

- Documented requirements compared against the application: 20 of 23
- Scenarios planned but not run, waiting on a decision: 6
- Questions for the ticket owner: 7
- Execution mode: autonomous (a live model analysed, planned and executed this run)
- Model: claude-opus-5-5
- Cost and time: about $1.28 of $2.5, 780,996 tokens, 76 model calls, 137 tool calls, 5 of 15 minutes

<details><summary>All scenarios</summary>

| Id | Scenario | Result |
|---|---|---|
| S1 | Employee cancels Approved leave well ahead of time: status, refund shown at once and after reload, second cancel refused | passed |
| S2 | Employee cancels Pending requests \(one inside the notice window, one through the API\) without any balance change | passed |
| S3 | Cancelling Approved leave that starts tomorrow is refused with a 3-day message and changes nothing | passed |
| S4 | Only the owner can cancel; after the owner cancels, the manager sees it under Decided and cannot decide it | passed |
| S5 | Notice-window boundary: Approved leave starting today + 3 can be cancelled, today + 2 cannot | not run: The expected outcome at the boundary depends on two open questions: which 'today' is the reference \(server UTC date, server local date or the employee's local date\), and whether the 3 days are calen… |
| S6 | API status code for a cancel refused by the notice window | not run: The ticket does not say which HTTP status the API returns when the notice window refuses a cancel. Someone must decide it, for example whether 409 is intended. |
| S7 | Cancelling a Rejected request through the API | not run: The ticket only says that Rejected rows have no Cancel button. The API response for a direct cancel of a Rejected request, and any required message, is not specified. |
| S8 | Cancelling a request id that does not exist, as owner-employee, another employee and a manager | not run: The 404 for an unknown id is only inferred from the code. It is also undecided whether a non-owner or a manager should get 403 or 404 for an unknown id, which is a business and security decision. |
| S9 | Cancel attempt while not signed in | not run: No documented requirement covers a cancel from someone who is not signed in. The expected 401 is only inferred, so the product owner must confirm the expected status code before this can be asserted. |
| S10 | Manager's Decided list for a cancelled request that was approved first | not run: The ticket does not say whether the earlier approval should still be visible in the manager's Decided list or whether only status Cancelled is shown. |

</details>

<details><summary>Questions for the ticket owner</summary>

- Which HTTP status should the API return when an Approved request's cancel is refused because of the 3-day notice window \(the implementation uses 409\)?
- Whose 'today' defines the notice window: the server's UTC date, the server's local date, or the employee's local date?
- Are the 3 days of notice calendar days, or working days that skip weekends and holidays?
- What should the API return when someone cancels a Rejected request, and is there a required error message?
- What should a non-owner get when they cancel a request id that does not exist \(403 or 404\)? Should a non-owner be able to tell whether a request id exists?
- Must the notice-window refusal message have exact wording, or only mention 3 days? And should the message clear after a later successful action?
- For the manager's "Decided" list, does a cancelled request keep any record that it was approved first, or does it show only status Cancelled?

</details>

Application ran isolated: outbound network blocked, filesystem read-only, user id 10001, 10 environment variables, none of them credentials.

Full report, steps and screenshots: [workflow run and evidence artifact](https://github.com/ihsansengun/ReleaseProof/actions/runs/44408691152) (kept 14 days).
