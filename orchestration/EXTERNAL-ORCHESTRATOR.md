# External orchestrator mode

A Campaign may run its orchestrator loop inside a **T3 thread** (default) or an **external agent** (Grok Bot / T3 Tots / other) that drives the same skill steps through CLI and signed reports. Design: `docs/design/external-orchestrator.md`. Decision drafts: 48–50.

## Choose the kind

In `campaign.json` (STATE.md):

| Field | `t3-thread` | `external` |
| --- | --- | --- |
| `orchestratorKind` | `"t3-thread"` or omitted | `"external"` |
| `orchestrator` | T3 threadId | `null` / omit |
| `orchestratorRef` | omit | short public label |
| `reportEndpoint` | omit | `label:<orchestratorRef>` |

Secrets and URLs live only in `~/.agents/orchestration/private/orchestrators/<label>.json` (0600). Never put them in campaign.json, events.log, launch messages, or delivery notes.

## Same rules both modes

- DISPATCH.md dispatch, quota, review ownership, merge, cleanup.
- INBOX.md `pending → ack → forward → close` (and acceptance handling).
- PATROL.md checks; HOUSEKEEPING.md if enabled.
- Routing via `inbox.mjs route` / `routes` (decision 44).
- Execution and housekeeping **do not** dispatch outward.

## Launch thread title

`t3_thread_launch` **title** must be **`id：short title`** from `campaign.json` `tickets[].title` (full-width colon). Take `threadTitle` from `node inbox.mjs route <campaignId> <type> --ticket <id>` or:

```text
node <skill-dir>/scripts/dispatch-template.mjs title --campaign-dir <absolute-campaign-dir> --ticket <id>
```

Missing/blank title is refused. Do not use free-form titles such as `<campaignId> <id>`. Already-running misnamed threads: `t3_thread_update` with `action=rename` to the same `id：short title` string.

## Reporting

Execution / housekeeping milestones still use three-to-five-line reports with evidence on disk. Ticketed reports name the work as **`id：short title`** (full-width colon) and include both `ticket` and non-empty `title` in the JSON body (`report.mjs` refuses ticket without title). Bare ids are not enough.

**Every launch message must include a Waiting and reporting (等待与回报) step** that names schema `orch-report/1` and phases `startup`, `blocker`, and `delivery`, and shows the `report.mjs` send command. **External Campaigns must also follow the required template below** (adds `progress`, verify steps, and transport paths). Validate before dispatch:

```text
# any mode (base markers)
node <skill-dir>/scripts/dispatch-template.mjs check-message --file <launch.txt>
# external mode (base + external template markers); or pass --campaign-dir to auto-detect kind
node <skill-dir>/scripts/dispatch-template.mjs check-message --file <launch.txt> --orchestrator-kind external
node <skill-dir>/scripts/dispatch-template.mjs check-message --file <launch.txt> --campaign-dir <absolute-campaign-dir>
```

(The checker errors when any required marker is missing.) Authoritative wording for the shared Waiting and reporting section is DISPATCH.md (§7 delivery / §6 discussion). **Authoritative wording for external-mode worker reporting is this file's template below**—DISPATCH.md links here and does not keep a second copy. `dispatch-template.mjs section` / `external-section` are filled helpers that pass the same gates—not a second SSOT.

### External mode report template (required)

When `campaign.json` has `orchestratorKind: "external"`, every launch / continuation message that tells a worker how to report **must** include this template (or equivalent text covering every bullet). Workers never use `t3_thread_send` for orchestrator reports in this mode.

#### Phases (four)

| `phase` | When to write + send |
| --- | --- |
| `startup` | After verifying branch, worktree, and HEAD/base |
| `progress` | Optional mid-work milestone the orchestrator asked for, or a long-running checkpoint with on-disk evidence path (not every edit) |
| `blocker` / question | Whole ticket blocked, or a decision the worker cannot make (also acceptable JSON `phase`: `decision`) |
| `delivery` | Validated delivery: local candidate commit, tests, two-axis 0/0, `delivery.md` on disk |

Do not skip `delivery` after a local candidate commit. Intermediate review/test noise stays on ticket/delivery files, not reports.

#### `orch-report/1` file

Write under `<campaign-dir>/deliveries/<id>/reports/<stamp>-<phase>.json`:

```json
{
  "schema": "orch-report/1",
  "campaign": "<campaignId>",
  "ticket": "<id>",
  "title": "<short title>",
  "phase": "startup|progress|blocker|decision|delivery",
  "threadId": "<execution threadId>",
  "summary": "<3-5 lines naming id：short title; evidence paths only>"
}
```

Optional public fields (still no secrets): `evidence` (string paths under the Campaign dir). Human-facing lines and `t3_thread_launch.title` use the same **`id：short title`** string as `title` + ticket id.

#### Send (worker)

```text
node <skill-dir>/scripts/report.mjs --campaign-dir <absolute-campaign-dir> --file <report.json>
```

Queue-only HTTP POST. Headers: `X-Orch-Signature` (HMAC-SHA256 over `timestamp.requestId.body`), `X-Orch-Timestamp`, `X-Orch-Id`, `X-Orch-Queue: 1`. No interrupt channel. The CLI never prints URLs, secrets, or signatures.

#### Loopback forwarder and webhook paths (mechanism only)

Secrets and concrete URLs live only under `~/.agents/orchestration/private/` (and the external agent’s own private dir). **Never** put them in campaign.json, launch text, logs, or delivery notes. Document only labels and path shapes:

| Role | Public record | Private path / mechanism |
| --- | --- | --- |
| Report endpoint label | `campaign.json` `orchestratorRef` + `reportEndpoint: "label:<ref>"` | `~/.agents/orchestration/private/orchestrators/<ref>.json` (`type: "webhook"`, `queueOnly: true`, `url` + `signingSecret`) |
| Worker → orchestrator HTTP | — | That private `url` is typically a **loopback** receiver path shaped like `/report/<campaignId>` on 127.0.0.1 (external forwarder process). |
| Inbox → orchestrator wakeup | `campaign.json` `webhookTask` (label / external task id only) | `~/.agents/orchestration/private/webhooks/<campaignId>.url` → usually the same forwarder’s loopback path shaped like `/inbox/<campaignId>` |
| Forwarder | external agent install (e.g. machine-local `t3tots-forward`) | Binds loopback only; on `POST /report/<campaignId>` runs the skill verify logic, then forwards a public payload to the external agent; on `POST /inbox/<campaignId>` forwards Inbox webhook JSON. Never logs secrets, URLs, or signatures. |

#### What the orchestrator checks after a report

1. **Signature wakeup:** on the same machine as the private files,
   ```text
   node <skill-dir>/scripts/report.mjs verify \
     --campaign-dir <absolute-campaign-dir> \
     --body-file <raw-body.txt> \
     --headers-file <headers.json>
   ```
   Stdout is only `{"ok":true}` or `{"ok":false,"reason":"…"}` (exit 0 / nonzero). Reasons are public codes—never secrets, URLs, or signature material.
2. **Passing verify is a wakeup only.** Before advancing the Campaign, re-check on-disk evidence the same way a T3 orchestrator would after a queued report:
   - candidate **SHA** matches `delivery.md` / branch HEAD;
   - **clean working tree** in the bound worktree;
   - **tests** recorded with commands and exit codes;
   - **Standards/Spec review** at **0/0** with artifacts listed;
   - every file in the delivery inventory exists.
3. Before merge, tier the candidate with `scripts/merge-risk.mjs` (DISPATCH.md § Merge and clean up, decision 53): HK zero-context recheck only for risk-trigger paths or a moved base; otherwise the scripted precheck only.
4. Mismatches return to the execution thread; do not invent a second review axis or re-run the worker’s full suite in the orchestrator turn (DISPATCH.md light check).

Copy-paste worker block (fill paths/ids; keep the phase and verify words so `check-message --orchestrator-kind external` passes):

```text
Waiting and reporting (等待与回报) — external orchestrator:
- Name this ticket id：short title everywhere.
- Write orch-report/1 under <campaign-dir>/deliveries/<id>/reports/ with fields schema, campaign, ticket, title, phase, threadId, summary.
- Phases: startup, progress, blocker (or decision/question), delivery.
- Send: node <skill-dir>/scripts/report.mjs --campaign-dir <absolute-campaign-dir> --file <report.json>
- Transport: report.mjs posts to label:<orchestratorRef> (private orchestrators/<ref>.json → loopback /report/<campaignId>); Inbox wakeup uses private webhooks/<campaignId>.url → loopback /inbox/<campaignId>. No URLs or secrets in this message.
- Orchestrator receive path: report.mjs verify, then SHA, clean tree, tests, and Standards/Spec 0/0 before accept. Do not t3_thread_send reports.
```

### Mode-specific transport

- **t3-thread:** `t3_thread_send mode=queue` to `orchestrator` (never auto for reports). Still keep the orch-report file + `report.mjs` instructions in the launch template when the Campaign may switch modes; external mode uses only the HTTP path above.
- **external (send / verify):** use the required template in this section. `report.mjs` send and `report.mjs verify` as documented there.

## Messaging workers and housekeeping

External orchestrators (and bot-side `~/.agents/t3-tots/t3mcp.mjs call t3_thread_send <json>`) follow the same delivery rules as in-T3 orchestrators (owner 2026-10-28, SKILL.md; decision 46 amendment):

- **Running worker/execution thread:** `mode=steer` only — never `mode=queue`. Queued composer messages wait until the run ends.
- **Idle or terminal worker:** `mode=auto` to start/continue a turn. If steer returns thread_not_sendable, retry `auto`.
- **T3 mode names:** `auto` | `queue` | `steer` | `restart`. On a running thread, `auto` steers but may fall back to queue — do not rely on `auto` for running workers.
- **Housekeeping:** new separate matter → `queue` (`auto` if idle) only with `newMatter` / `--hk-new-matter`; current-task instruction → `steer` while running, `auto` if idle. Queue is HK-only and only for new matters.
- Resolve modes with [scripts/worker-send.mjs](scripts/worker-send.mjs); after worker or HK current-task send, verify the payload is in the active run, not the queue; after HK new-matter send, verify queue/`auto` acceptance.
- Do not edit `t3mcp.mjs`; pass the resolved `mode` in the tool JSON.
- Reports-to-orchestrator remain queue-only (report path above).
- T3/Codex restarts that would kill the HK thread stay with this orchestrator after owner approval (log `events.log`); do not send them as HK `ops`.

## Wakeups

- **t3-thread:** Inbox webhook `schedule_task` + 60-minute patrol as in SKILL.md Start.
- **external:** external scheduler or bot calls the same `inbox.mjs` commands and follows PATROL.md / INBOX.md. Point `set-webhook` at the external HTTPS receiver (private stdin). Record a label or external task id in `webhookTask`, never the URL.

## Setup notes

SETUP.md may ask whether this Campaign uses a T3 orchestrator thread or an external agent. If external, create the private orchestrator file in a local unrecorded terminal (same class of operation as `set-webhook`), set `orchestratorKind` / `orchestratorRef` on campaign.json, and skip T3 `schedule_task` webhook/patrol binding—or keep patrol as a local cron calling the skill entrypoints.

## Mid-Campaign handoff (sanctioned)

Switching `orchestratorKind` mid-Campaign is **allowed only through** `scripts/handoff.mjs`. Do not hand-edit `orchestrator` / `orchestratorKind` / `orchestratorRef` on a live Campaign and do not treat STATE.md takeover alone as a kind switch.

```text
node <skill-dir>/scripts/handoff.mjs plan  <campaignId> --to external:<label>|t3-thread:<threadId>
node <skill-dir>/scripts/handoff.mjs apply <campaignId> --to …
node <skill-dir>/scripts/handoff.mjs revert <campaignId> [--handoff-id <id>]
```

- **plan** is dry-run for Campaign mutation (no `campaign.json` / webhook change) but appends one `events.log` audit line and prints the plan JSON.
- **Carry pending work:** pass `--carry-over-pending` to both `plan` and `apply` to carry `awaitingReports` and Inbox items in `saved`, `notified`, or `read` state. The plan and handoff record list their IDs and statuses; the Campaign's `awaitingReports` and Inbox data stay unchanged. The operator must send the generated report-to updates and bind the new orchestrator's webhook; the new orchestrator processes the retained items through that Inbox flow. Pending messages, withdrawal requests, and all other safety gates remain blocking. Without the flag the original refusal rules apply.
- **apply** refuses when unsafe (pending/unacked Inbox items, non-empty `awaitingReports`, unprocessed `tasks`, active resource leases, missing private orchestrator file for an external target, or Campaign not registered). **Leases:** pass occupancy with `--leases-file <json>` (array shaped like `lease.mjs status` output) or discover via `--project <docs/agents/orchestration.md>` (calls `lease.mjs` `status`). Without either, lease refusal cannot fire—supply one on live Campaigns that use resource pools. On success it: backs up `campaign.json` under `handoffs/`, atomically updates orchestrator fields, rebinds Inbox webhook for external targets to the local forwarder loopback (`http://127.0.0.1:<port>/inbox/<campaign>` via `set-webhook` stdin; `webhookTask` stores a **label only**), appends `events.log`, writes a revert record + operator instructions for T3 `list_scheduled_tasks` / `delete_scheduled_task` / `schedule_task` and report-to steers. The CLI does **not** call T3 MCP itself.
- **revert** restores the exact prior `campaign.json` from the handoff backup and attempts forwarder webhook rebind when restoring external mode. Restoring `t3-thread` leaves private Inbox webhook URL recreation as operator follow-up (secret cannot be stored in the record).
- Re-running **apply** for the same target is idempotent (converges; no duplicate writes).
- Never log webhook URLs, signing secrets, or private orchestrator file contents. Tests use throwaway Campaign dirs only.

### Forwarder acceptance (t3tots-forward)

The loopback forwarder accepts `POST /inbox/<campaign>` and `POST /report/<campaign>` only when **both** hold:

1. `<campaign>` is listed in public `~/.agents/orchestration/machine.json` `campaigns[]` with a `dir`, and
2. that dir’s `campaign.json` has `orchestratorKind: "external"`.

Otherwise it responds `403` / `campaign-not-allowed` (log: “not an external registered campaign”). Handoff **apply** to external requires registration up front and leaves kind=external so a running forwarder picks the Campaign up on the next request **without** editing or restarting the forwarder. Private report credentials stay in `private/orchestrators/<label>.json`; the forwarder verifies reports through the skill’s `verifyInboundReport`.

## Pending owner confirmation

- Whether any non-queue external control channel will ever exist (default: no). Mid-Campaign kind switching is settled: use `handoff.mjs` only.
