# Usability feedback template (internal QA)

One entry per observation. Record what happened, not only an opinion; a screenshot or screen recording is expected for every entry. Functional or security defects go in the QA test plan's result fields (`QA_TEST_PLAN.md`) — use this template for how hard or clear the product was to use.

Copy the block below for each observation (or use the same columns in a shared spreadsheet).

```markdown
### UXF-<tester initials>-<NNN>

| Field | Entry |
|---|---|
| Date / build | <DD-MMM-YYYY> / <commit or image tag shown by the operator> |
| Tester / user role | <name> / <persona, e.g. qa-org-a-admin (org_admin)> |
| Journey | 1 Administrator onboarding · 2 Provider setup · 3 Contacts & templates · 4 Message operations & status · 5 Troubleshooting failed messages · Other: <…> |
| Screen(s) | <route, e.g. /whatsapp> |
| Related test ID | <e.g. QA-E-03, or none> |
| What I was trying to do | <the goal, in the user's words> |
| What I expected | <expected outcome> |
| What actually happened | <actual outcome, step where it went wrong> |
| Difficulty | 1 Easy · 2 Minor friction · 3 Confusing, needed retries · 4 Could only finish with help/docs · 5 Could not finish |
| Type | Navigation · Wording/labels · Feedback & errors · Missing action in UI · Data display (IDs, dates, status) · Forms & validation · Accessibility · Performance · Other |
| Frequency | Once · Sometimes · Every time |
| Time taken (approx.) | <minutes> |
| Screenshot / recording | <file name or link> |
| Suggested improvement | <optional; describe the outcome you need, not necessarily the design> |
| Severity (tester view) | Blocker · Major · Minor · Cosmetic |
```

## Severity guidance for usability findings

| Severity | Meaning |
|---|---|
| Blocker | The task cannot be completed through the console by the intended role |
| Major | The task completes only with outside help, guesswork, raw IDs or repeated failures |
| Minor | Completes with noticeable friction or unclear feedback |
| Cosmetic | Visual or wording issue with no effect on task completion |

## End-of-session summary (one per tester per session)

| Field | Entry |
|---|---|
| Tester / role(s) used | |
| Journeys attempted | |
| Journeys completed without help | |
| Top three frustrations | 1. 2. 3. |
| Anything that worked especially well | |
| Overall ease of use (1 very hard – 5 very easy) | |
