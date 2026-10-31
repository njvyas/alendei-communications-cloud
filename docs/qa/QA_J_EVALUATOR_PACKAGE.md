# Section J usability evaluation: evaluator execution package

Prepared 31-Oct-2026 for the Gate F.3 closeout. It covers `QA_TEST_PLAN.md` section J (QA-J-01 – J-09) and the round 1 exit criterion: "Usability feedback collected from at least three testers covering journeys 1–5" (`UX_AUDIT_PLAN.md` §1).

**Status (31-Oct-2026):** the owner directed AI evaluators (Gemini and Claude Code). Claude's AI evaluation of J-03 – J-09 is recorded (`QA_RELEASE_PREPARATION.md` §5j); Gemini's evaluation, J-01/J-02, and any **human** usability and screen-reader evaluation remain outstanding. AI evaluation does not replace an independent human sign-off.

## 1. Evaluator requirements (three independent evaluators)

**Independent** means all of the following:
- not part of the ACC development team;
- not the QA executor (Claude Code) or the reviewer (Gemini);
- not the owner of the account being evaluated.

Each evaluator works alone, without coaching during a task. The facilitator may only read the task card aloud and stop the session if something unsafe happens.

| Evaluator | Profile | Persona(s) | Tasks | Journeys covered |
|---|---|---|---|---|
| **E1 Platform operator** | Someone who would administer tenants (operations or support background) | Platform administrator (see decision J-D2); a multi-organization user | J-01, J-02, J-09 | 1 Administrator onboarding; 2 Provider setup (observe providers and assignments) |
| **E2 Tenant administrator** | Someone who would run messaging for one organization (a business user, not a developer) | `org_admin` in a dedicated evaluation organization or qa-org-a2 (decision J-D3) | J-03, J-04, J-05, J-09 | 3 Contacts and templates; 4 Message operations; 5 Troubleshooting |
| **E3 Accessibility evaluator** | A regular keyboard and screen-reader user (NVDA on Windows or VoiceOver on macOS) | `org_admin` (own account) | J-06, J-07, J-08, J-09; repeats J-03 by keyboard | 3, 4, 5 with assistive technology |

Every evaluator also completes the end-of-session summary in `USABILITY_FEEDBACK_TEMPLATE.md`. Across the three of them, journeys 1–5 are each covered at least once, which satisfies the exit criterion.

## 2. Preconditions (operator and owner)

| # | Precondition | Who |
|---|---|---|
| 1 | Build decided (decision J-D1) and recorded on every feedback entry (`Date / build`) | Owner |
| 2 | One account per evaluator per persona, created through the console and activated with `activate-user`. Passwords generated per person and handed over out of band, never by email or chat in clear (`INTERNAL_QA_DEPLOYMENT.md` §7). No shared accounts | Operator |
| 3 | E1's multi-organization user holds roles in at least two organizations (needed for J-02; also unblocks the QAF-014 console check) | Platform administrator |
| 4 | Data for E2 and E3: 5–10 contacts, one approved WhatsApp template, and some failed messages from the previous day (J-04 and J-05). The 10 failed QA-F-07 messages in qa-org-a2 (31-Oct-2026) can serve J-04/J-05 if the evaluator uses qa-org-a2 | Operator / owner |
| 5 | Routing that produces both outcomes: a working provider (`QA Sim OK`) and a failing one, so that J-04 has a real failure. The current qa-org-a2 routing (`QA Sim 500` priority 1, `QA Sim OK` priority 2) gives fallback success; a failure needs `QA Sim 500` alone or an existing failed message | Operator |
| 6 | Browser trusts the QA private root CA, or the untrusted-certificate step is noted as a known limitation (D1) | Operator |
| 7 | Screen recording available; recordings and screenshots stored in the evidence location outside Git, never in the repository | Facilitator |
| 8 | Evaluators told: synthetic data only; no real personal data may be entered | Facilitator |

## 3. Session plan (about 90 minutes per evaluator)

1. **Introduction (5 min):**
   - purpose: evaluate the product, not the person;
   - think aloud;
   - the evaluator may give up on a task.
2. **Sign-in (5 min):** the evaluator signs in with their own account. Record any friction as part of journey 1.
3. **Tasks (60 min):** for each card in §4:
   - read the card aloud and start a timer;
   - do not help;
   - record time, retries, confusion and outcome (completed / completed with difficulty / not completed).
4. **Feedback (15 min):** one `UXF-<initials>-<NNN>` entry per observation, plus the end-of-session summary.
5. **Close (5 min):**
   - sign out;
   - the facilitator confirms recordings are saved and checksummed;
   - the operator revokes the evaluator's sessions if the account is retired.

## 4. Task cards (read exactly as written)

| ID | Card | Observe and record |
|---|---|---|
| J-01 (E1) | "A new customer, *Evaluation Org E1*, has signed up. Set the organization up and give its administrator access." | Steps needing raw IDs, outside help or the operator; where the evaluator expects an activation e-mail (known gap U3: activation is an operator command) |
| J-02 (E1) | "You look after two customers. Sign in, open the second customer's workspace, then switch to the first." | Whether organizations are recognisable by name (U1); switching cost |
| J-03 (E2, E3 by keyboard) | "Send the approved welcome template to one of your contacts and find out whether it worked." | Clarity of status and attempts |
| J-04 (E2) | "One of yesterday's messages failed. Find out why and what you would do next." | Clarity of failure reason and next step (U5) |
| J-05 (E2) | "Find a message you sent yesterday to a specific contact." | Filters and pagination on `/messages`; time and difficulty |
| J-06 (E3) | "Using only the keyboard: sign in, add a contact, and send a message." | Visible focus; dialogs usable; Escape behaviour (U10) |
| J-07 (E3) | "With your screen reader, check the Users, Audit Logs and WhatsApp pages." | Inputs announced with names; status changes announced |
| J-08 (E3) | "Set the browser to 200 % zoom in a 1280 px window and repeat J-03." | Lost content or controls (screenshots) |
| J-09 (all) | "Look back at every error you saw today. Could you understand each one without a code?" | Understandability of error messages |

## 5. Recording and evidence

- **Format:** `USABILITY_FEEDBACK_TEMPLATE.md`, one entry per observation, each with a screenshot or recording reference.
- **Severity:** use the template's scale. Any functional or security defect goes to `QA_FINDINGS_REGISTER.md` with a `QAF-` ID (next free: QAF-025), not only to the usability log.
- **Storage:** evidence outside Git (for example `~/acc-evidence/<date>-qa-j/`) with a `MANIFEST.sha256`. Feedback forms may name the evaluator by initials only; the mapping from initials to people stays in the access register, outside Git.
- **Results:** recorded in `QA_TEST_PLAN.md` section J (`Actual` column) as tester-run, with the build. The usability items are triaged against `UX_AUDIT_PLAN.md` U1–U14.

## 6. Completion criteria

- All three evaluators have completed their sessions, with feedback entries and summaries.
- Each J task has a result (`PASS`, `FAIL — …` or `BLOCKED — …`).
- Journeys 1–5 are each covered by at least one evaluator.
- No open S1 finding; S2 findings triaged by the owner (`QA_TEST_PLAN.md` exit criteria).

## 7. Owner decisions required before scheduling

| ID | Decision | Why it is needed |
|---|---|---|
| J-D1 (**decided by the release decision, 31-Oct-2026**) | **Build to evaluate:** `2026.10.24-441a29a`, the historical F.3 candidate; no deployment is authorized. Evaluators therefore see behaviour from **before** U1, U10, U8, #28 and #30. Findings that those changes already address are recorded against `441a29a` and cross-referenced, not re-raised. Original question: the current QA release `2026.10.24-441a29a`, or a newer `develop` build deployed to QA first | QA runs `441a29a`. Later `develop` changes target exactly what J measures: U1 organization picker (J-02), U10 accessibility (J-06 – J-08), U8 simulator control, contacts newest-first (#30), WhatsApp template filter (#28). Evaluating `441a29a` measures superseded behaviour; deploying needs a separate QA upgrade authorization and changes the Gate F.3 release commit (see `GATE_F3_CLOSEOUT.md`) |
| J-D2 (**decided: option (b), 31-Oct-2026**) | The owner operates the platform-administrator screen while E1 directs the task (think-aloud). Bootstrap credentials are never shared. Record in each J-01 feedback entry that the evaluator directed and did not operate. Original question: **Platform-administrator access for E1 (J-01):** QA has exactly one platform administrator, the bootstrap account, which D2 says must not be shared. A second platform persona cannot be activated with `activate-user` (`INTERNAL_QA_DEPLOYMENT.md` §7) | Options: (a) the bootstrap account's owner performs J-01 as E1 (not independent for that task); (b) E1 directs while the account owner operates (think-aloud; record the deviation); (c) defer J-01 and record it as BLOCKED |
| J-D3 (**decided: qa-org-a2, 31-Oct-2026**) | E2 and E3 use `qa-org-a2` with the existing data in §8. Original question: **Organization for E2/E3:** a new evaluation organization (cleaner; needs platform-admin set-up and data) or qa-org-a2 (existing data including failed messages; shares state with other QA work) | Affects preparation effort and isolation |
| J-D4 (**open, owner input**) | **Nominate the three evaluators** (names recorded outside Git) and the facilitator | Section J cannot start without them |

## 8. Existing qa-org-a2 data and residuals (read-only inventory, 31-Oct-2026)

Evaluators must not be told how this data was produced; the facilitator uses this table to choose tasks and explain anomalies afterwards. All data is synthetic (recipients `+1 202 555 …`).

| Item | State | Relevance to J |
|---|---|---|
| Contacts | 52 synthetic contacts (QA runs of 26-Oct and 31-Oct; includes one with revoked WhatsApp consent and 10 created by QA-F-07) | J-03: choose a contact with consent; a revoked-consent contact produces a refusal (also useful for J-09) |
| Templates | WhatsApp `qa_f07_circuit_test` approved (simulator approval only); SMS: 1 approved, 1 pending | J-03 uses the WhatsApp template |
| Messages | 41 in total: WhatsApp 17 accepted, 17 failed, 1 `outcome_unknown`; RCS 3 accepted, 1 failed; SMS 2 accepted. Sent on 26-Oct (31) and 31-Oct (10, all failed: QA-F-07) | J-04/J-05: real failed messages exist. The 10 QA-F-07 failures show `NO_ELIGIBLE_PROVIDER` (refused by an open circuit), so J-04 tests how understandable that reason is |
| Routing | WhatsApp: `QA Sim 500` priority 1 (circuit **open** since 26-Oct; residual QAF-021), `QA Sim OK` priority 2 (healthy); `QA Sim Timeout`, `QA Sim 500 F07` and `QA Sim 429` assignments disabled | A J-03 send is expected to fall back to `QA Sim OK` and be accepted, with an extra attempt or a refusal on `QA Sim 500` visible in the attempts. Evaluators may find this confusing; record it, it is genuine |
| Suppressions | None active | — |
| Retained providers | `QA Sim 500 F07` (active, circuit open, assignment disabled) appears in provider lists | E1 may see it on `/providers`; it is test residue |

Any message an evaluator sends adds to this data; note the time window of each session so evaluator activity can be separated from earlier QA runs.

