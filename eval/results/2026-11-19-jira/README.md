# Live Jira ingestion, 19 November 2026

A read-only check of the engine's Jira Cloud provider and of requirement-source
classification against a real workspace (`releaseproof.atlassian.net`,
project `KAN`). No model was involved and nothing in Jira was changed by the
check. Script: [verify.mts](verify.mts). Output: [output.json](output.json).

## The tickets

Created for development and evaluation, as Stories with the label
`releaseproof-eval`. The earlier fixture files in `eval/tickets/` and the
results recorded with them are unchanged.

| Key | Summary | Domain | Purpose |
|---|---|---|---|
| KAN-4 | Promo codes in the cart | E-commerce promotions | Matches the shop application. A requirement-owner comment changes the TAKE15 minimum from $50.00 to $60.00. Unstated on purpose: a second valid code; an emptied cart |
| KAN-5 | Employees can cancel leave requests | HR leave management | Matches the time-off application. The description says approved leave can be cancelled "any time before the first day"; a requirement-owner comment replaces that with 3 days' notice. Unstated on purpose: whose "today"; the status code for a refusal |
| KAN-6 | Workspace roles and member invitations | SaaS permissions | A third domain with no application yet |
| KAN-7 | Sign users out after inactivity | SaaS security | Deliberately ambiguous: no durations, undefined terms, two criteria that disagree about the warning |

## How it was accessed

- Through Atlassian's API gateway (`https://api.atlassian.com/ex/jira/<site id>`),
  REST API v3, with a credential saved through the environment's secure
  credential form. The value was never visible to the session or the engine:
  the network proxy adds it to requests for that one host, and the engine ran
  with placeholders (`JIRA_EMAIL=placeholder`, `JIRA_API_TOKEN=proxy-injected`).
- The engine issues GET requests only, for one issue and its comments, and
  does not follow redirects.
- Whether the token is limited to read scopes is set where it was created
  and cannot be seen from here.

## Results

| Check | Result |
|---|---|
| Issues retrieved | KAN-4, KAN-5, KAN-6, KAN-7, each with its Jira issue id, summary, reporter account id and update time |
| Unknown issue (KAN-999) | Reported as not found; nothing invented |
| Descriptions | 2,005, 1,587, 2,136 and 848 characters. Headings, bullet lists and numbered criteria survive conversion from Jira's document format as separate lines (16, 13, 17 and 7 list items). Numbered items arrive as list items without their numbers |
| Comments | KAN-4 and KAN-5 have one each, retrieved with comment id, author account id and timestamp |
| Author identity | The account id on both comments and on every issue's reporter is the one listed under `requirementOwners.jira` in `.releaseproof/authority.yml`. The file needed no correction |
| Trust assigned | Summary and description: authoritative (authenticated Jira record). Both comments: authoritative (listed requirement owner, by account id) |
| Same comments with a mocked account id outside the owner list | Unverified |
| Requirement change picked up | The fingerprint of the authoritative sources differs with and without the owner comment on KAN-4 and KAN-5, so a plan would be regenerated; it is identical for KAN-6 and KAN-7, which have no comments |
| Credential exposure | The output contains no credential, header or placeholder (the script fails if it does) |

## What this does not show

- A comment by a real second Jira account. Non-owner comments are covered
  with mocked identities here and in `packages/agent/test/authority.test.ts`.
- A full run driven by one of these tickets. No pull request is titled with a
  `KAN` key yet.
- Jira ingestion from GitHub Actions. That needs the repository secret
  `JIRA_API_TOKEN` and the variables `JIRA_BASE_URL` and `JIRA_EMAIL`.
- **Who may edit a description.** The summary and description are trusted
  because Jira returned them to an authenticated request. Jira's own
  permissions decide who may edit an issue, and that can be wider than the
  configured owner list. Comments are checked against the list; the
  description is not. This is an open authorisation gap.
