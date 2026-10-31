# Gate F.3: owner and operator execution sheet

Prepared 31-Oct-2026. Gate F.3 remains **NOT ACCEPTED**. This sheet lists only actions that need the owner, the infrastructure operator or human evaluators. No secrets, passwords, keys or personal data belong in this file or anywhere in Git.

## 1. D1 network access (owner-operated; requires `sudo`)

Facts verified read-only on 31-Oct-2026:
- The QA host is a VMware virtual machine.
- Port 443 is served by host nginx, not by a Docker-published port, so `ufw` rules apply to it.
- Port 80 is not listening.
- Exactly one login account exists and it is the only account in recent logins, so the `AllowUsers` restriction cannot lock out another user.
- The staged script hash matches: `~/f3-d1/d1-ufw.sh` SHA-256 `cdbbce47a536d205717302b42dcaf82f84e47712d6208e881f1065ea13c3a0b9`.

| Step | Action | Pass condition |
|---|---|---|
| 1 | Read the script: `less ~/f3-d1/d1-ufw.sh` | You accept every command it can run |
| 2 | Verify your source IP: `echo $SSH_CLIENT` | First field is in `172.16.16.0/24` |
| 3 | Confirm recovery access: open the VM console in vSphere (out-of-band) **and** open a second SSH session to the host. Leave both open | Console login prompt reachable; second session works |
| 4 | Dry run: `sudo bash ~/f3-d1/d1-ufw.sh --show-only` | Current rules printed; nothing changed |
| 5 | Run: `sudo bash ~/f3-d1/d1-ufw.sh`. Read the printed PLAN (allow 22 and 443 from the range, remove the broad 22/443 rules, default deny incoming if not set, `AllowUsers` for the operator). Type `yes` only if it matches. If it refuses because it cannot read your source address, run `sudo SSH_CLIENT="$SSH_CLIENT" bash ~/f3-d1/d1-ufw.sh` | `DONE` printed; no `WARNING` |
| 6 | From the workstation, without closing the existing sessions, open a **new** SSH session | Login succeeds |
| 7 | From the workstation, open `https://172.16.16.72/` (or tell Claude Code to run the pinned HTTPS check) | Login page loads |
| 8 | Denied-path check: Claude Code repeats the container-network probe to host 22/443 | Both refused |
| 9 | Make the privileged evidence readable: `sudo chown -R $USER: ~/f3-d1/evidence-*` | Claude Code copies `before.txt`, `after.txt` and `actions.txt` into the evidence folder and records their hashes |
| Rollback | `sudo ufw status numbered`, then `sudo ufw delete <n>` for the D1 rules; `sudo rm /etc/ssh/sshd_config.d/60-d1-allowusers.conf && sudo systemctl reload ssh`. If SSH is lost, use the vSphere console | Previous access restored |

A request from outside `172.16.16.0/24` cannot be tested from the workstation, which sits inside the range. The denied path is evidenced by the after-state `ufw` rules plus the container-network probe. A probe from a second network is optional; if the owner wants one, it needs a host outside the range.

## 2. D2 access register (owner)

1. Create the vault entry exactly as in `QA_D2_ACCESS_REGISTER_PROCEDURE.md` §8.
2. Fill the one missing field: the **named human custodian** (and a deputy) behind the Super Admin role account. Claude Code will not invent this person.
3. Bootstrap retirement (§9 of the same document) is optional for Gate F.3 unless the owner requires it. If it is run, it is owner-operated, because it is platform-admin work.
4. Reply with "D2 entry created on DD-MMM-YYYY by <role>". Do not send the vault content.

## 3. D5 encrypted off-host backup (infrastructure operator, then Claude Code)

The owner has selected existing company-controlled storage. The tool is `scripts/qa/d5-backup.sh` (SHA-256 `f3328a78…`). These inputs remain:

| Input | Needed from | Form |
|---|---|---|
| Destination | Infrastructure operator | `user@host:/path` reachable from the QA host over SSH (rsync), or a mounted path. The destination host's SSH fingerprint, supplied out-of-band |
| QA host access to it | Infrastructure operator | Install a dedicated SSH public key from the QA host on the destination, restricted to that path (for example `rrsync`). Claude Code generates the key pair on the QA host on request; only the **public** key leaves the host |
| Encryption key | Key custodian | A GPG **public** key and its full fingerprint, with the fingerprint confirmed out-of-band. The private key never goes to the QA host or Git |
| Private-key custodian | Owner | A named person, recorded in the vault (not Git). They perform the decrypt step of restore verification |
| Retention and schedule | Owner (confirm or change) | Proposed: keep 30 days; weekly, Sunday 20:30 UTC (02:00 IST Monday), plus one before every QA upgrade |

Once the inputs are supplied, the steps below run in order (Claude Code unless noted):
1. Write `~/.config/acc-d5/d5.conf` (mode 600) on the QA host and import the public key.
2. Run `d5-backup.sh backup`. This is one real encrypted off-host backup, and the tool confirms the checksum on the destination.
3. Restore verification, attended by the custodian. The custodian supplies decryption through a forwarded `gpg-agent` session (preferred) or a temporary key directory that is shredded afterwards. Then `d5-backup.sh restore-verify` restores into `acc_d5_verify` and compares row counts.
4. Install the weekly cron entry under the operator account.
5. Only after steps 2 and 3 pass, the owner decides whether to remove the local recovery copy `~/acc-backups/acc-qa-20261031T0640Z-recovery-copy.dump` (`b503d7c2…`).

`restore-verify` restores into a scratch database on the live cluster. A **fresh-cluster** restore (QAF-007/W-4) is a separate drill, with the proposal ready outside Git (`~/acc-evidence/2026-10-28-d5-drill-proposal/`). It needs its own owner authorization and recovery host.

## 4. Pull requests (owner)

Verified facts on 31-Oct-2026:
- `main` and `develop` have **no branch protection or rulesets**.
- The repository has **one collaborator**, the account that authored the PRs. GitHub does not allow an author to approve their own PR.
- The "required approval" is therefore the owner's explicit merge decision after an independent review.

| PR | State | Action needed |
|---|---|---|
| #52 QAF-026 (into `develop`, head `d117d80`) | Draft, mergeable, CI green (5/5) | 1. Independent review (owner or Gemini). 2. Owner approval to mark ready and merge. Claude Code then merges with `--match-head-commit d117d80` and records the `develop` commit. QA verification only after an owner-approved deployment of an identified candidate |
| #51 X-6 watcher dry-run fix (stacked on #50, head `addbca6`) | Draft, no review | 1. Independent review. 2. A branch-target decision. |
| #50 Gate F.3 closeout | Draft | Merge remains an owner decision |

On #51:
- **Branch target.** The earlier refusal came from the **Claude Code session permission policy**, which blocks agent actions on connected services that were not explicitly requested. It is not a GitHub repository control. Two authorized resolutions:
  - (a) Preferred: when #50 is merged and its branch deleted, GitHub retargets #51 to `develop` automatically.
  - (b) The owner explicitly instructs "retarget PR #51 to develop" now. Its diff would then also show the #50 commits.
- **CI.** CI runs only for PRs into `main`/`develop` and does **not** execute the `scripts/qa` shell harness. The meaningful validation is the harness itself (`bash scripts/qa/test-x6-watcher.sh`, 30/30 on 31-Oct-2026), which the reviewer should rerun. Retargeting adds only the generic checks (secret scan, lint/build).

## 5. F.3-8 human evaluation (owner arranges)

See `QA_J_EVALUATOR_PACKAGE.md` §9 for the requirements, schedule prerequisites and sign-off form.
