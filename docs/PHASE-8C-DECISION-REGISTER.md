# Phase 8C — Owner decision register

**Status:** Rev 2, 10-Nov-2026. **OD-8C-1 to OD-8C-3 were DECIDED by the owner on 10-Nov-2026**; each decision is recorded under its question. Only decisions the design genuinely cannot settle are listed. Proposed defaults marked [P] in the handover can be changed at review.

---

## OD-8C-1 — Automated sender identity (joint with D-5 / OD-8B-5)

**Context [V]:**
- `app_content_context_valid()` admits only an active org-level user session or an API key.
- The core requires a send-permission proof bound to the transaction.
- A runner session with neither cannot create a message. That is correct and fail-closed, and must not be weakened ad hoc (7-3 handover §8).

**Options:**

| Option | Description | For | Against |
|---|---|---|---|
| A | **Claim-bound automation session.** A narrow SECURITY DEFINER mints a tenant session for one claimed execution (as `acc_dispatch` is bound to a dispatch claim). `app_content_context_valid()` admits it only while that claim is live. The send proof is issued for "journey J, version V" | Least privilege; follows the existing dispatch precedent; auditable | A new admitted context kind in the RLS predicate: a security-sensitive migration |
| B | **Run as the activating user.** The runner impersonates the activating user's membership | No new principal kind | Breaks when the user leaves or loses rights, or silently keeps sending in their name; impersonation risk |
| C | **Per-organisation automation API key.** Created at activation and used by the runner | Reuses API-key admission | Long-lived secret material held by the server; broad send rights not bound to one journey |

**Recommendation:** Option A, decided **once** for both 8B-3 and 8C. **Run-as semantics:** the journey itself is the principal.
- Activation and resume require the acting user to hold `journeys.manage` and `messages.send` at the journey's workspace.
- Later loss of that user's access does **not** stop the journey [P]. It is re-checked at the next activation or resume.

**The owner must choose:** A, B or C. Under A, also whether activator off-boarding should automatically pause journeys.

**Blocks:** enabling sends (8C-5 enablement, 8C-6). Not 8C-1 to 8C-4.

**DECIDED (owner, 10-Nov-2026):** a shared, organisation-owned automation sending principal for campaigns and journeys. It uses short-lived, execution-scoped capabilities, preserves initiator attribution, and supports administrator pause and revocation. The initiating user's departure does not automatically terminate an authorised automation. Designed and built in 8B-3; reused by 8C-6.


---

## OD-8C-2 — Sequencing against 8B-3 (campaign execution)

**Context:**
- `ROADMAP.md` §11c makes 8C depend on 8B.
- 8B-3 (dispatch) is not built, and needs the same principal (OD-8C-1).

**Options:**
- **A:** Build 8C-1 to 8C-4 now, with no sends. Implement the shared principal in 8B-3 first, then enable journey sends in 8C-6.
- **B:** Hold all of 8C until 8B-3 is merged.
- **C:** Implement the principal in 8C first, and let 8B-3 reuse it.

**Recommendation:** **A.** It keeps the roadmap order for sends, does not idle 8C, and avoids designing the principal twice.

**Blocks:** 8C-6.

**DECIDED (owner, 10-Nov-2026):** build 8C-1 to 8C-4 first. The shared campaign sending identity belongs in 8B-3, and journey sending in 8C-6 must reuse it.


---

## OD-8C-3 — Webhook/API action nodes

**Context:**
- The roadmap lists webhook/API actions in 8C.
- No outbound HTTP client exists, and the scope-creep "network" category forbids one [V].
- A real implementation needs:
  - SSRF controls (blocking private, link-local and metadata addresses; DNS re-resolution);
  - a destination allowlist;
  - request signing;
  - secret storage (the credential ADR is not frozen, `PROVIDER_ADAPTER.md` §4a);
  - timeouts and retries;
  - response handling.

**Options:**
- **A:** A contract-only stub node in 8C (`outcome = stubbed`), with a separate, later slice for real outbound actions.
- **B:** Include real outbound webhook actions in 8C, with the controls above.

**Recommendation:** **A.** It keeps 8C free of a new external attack surface, and the stub preserves the builder vocabulary.

**Blocks:** the 8C-1 node catalogue (only to fix the node's status).

**DECIDED (owner, 10-Nov-2026):** placeholders only. No outbound HTTP implementation in 8C.


---

## Not owner decisions (settled in the handover as [P] defaults, changeable at review)

- DAG-only graphs and node/transition limits.
- Re-entry default `once`.
- Workspace-scoped routes.
- Permission keys `journeys.read` / `journeys.manage` (`campaigns.*` precedent, OD-8B-1).
- Event-capture mechanism.
- Retention 30 days.
- Refusal → outcome defaults.
- Runner timings.
- In-flight executions stay on their version.
