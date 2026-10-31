# D2: QA platform-administrator access register procedure

Owner decision: 31-Oct-2026. This document holds no secrets, passwords, keys or personal data. The register itself lives only in the company-controlled password vault.

## 1. Decided values

| Item | Value |
|---|---|
| Accountable owner | The **Super Admin** role (the company role account named in the owner decision of 31-Oct-2026). Its identity is recorded in the vault entry, not in Git |
| Register location | Company-controlled password vault, entry "ACC QA – platform administrator access register" |
| Scope | The QA bootstrap platform administrator and any further platform-administrator accounts on the QA host |

**Still required (owner):** the vault entry must name one **accountable human custodian** behind the role account. A role mailbox is not a person. Until a human is named there, D2 is not complete.

## 2. Register entry (vault fields)

One vault record per platform-administrator account:

- account identifier (login), environment (QA), creation date;
- accountable human custodian and their deputy;
- credential location (the vault item itself; never a file, chat, ticket or Git);
- date of last rotation and next due date;
- every issuance, rotation, revocation and emergency-access event (date, who, reason).

## 3. Issuance

1. The custodian generates the password in the vault (minimum 20 random characters).
2. The bootstrap account is created or its password set by the custodian at the console or from the operator session. The value is entered from the vault, never typed into a shell history, script, `.env` committed to Git, or chat.
3. The custodian records the issuance event in the vault entry.
4. Automation (including AI agents) never receives platform-administrator credentials. Platform-admin steps are performed interactively by the custodian or owner.

## 4. Rotation

- Every 90 days, and immediately after: a suspected exposure, a change of custodian, or any use of emergency access.
- The custodian changes the password in the console, updates the vault item, confirms a fresh login, and records the event.

## 5. Revocation

- When an administrator no longer needs access: disable the account in the console (platform-admin step), confirm the login is refused, revoke its sessions, and record the event.
- The bootstrap account is never deleted while it is the only platform administrator; it is rotated instead.

## 6. Emergency access

- Use only when the custodian and deputy are unreachable and QA work is blocked by an operational incident.
- The vault "break-glass" access is approved by the accountable owner, logged by the vault, and followed within one working day by a rotation (§4) and a register entry stating the reason.

## 7. Review

The accountable owner reviews the register at each QA gate and at least quarterly; the review date is recorded in the vault entry.

## 8. Exact vault entry to create (owner)

Create one item in the company-controlled password vault. Every field below is required; nothing from it is copied into Git, chat or tickets.

| Field | Value to enter |
|---|---|
| Title | `ACC QA – platform administrator access register` |
| Environment | QA host `172.16.16.72`, release under test `2026.10.24-441a29a` |
| Accountable owner | The company Super Admin role account designated by the owner on 31-Oct-2026 (its address is entered in the vault, not written in this public repository) / Super Admin |
| **Accountable human custodian** | Identified by the owner on 31-Oct-2026 (primary custodian named in the vault entry only, never in Git) |
| Deputy custodian | Name of a second individual (recommended, for emergency access §6) |
| Account 1 | The bootstrap platform administrator: its login identifier, role `alendei_super_admin` at platform scope, creation date (from the console Users page) |
| Credential | Stored as the secret of this vault item only |
| Issuance record | Date and actor of the bootstrap creation and of the current password |
| Rotation | Last rotation date; next due date (90 days) |
| Revocation / retirement | Empty until §9 is executed |
| Emergency access | Break-glass approver = accountable owner; vault access log enabled |
| Review | Date of this entry; next review at the next QA gate |

Confirmation to Claude Code: "D2 vault entry created DD-MMM-YYYY; custodian named". Send no vault content.

## 9. Bootstrap credential retirement (owner-operated; optional for Gate F.3 unless the owner requires it)

The aim is to replace the shared bootstrap account with a named individual administrator, then disable the bootstrap account.

**Constraint (from code, `apps/api/src/cli/user-activation.ts` and `bootstrap.ts`):**
- `activate-user` gives a first password only to **tenant** users, never to a user holding a platform grant.
- `bootstrap` does nothing once a platform administrator exists.

The route below follows from those rules but is **inferred from code and not yet tested on QA**:

1. The bootstrap administrator creates the individual's user in an organization with a tenant role.
2. The operator activates the user with `activate-user`. The password arrives on stdin and is stored only in the vault.
3. The individual signs in once, to verify the credential.
4. The bootstrap administrator grants `alendei_super_admin` at platform scope to the individual (Role assignments).
5. The individual signs in and confirms platform-admin screens work (for example Organizations).
6. The individual removes the tenant role from step 1 if it is no longer needed.
7. The individual disables the bootstrap account (Users, Disable). The server refuses this with `AUTHZ_LAST_PLATFORM_ADMIN` if no other active platform administrator exists, which is the safety check.
8. Revoke all of the bootstrap account's sessions.

**Verification, all of which must hold:**
- the bootstrap login is refused;
- the individual's platform-admin login works;
- the audit log shows the grant, the disable and the session revocation, with the individual as actor;
- the vault item records the retirement date, and the bootstrap secret is marked retired, not reused;
- no bootstrap password reference remains in the QA host environment file. The owner checks this; the agent does not read secrets.

Rollback: the individual administrator reactivates the bootstrap account (`POST /users/:id/reactivate`).
