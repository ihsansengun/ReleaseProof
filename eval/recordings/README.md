# Recordings

Earlier real runs, used by the recorded driver when CI has no model
credential. A recorded run replays that run's analysis, plan and browser
steps with no model involved, and its report says so.

- `NWG-342.json` — the shop's held-out run, with steps recorded on the fixed build.
- `LEAVE-58.json` — the time-off held-out run, with S1 and S2 taken from the
  re-runs made after the accessible-name fix. S7, S8 and S10 are left out
  because their steps contain dates relative to the day they were recorded.
  Other steps name request numbers that depend on run order, so several
  replays are expected to end as unverified.
