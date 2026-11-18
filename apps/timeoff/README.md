# Dayoff (demonstration app B)

A time-off request tool. Employees request leave; managers decide requests.

## Behaviour

- Every employee has a number of leave days remaining.
- A request has a first day, a last day and a reason, and starts as Pending.
- A manager approves or rejects each pending request. A decided request cannot
  be decided again.
- An employee can cancel their own pending or approved requests. Cancelling
  approved leave returns its days to the employee's balance and needs at least
  3 days' notice before the first day. A cancelled request shows as Cancelled
  and can no longer be decided.

## API

All endpoints take and return JSON and use the session cookie.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/session` | anyone | Sign in with `{handle, password}` |
| `DELETE /api/session` | signed in | Sign out |
| `GET /api/me` | signed in | The current user, including `balance` for employees |
| `GET /api/requests` | signed in | Own requests (employee) or all requests (manager) |
| `POST /api/requests` | employee | Create a request from `{start, end, reason}`; dates are `YYYY-MM-DD` |
| `POST /api/requests/:id/decision` | manager | `{decision: "approve" \| "reject"}` |
| `POST /api/requests/:id/cancel` | employee | Cancel one of your own requests; returns the updated request |

## Running

`TEST_MODE=1 GIT_SHA=<commit> PORT=3100 node server.mjs`.
