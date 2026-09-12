# Routing Engine Architecture

Covers the **Channel Router** and **Provider Router** stages of the request flow in `ARCHITECTURE.md` §2, plus the Eligibility Engine that sits between them.

## 1. Channel Router

Determines the ordered set of candidate channels for a message before any provider is considered. Inputs: the message's requested channel (if the caller specified one explicitly, e.g. a transactional OTP that must be SMS — see §1a for the hard-constraint semantics this implies by default), the contact's known `contact_identities`/channel capability, the org's configured channel preference chain (e.g. WhatsApp → RCS → SMS), and campaign/journey-level overrides. Output: an ordered channel list handed to the Eligibility Engine.

Channel order chains supported out of the box (fully configurable per org/campaign, not hard-coded):

- `WhatsApp → RCS → SMS`
- `SMS → RCS → WhatsApp`
- `RCS → WhatsApp → SMS`
- Single-channel (no fallback across channels, only across providers within the channel)

## 1a. `requested_channel_id` semantics — hard constraint by default

If a message's `requested_channel_id` is non-null (`DATABASE.md` §6, `ARCHITECTURE.md` §5), it is a **hard channel constraint by default**: the Channel Router produces a single-channel candidate list, and no other channel may ever be substituted for this message — not at initial send, and not at any fallback escalation. Cross-channel fallback is permitted **only when explicitly enabled** for that message, via `messages.cross_channel_fallback_enabled` (`ARCHITECTURE.md` §5) — set by the caller at send time, or defaulted from a campaign/journey/org-level policy setting that resolves the same way other message-level configuration does. There is no implicit or silent channel switching.

Examples:

- **OTP** — `requested_channel_id = SMS`, `cross_channel_fallback_enabled = false` (the correct default for OTP): SMS providers only, for the life of the message. The message never silently moves to WhatsApp or RCS.
- **Marketing** — `requested_channel_id = WhatsApp`, `cross_channel_fallback_enabled = true`: `WhatsApp → RCS → SMS` per the configured `fallback_steps` is permitted.

**If a hard-pinned channel has no eligible provider** — at initial send, or at any fallback re-evaluation step (`ARCHITECTURE.md` §3b, `FALLBACK_ENGINE.md` §2) — the message fails according to the org's configured failure policy. ACC does **not** silently change the channel to route around the constraint; this holds even though the same re-evaluation machinery that substitutes providers within a channel is otherwise fully dynamic (§4, `FALLBACK_ENGINE.md` §2).

**Within-channel provider fallback is unaffected by the constraint**: a hard channel pin restricts *channel* substitution only. Provider substitution within the pinned channel (e.g. WhatsApp Provider A → WhatsApp Provider B) remains fully governed by ordinary eligibility/routing re-evaluation, since it never changes the channel.

If `requested_channel_id IS NULL`, there is no constraint to speak of: the Channel Router is free to choose the initial channel, and `cross_channel_fallback_enabled` is ignored (channel selection was never pinned in the first place). This section is the single normative definition of this behavior; `API.md`, `FALLBACK_ENGINE.md` §2, and `PRD.md` §7 reference it rather than redefine it.

## 2. Eligibility Engine

For each candidate channel (in order), filters the provider set down to those that are actually usable for *this* message:

1. Consent check (`consents`) — is the contact opted in for this channel/message type.
2. Suppression check (`suppressions`) — not on a DND/opt-out/bounce/DLT-block list.
3. Regulatory check — e.g. India DLT template registration for SMS (flagged for verification against current TRAI/DLT rules — see `SECURITY.md` compliance note).
4. Provider capability check (`provider_capabilities`) — e.g. media support, template approval status.
5. Provider operational eligibility — health state not `OFFLINE`/`DRAINING`, circuit breaker not `OPEN` (per `PROVIDER_ADAPTER.md` §§5–6).
6. Quota/rate check — org-level and provider-level sending quotas not exhausted.

A channel with zero eligible providers is skipped entirely (Channel Router's next candidate is tried) rather than surfaced as a per-provider failure — this distinction matters for correct fallback semantics (§4 of `FALLBACK_ENGINE.md`).

## 3. Provider Router

Given a channel's eligible provider set (possibly one, usually several), selects the provider for *this* attempt per the org's currently activated `routing_policy_versions` config. Supported strategies (composable into a `hybrid` policy via weighted sub-scores):

| Strategy | Selection basis |
|---|---|
| `priority` | Static ordered list; first eligible provider wins |
| `weighted` | Configured weight distribution (e.g. 70/30 split) via weighted random selection |
| `cost` | Lowest `estimateCost()` among eligible providers |
| `quality` | Highest recent delivery-success rate (from `provider_health` rollups) |
| `latency` | Lowest recent average latency |
| `geo` | Provider best matched to recipient's country/region routing table |
| `customer` | Per-organization override (a specific customer always/never uses a specific provider — e.g. contractual requirement) |
| `campaign` | Per-campaign override (independent of the org default) |
| `channel` | Per-channel default when no more specific policy applies |
| `hybrid` | Weighted combination of the above sub-scores, configured per org |

## 4. Routing policy precedence (the single deterministic answer to "which policy wins")

`routing_policies` (`DATABASE.md` §4) carries `scope_type` + `scope_id`, one row per scope instance. **Exactly one precedence hierarchy applies platform-wide, matching the tenancy hierarchy (`TENANCY.md` §1) plus the message-origination dimensions that sit below it**:

```
1. Platform default        (scope_type=platform, scope_id=NULL)
2. Reseller                (scope_type=reseller, scope_id=reseller_id)
3. Organization             (scope_type=organization, scope_id=org_id)
4. Workspace                (scope_type=workspace, scope_id=workspace_id)
5. Channel                  (scope_type=channel, scope_id=channel_id — a per-channel default within the resolved org/workspace)
6. Campaign / Journey       (scope_type=campaign|journey, scope_id=campaign_id|journey_id)
7. Message-level override   (scope_type=message, scope_id=message_id — set by an explicit caller override on a single API call)
```

Team and User are deliberately **not** precedence levels — routing policy is never resolved per-user, only per the tenancy/origination dimensions above.

**Resolution rule**: for a given message, walk the hierarchy from most specific (7) to least specific (1) and take the **first scope that has an `active` policy defined** — this is whole-policy selection, not a field-by-field merge across scopes. A `hybrid` strategy policy still merges *sub-scores* internally (§3), but the platform never combines, say, an organization's priority list with a workspace's weight table; exactly one `routing_policies` row (and its currently activated `routing_policy_versions` row) governs a given message, full stop. This is what makes "if five policies apply to the same message, which one wins" have exactly one answer: the most specific one that is `active`.

**Disabled/inactive policy behavior**: a policy with `status='inactive'` at a given scope is treated as **absent**, not as "route nowhere" — resolution falls through to the next less-specific scope exactly as if no policy had ever been configured at that level. The platform-level default (scope_type=`platform`) is required to always have exactly one active policy, guaranteeing resolution never fails to find a policy.

The resolved policy's id is recorded on `messages.routing_policy_id` at send time (`ARCHITECTURE.md` §5) — and **re-resolved fresh at every fallback escalation** (§6, `ARCHITECTURE.md` §3b), since the effective policy for the same logical message can legitimately change between the initial attempt and a fallback attempt minutes later (e.g. an admin activates a new organization-level policy version mid-chain).

## 5. Policy versioning & hot changes

`routing_policies` + `routing_policy_versions` (see `DATABASE.md` §4): every edit to weights/priorities/thresholds creates a new version; exactly one version per policy is `activated_at`-current (with `deactivated_at IS NULL`). The Provider Router always reads the active version via a cached lookup invalidated on activation — so a policy edit takes effect on the next evaluation, with **no application deploy or restart**, and can be rolled back by re-activating a prior version (full audit trail of who changed what, when, preserved indefinitely since versions are never deleted). `effective_at` supports scheduling a future activation; "currently effective" is still always the single row with `activated_at` set and `deactivated_at` null — never a runtime timestamp comparison scattered across call sites.

## 6. Canary migration

Migrating traffic from Provider A to Provider B for a channel is expressed as a `weighted` (or `hybrid`) policy version transition: version N sends 100/0, version N+1 sends 95/5, ramping via successive versions while health/quality metrics are monitored per step. Because each ramp step is its own version, rollback to any prior ramp percentage is a single activation call, not a redeploy or a manual traffic-shaping hack.

## 7. Interaction with the Fallback Engine

The Provider Router only decides the provider tried for a given attempt — the *first* attempt on the initial send, and a fresh decision on every fallback escalation (`ARCHITECTURE.md` §3b). If an attempt fails to reach a terminal success state within its window, control passes to the Fallback Engine (`FALLBACK_ENGINE.md`), which re-invokes Eligibility → Channel Router → Provider Router for the next configured step rather than reusing the original decision — the two engines are deliberately decoupled so routing policy and fallback policy can be edited independently, and so a routing policy change mid-chain takes effect on the very next escalation without any special-casing.

## 8. Related

Provider eligibility signals: `PROVIDER_ADAPTER.md` §§5–6. Fallback chain mechanics: `FALLBACK_ENGINE.md`. Admin operations for all of the above: `PROVIDER_ADAPTER.md` §4.
