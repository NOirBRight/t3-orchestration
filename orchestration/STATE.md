# State

Ticket content lives in the tracker; ownership and progress in campaign.json; the web service writes questions and answers to inbox.json; events go in events.log. Do not duplicate these records. The skill includes the operational rules; projects using it need no private decision record.

## Directory layout

Store Campaigns in the project's configured storage directory outside the repository. Use short ASCII directory names.

```text
<storage-directory>/<campaign>/
  campaign.json          written only by the orchestrator
  routing.json           optional Campaign overrides for routes and limits; written by Inbox routing settings, not by the orchestrator
  events.log             appended by the orchestrator
  inbox.json             written only by the web service, at the Campaign root
  inbox/uploads/<qid>/   images uploaded by the owner; messages in the messages subdirectory
  drafts/                JSON question drafts from execution tickets
  media/<ticket>/<batch>/ review media only; save revisions separately, never overwrite
  deliveries/<ticket>/   delivery.md, reproduction scripts, test logs, etc.; retain in the archive
  housekeeping/<HK-id>/  housekeeping evidence: report.md, candidates.md, authorized.txt, logs
  handoffs/              orchestrator handoff backups, revert records, and operator instructions (scripts/handoff.mjs); retain with the Campaign
```

Done when: the old inbox/inbox.json layout is no longer used. Programs read public state only and change questions and answers through inbox.mjs.

## campaign.json

```json
{
  "id": "example-campaign",
  "campaign": "Goal for this Campaign",
  "project": "Project display name",
  "projectId": "Target repository's T3 project ID",
  "initiator": "Initiating threadId",
  "awaitingReports": ["#42"],
  "orchestratorKind": "t3-thread",
  "orchestrator": "This orchestrator's threadId (t3-thread mode)",
  "orchestratorRef": null,
  "reportEndpoint": null,
  "inboxUrl": "Machine's web entry point",
  "webhookTask": "Webhook task ID or external label, never its URL",
  "patrolTask": "Patrol task ID or external schedule label",
  "source": "Ticket list or map link",
  "updatedAt": "2026-10-16T08:00:00Z",
  "housekeeping": {
    "enabled": true,
    "threadId": "Housekeeping session threadId",
    "branch": "t3/<campaign>-housekeeping",
    "worktree": "Optional absolute path",
    "brief": "HOUSEKEEPING.md",
    "model": "instanceId/model/options with source layer",
    "countsTowardLimits": false,
    "since": "2026-10-27T00:00:00Z",
    "source": "decision 46",
    "disk": { "checkedAt": null, "free": {}, "pending": null }
  },
  "tasks": [{"taskId":"Child task ID","purpose":"Long-running work description","processed":false}],
  "tickets": [{
    "ticket":"#42", "title":"Short title (required; used as id：title in messages)", "kind":"交付", "stage":"执行中",
    "note":"Optional free-form progress text; not used as stage",
    "since":"2026-10-16T08:00:00Z", "url":"Ticket URL", "blockedBy":[],
    "thread":"Execution threadId", "branch":"feat/42", "worktree":"Actual path",
    "model":"Actual tier: instanceId/model/options as resolved by inbox.mjs route, with its source layer", "commit":"Delivered commit SHA", "acceptance":"Acceptance question ID, empty before submission"
  }]
}
```

Use a short ASCII id. The id returned by register is the campaignId used in commands. The persisted kind values are `交付` (delivery) and `讨论` (discussion).

**`tickets[].title` is required** (non-empty short description). Every report, patrol note, Inbox message, and launch line names the ticket as `id：title` (full-width colon; DISPATCH.md). Write campaign.json through `scripts/campaign-write.mjs`, which refuses blank titles. Existing rows missing `title` must be backfilled before the next write or dispatch (use the ticket file heading or a one-line summary).

**Orchestrator mode** (EXTERNAL-ORCHESTRATOR.md): `orchestratorKind` is `t3-thread` (default when omitted) or `external`. In `t3-thread` mode `orchestrator` is the T3 threadId. In `external` mode set `orchestratorRef` (public label) and optional `reportEndpoint` as `label:<ref>`; never store URLs or tokens here—private files under `~/.agents/orchestration/private/orchestrators/` hold secrets.

**Housekeeping** (HOUSEKEEPING.md): optional object; omit when unused. `countsTowardLimits` must be `false`. Unknown project-specific keys (e.g. legacy `diskDecision`) are left untouched. `awaitingReports` may include `HK-*` request ids alongside ticket numbers. There is **no** separate HK todo file: outstanding work is `HK-*` in `awaitingReports` plus `hk-sent` / `hk-done` lines in events.log (decision 46 amendment 2026-10-28). Prefer [scripts/campaign-write.mjs](scripts/campaign-write.mjs) for checked writes (stage enum, countsTowardLimits, no URL/token fields, backup + atomic write).

**`stage` is a fixed enum only.** Allowed values: `未开始` (not started), `执行中` (in progress), `返修` (revision), `已交付` (delivered), `卡住：原因` (blocked: reason; the text after the full-width colon is the reason), `等你决定 <题号>` (awaiting owner decision, followed by the question ID), `等你来讨论` (awaiting owner discussion), `已合并` (merged), `已关闭` (closed), and `移出范围` (out of scope). Do not put free-form progress narrative into `stage`. Put that narrative in the optional `note` string field on the same ticket object (short prose for humans and patrol), or append detail to `events.log`. These Chinese stage strings are legacy protocol values; retain them in stored data. The Inbox Progress tab (read-only ticket board, `inbox-web/kanban.mjs`) puts `已合并`, `已合入` and `已合主线` in Merged and `已关闭` and `移出范围` in Closed; `卡住`, `等你决定` and `等你来讨论` count as Blocked. Bare `已交付` is Delivered, or To verify while a nonempty `acceptance` awaits its result, or To merge when a merge is requested; `已交付` with a `待合并` or `待核实` note follows the note. Without a known stage, `status` `closed`/`done` maps to Closed and `merged` to Merged. New writes still use the enum above. A delivered ticket with a nonempty `acceptance` field is awaiting owner acceptance; keep stage `已交付` until the result, then merge or mark revision. Update since with every change. Mark a ticket as awaiting a decision only when the entire ticket is blocked; otherwise keep it in progress.

tasks records long-running work delegated by the orchestrator. Mark a result processed after handling it; patrol checks only unprocessed tasks. Immediately after dispatch, add ticket IDs to awaitingReports (remove after handling delivery) and record the initiator that must receive the final report. New messages do not replace this closing obligation. Store scheduled task IDs only; never put webhook URLs in this file.

A Campaign routing override file is optional and holds only the fields this Campaign changes, written through Inbox routing settings. Do not hand-edit it, do not copy the global table into it, and do not repeat the same values in project settings. `inbox.mjs route` and `inbox.mjs routes` are the only read path; campaign.json records just the tier actually dispatched.

Done when: each original ticket can be traced to its execution thread, commit and delivery files; pending reports, child tasks and closing obligations can be recovered.

## Events and media

Append one event per line to events.log: time, ticket or `HK-<n>`, event and a short evidence path. Do not include secrets or long logs.

Housekeeping milestones (HOUSEKEEPING.md): `hk-sent` when a request is dispatched (include `type=`), `hk-done` when the report is handled; optional `hk-continue` / `hk-replace`. Patrol treats `HK-*` in `awaitingReports` without a later `hk-done` as outstanding.

After approval or a revision request, retain both media and inbox/uploads until the Campaign is archived. Store revision media in a new batch rather than overwriting it. Once the owner confirms closure, unregister the Campaign and delete its scheduled tasks. Copy campaign.json, events.log, inbox.json and inbox/uploads into `<campaign>/archive/`, preserving their relative paths; retain the originals and deliveries/ at the Campaign root. First copy accepted media and any referenced delivery evidence from media/ into deliveries/<ticket>/ and update evidence references there. Then verify this Campaign's absolute path and delete media/. Do not delete uploads when an individual ticket is approved or media is cleaned up. Obtain separate authorization to delete archived uploads later.

Done when: archived questions, answers and uploaded images remain available; media is deleted only at closure, within the verified path.

## Taking over

Same-kind recovery (new T3 orchestrator thread, or continuing external with the same ref) follows the steps below. **Changing `orchestratorKind` or switching to a different external label** uses only `scripts/handoff.mjs` (EXTERNAL-ORCHESTRATOR.md); do not hand-edit kind/ref on a live Campaign. Handoff writes under `handoffs/` (backup + record + instructions); keep those files through archive.

1. Read campaign.json, the end of events.log, unresolved questions in the root inbox.json, and tasks.
2. Set orchestrator to this thread. Delete the old webhook and patrol tasks; create replacements bound to this thread as described in INBOX.md. Pass set-webhook privately and record the new task IDs. Recreate tasks after a model change too; changing only the prompt leaves the old model attached.
3. Notify execution tickets of the new orchestrator threadId / report target using `steer` while running and `auto` if idle — never `queue` for workers (owner 2026-10-28; scripts/worker-send.mjs). Verify each notify landed in the active run, not the composer queue. Notify the housekeeping session as a **current-task** correction when it must learn the new report target immediately: `steer` while running, `auto` if idle (HOUSEKEEPING.md; decision 46 amendment). Use new-matter `queue` only if the notify can wait behind an in-flight merge/delete/rollout. For `orchestratorKind: external`, update `orchestratorRef` only via handoff (or owner-approved private config at setup); do not put secrets in campaign.json. Resource pools and the Campaign ID stay the same.
4. Record the takeover and handle pending answers, reports and child task results as described in PATROL.md.

Done when: both scheduled tasks are bound to the new orchestrator, execution tickets know their reporting target, pending work is handled, and old tasks no longer wake the previous orchestrator.
