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
