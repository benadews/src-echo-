# Echo — sweep (Phase 1)

Detection only. **This code sends nothing.** The nudge composer is a separate
workflow that does not exist yet, and `echo_config.nudges_enabled` ships `false`
regardless. The purpose of Phase 1 is to fill the dashboard and let you check
findings against the under-10%-false-positive gate before anyone is messaged.

## Install

This is a standalone repo. `package.json` and `tsconfig.json` are included, so
there is nothing to merge into another project — GitHub Actions installs the
dependencies itself on the first run.

Echo shares Victor's **Supabase database** (that's the part that matters) but
runs on its own schedule, in its own repo, with its own kill switch.

## Secrets

Add to GitHub repository secrets:

| Secret | Notes |
|---|---|
| `SUPABASE_URL` | Victor's existing project |
| `SUPABASE_SERVICE_ROLE_KEY` | **Never** ship this to the Lovable front end |
| `TEAMWORK_API_TOKEN` | Needs permission to read activity, time and tasks |
| `TEAMWORK_BASE_URL` | `https://wetakeflight.eu.teamwork.com` |

## Run it once by hand first

```bash
npx tsx src/echo/sweep.ts
```

It prints a JSON summary and writes a row to `echo_run`. Expect the **first run
to be the slow one** — it snapshots every open task to establish stage history,
and anything already past its stage tolerance is marked `is_legacy_backlog`
(the amnesty cohort).

## Wire up the roster before anything else

`syncRoles()` in `src/echo/roles.ts` needs your opex backend. Until it runs,
`is_staff` is whatever the seed set it to.

This is a **safety** boundary, not a convenience: Teamwork's user list contains
clients and guests who read as ordinary team members through the API (PJ
Holdsworth is one). `is_staff` defaults to `false`, and false means never
messaged, never shown, excluded from every metric. Anyone absent from opex is
demoted automatically on each sweep, so a guest added to Teamwork tomorrow
cannot leak in.

## What the code deliberately does the awkward way

Each of these is a correction from testing against the live account, not a
stylistic choice. Removing any of them reintroduces a specific measured bug.

**Evidence is keyed on `(source, item, day)`, not on the activity row.**
Teamwork emits the same comment repeatedly as `new` then `edited` rows with
different activity ids. Measured: 55 of 303 rows, 18% inflation, flowing
straight into the "is this a busy day" threshold.

**Activity date filters are ignored and filtered client-side.** A query scoped
to 4 August returns rows stamped 5 August. Verified.

**Signals are clustered into sessions.** 6 signals inside 12 minutes is one bulk
action, not a working day. Requires 2+ sessions or a 30+ minute span; suppressed
3 of 7 candidates on real data, all correctly.

**Mentions require `notifiedUserIds` ∩ parsed `@handles`.** `notifiedUserIds`
includes followers. Trusting it alone gave 94 mentions over three days; the
intersection gave 53 — 44% were people merely copied in.

**Timelog days come from `timeLogged`, computed in Europe/London.** Never
`createdAt`, and never a summary endpoint: `summarize_timelogs` and
`list_timelogs` disagree about which day a backdated log belongs to.

**Stage entry dates are tracked by Echo itself.** Teamwork does not expose when
a task entered its stage; `updatedAt` moves on any edit. First-sighted tasks get
`entered_at_is_estimate = true` and are held back from DMs.

**"With Client" breaches belong to the project manager.** A task sitting 26 days
there is the client not replying. Routing it to the assignee would blame
developers for client delays.

## Verification status

- `tsc --noEmit` clean under `strict`
- Session clustering and mention parsing unit-tested against the real 4 August
  and 31 July data, including boundary cases at 29/31 minutes
- London day boundaries tested across BST and GMT

## Not in this phase

The nudge composer, the Slack Block Kit messages, the `echo-apply` Edge Function
and the weekly roundup. Those come once the false-positive gate passes — and the
copy needs the CI pronoun lint in place before it ships, since Echo has no gender
data and must never infer any.
