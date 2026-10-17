# State

Ticket content lives in the tracker; ownership and progress in campaign.json; the web service writes questions and answers to inbox.json; events go in events.log. Do not duplicate these records. The skill includes the operational rules; projects using it need no private decision record.

## Directory layout

Store Campaigns in the project's configured storage directory outside the repository. Use short ASCII directory names.

```text
<storage-directory>/<campaign>/
  campaign.json          written only by the orchestrator
  events.log             appended by the orchestrator
  inbox.json             written only by the web service, at the Campaign root
  inbox/uploads/<qid>/   images uploaded by the owner; messages in the messages subdirectory
  drafts/                JSON question drafts from execution tickets
  media/<ticket>/<batch>/ review media only; save revisions separately, never overwrite
  deliveries/<ticket>/   delivery.md, reproduction scripts, test logs, etc.; retain in the archive
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
  "orchestrator": "This orchestrator's threadId",
  "inboxUrl": "Machine's web entry point",
  "webhookTask": "Webhook task ID, never its URL",
  "patrolTask": "Patrol task ID",
  "source": "Ticket list or map link",
  "updatedAt": "2026-10-16T08:00:00Z",
  "tasks": [{"taskId":"Child task ID","purpose":"Long-running work description","processed":false}],
  "tickets": [{
    "ticket":"#42", "title":"Title", "kind":"交付", "stage":"执行中",
    "since":"2026-10-16T08:00:00Z", "url":"Ticket URL", "blockedBy":[],
    "thread":"Execution threadId", "branch":"feat/42", "worktree":"Actual path",
    "model":"Actual harness, model and effort", "commit":"Delivered commit SHA", "acceptance":"Acceptance question ID, empty before submission"
  }]
}
```

Use a short ASCII id. The id returned by register is the campaignId used in commands. The persisted kind values are `交付` (delivery) and `讨论` (discussion). The persisted stage values are `未开始` (not started), `执行中` (in progress), `返修` (revision), `已交付` (delivered), `卡住：原因` (blocked: reason), `等你决定 <题号>` (awaiting owner decision, followed by the question ID), `等你来讨论` (awaiting owner discussion), `已合并` (merged), `已关闭` (closed), and `移出范围` (out of scope). These Chinese strings are legacy protocol values; retain them in stored data. A delivered ticket with a nonempty `acceptance` field is awaiting owner acceptance; keep stage `已交付` until the result, then merge or mark revision. Update since with every change. Mark a ticket as awaiting a decision only when the entire ticket is blocked; otherwise keep it in progress.

tasks records long-running work delegated by the orchestrator. Mark a result processed after handling it; patrol checks only unprocessed tasks. Immediately after dispatch, add ticket IDs to awaitingReports (remove after handling delivery) and record the initiator that must receive the final report. New messages do not replace this closing obligation. Store scheduled task IDs only; never put webhook URLs in this file.

Done when: each original ticket can be traced to its execution thread, commit and delivery files; pending reports, child tasks and closing obligations can be recovered.

## Events and media

Append one event per line to events.log: time, ticket, event and a short evidence path. Do not include secrets or long logs.

After approval or a revision request, retain both media and inbox/uploads until the Campaign is archived. Store revision media in a new batch rather than overwriting it. Once the owner confirms closure, unregister the Campaign and delete its scheduled tasks. Copy campaign.json, events.log, inbox.json and inbox/uploads into `<campaign>/archive/`, preserving their relative paths; retain the originals and deliveries/ at the Campaign root. First copy accepted media and any referenced delivery evidence from media/ into deliveries/<ticket>/ and update evidence references there. Then verify this Campaign's absolute path and delete media/. Do not delete uploads when an individual ticket is approved or media is cleaned up. Obtain separate authorization to delete archived uploads later.

Done when: archived questions, answers and uploaded images remain available; media is deleted only at closure, within the verified path.

## Taking over

1. Read campaign.json, the end of events.log, unresolved questions in the root inbox.json, and tasks.
2. Set orchestrator to this thread. Delete the old webhook and patrol tasks; create replacements bound to this thread as described in INBOX.md. Pass set-webhook privately and record the new task IDs. Recreate tasks after a model change too; changing only the prompt leaves the old model attached.
3. Notify execution tickets of the new orchestrator threadId using steer (auto if idle); for a running Cursor execution thread use queue. Resource pools and the Campaign ID stay the same.
4. Record the takeover and handle pending answers, reports and child task results as described in PATROL.md.

Done when: both scheduled tasks are bound to the new orchestrator, execution tickets know their reporting target, pending work is handled, and old tasks no longer wake the previous orchestrator.
