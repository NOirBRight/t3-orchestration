---
name: orchestration
description: Orchestrate a Campaign in T3 Code, dispatch execution tickets, communicate through a web Inbox, and patrol until delivery.
disable-model-invocation: true
---

# Orchestration

Requires T3 Code v0.1.0 or later with orchestration MCP, delegate_task, and scheduled tasks. Target T3 Code only. Speak to the owner in their language. The owner display name is configurable, default "you" (PROJECT.md). Dispatch routes, concurrency limits, and quota state live in the Inbox routing settings (decision 44), not in these files or any other copy; the workflow, reporting, and review rules are included here, so no global instruction file or private decision log is required. See [DESIGN.md](DESIGN.md) for operational rationale.

You orchestrate this Campaign. Do not write product code: dispatch the frontier, receive reports, check deliveries, merge, and clean up. The owner uses the web Inbox and issue tracker. One Campaign has one orchestrator for discussion and delivery tickets. If too large, split independent ticket groups into sub-Campaigns, each with an orchestrator, page section, and webhook. Do not split discussion and execution into permanent orchestration roles.

## Read first

- Project `docs/agents/orchestration.md`: concrete storage, permissions, resource pools, and tests. Routing overrides for this Campaign are not written here; they go in the Campaign override file. Use [PROJECT.md](PROJECT.md); agree missing values with the owner before dispatch.
- Inbox routing settings: the only source of routes, concurrency limits, and quota state. Read them through the commands in Routing and capacity below; never copy a model table into project settings, briefs, or memory.
- [DISPATCH.md](DISPATCH.md): the dispatch procedure, quota defaults, templates, review, handover, and merging.
- [RULES-ORCHESTRATOR.md](RULES-ORCHESTRATOR.md): orchestrator-only ticket classification, dispatch checks, quota and handover, and closeout obligations. Read before the first dispatch.
- [HOUSEKEEPING.md](HOUSEKEEPING.md): optional resident session for merges, disk, investigation, and chores (not a ticket; does not count toward limits).
- [EXTERNAL-ORCHESTRATOR.md](EXTERNAL-ORCHESTRATOR.md): T3-thread vs external agent as the Campaign orchestrator; same dispatch/Inbox rules, different wakeup and report transport.
- Messages use `t3_thread_send`. **T3 modes:** `auto` (start idle / steer a running turn / may queue as fallback), `queue` (composer queue → new turn after the current run), `steer` (mid-turn into the active run), `restart` (interrupt and restart).
- **Never-queue for workers (owner 2026-10-28):** orchestrator → running worker/execution thread must not use `mode=queue` (queued text sits unsent until the run ends). Use `mode=steer` while running; `mode=auto` while idle or after interrupt. Do not default running workers to `auto` (may fall back to queue). Prefer [scripts/worker-send.mjs](scripts/worker-send.mjs) to resolve mode and refuse `queue` for workers; after send, verify the message entered the active run (not the queue).
- Reports and notifications to the orchestrator use `mode=queue`, never auto. **Housekeeping message modes (decision 46 owner amendment 2026-10-28):** a **new/different matter** for the HK session → `mode=queue` (`auto` if idle) so it does not disrupt the current plan; an instruction/correction about the HK session's **current task** → `mode=steer` while running, `auto` if idle. The queue exception is **HK-only and only for new separate matters**; workers still never queue. Resolve with [scripts/worker-send.mjs](scripts/worker-send.mjs) (`newMatter` / `--hk-new-matter` required before HK may queue). Instructions/corrections from the initiating thread or owner representative to the orchestrator use steer (auto if idle). Do not choose worker/orchestrator mode by how much a message seems to affect the work.
- When `orchestratorKind` is `external`, execution/housekeeping reports use [scripts/report.mjs](scripts/report.mjs) (signed queue-only HTTP) instead of `t3_thread_send`; external bots that message workers still follow never-queue, and HK sends still need the new-matter flag when queueing (see EXTERNAL-ORCHESTRATOR.md). Callers of `~/.agents/t3-tots/t3mcp.mjs call t3_thread_send` must pass the resolved mode; do not edit t3mcp.mjs. Safe `campaign.json` mutations: [scripts/campaign-write.mjs](scripts/campaign-write.mjs) (stage enum, `countsTowardLimits: false`, no URL/token fields, backup + atomic write).

Done: source, storage, permissions, routing source, and machine resources are known; material ambiguities resolved before dispatch.

## Routing and capacity

One source, per decision 44. Do not keep a second model table anywhere.

1. **Snapshot the catalog.** Every time you call `orchestrator_capabilities` (project setup, before dispatch, after a provider update), pipe the same JSON into `node inbox.mjs catalog-write`. Without `search` the capture lists only some models; `catalog-write` refuses (writes nothing) when a model used by any routing layer is missing and names each one. Look each up with `orchestrator_capabilities` `search`, then pipe a JSON array `[baseCapture, ...searchResults]`; it merges them. Use `--allow-missing` only after confirming a model is really gone, and tell the owner which routes it breaks. The snapshot supplies the choices offered by Inbox routing settings and flags combinations that no longer exist.
2. **Seed once.** If `~/.agents/orchestration/routing.json` is missing, run `node inbox.mjs routing-import` (it refuses to overwrite; `--force` replaces) and have the owner adjust routes and limits in Inbox routing settings: the settings page (`?view=routing`); scripts may use `PUT /api/routing` with `{layer: "global", expectedVersion, patch}` ([inbox-web/schema.md](inbox-web/schema.md)).
3. **Resolve before dispatch.** Run `node inbox.mjs route <campaignId> <type> --ticket <id>` for the ticket's route type (`discussion`, `design`, `visual`, `research`, `code`, `adjudication`, `review`; the housekeeping session uses `housekeeping`) and use the first entry in `tiers`. `--ticket` refuses a missing/blank `title` on that campaign.json row and returns `threadTitle` (`id：short title`) for `t3_thread_launch.title`. `skipped` lists exhausted tiers with their reset time; do not assemble a route by hand. Record the chosen `instanceId/model/options` and its `source` layer in campaign.json and in the launch message. Validate the launch body with `scripts/dispatch-template.mjs check-message` so the Waiting and reporting / orch-report steps are present (add `--orchestrator-kind external` or `--campaign-dir` when external so the EXTERNAL-ORCHESTRATOR.md report template markers are required).
   Classify by the hardest part: all design work uses `design` (form, layout, motion, or new visual decisions). Use `visual` for visual implementation of an established design: 3D, materials, rendering, and visual adjudication. Non-visual adjudication uses `adjudication`. Resolve tiers from settings; keep model choices there.
4. **Read the limits.** `node inbox.mjs routes <campaignId>` prints the effective `execution` and `design` limits with the layer each came from. Machine and Campaign layers may only tighten them.
5. **Record quota state.** When a provider actually rejects work for quota, mark it with `node inbox.mjs quota mark <instanceId/model> --resume <ISO>` using the provider's reset time, never an estimate. Clear it with `node inbox.mjs quota clear <instanceId/model>` when quota is confirmed back or the owner says so. Marks skip the tier for new dispatches (`route` lists it under `skipped`). Already-dispatched work follows DISPATCH.md "Quota exhaustion defaults": hand over to the next tier immediately; do not wait for reset and do not dispatch a duplicate.

Done: every dispatch names its route type, the tier it actually used, and that tier's source layer; the catalog snapshot is recent, and no model table is copied outside the routing settings.

## Six hard rules against backlog

1. **The orchestrator does not wait in a turn.** Only post-merge checks explicitly listed by the project as taking under one minute may run directly. Do not run builds/tests or launch harness background commands and wait for them. Delegate long work with `delegate_task`, record taskId, end the turn, and resume on T3 completion delivery. Do not wait in place with task_status; patrol checks registered unprocessed tasks. **Execution tickets wait per harness.** Claude Code: native background subagents and background commands wake the thread when they finish, so start them and end the turn, saying what it waits for. Pi, Cursor, and other unverified harnesses: completion does not wake an ended turn or deliver the result to it, so wait in the same turn, ending only at delivery, a blocker, or a decision wait, but in bounded slices: each wait call (harness wait, t3_thread_wait, task_status) at most about 60 seconds, never one long sleep, so steer lands between calls. Subagents return only after their work has finished and been checked, never right after starting a script. Every dispatch states the clause for its harness.
2. For final Standards/Spec **0/0**, check only the reported SHA, clean working tree, and existence of every file listed in the artifact inventory. Return inconsistencies; do not add verification or repeat either review axis.
3. Resources are self-service. Execution tickets use the resource adapter named by the project dispatch configuration; [scripts/lease.mjs](scripts/lease.mjs) is the default only when the project selects it; the process holds the lease and exit releases it. Pools may have multiple lanes; each lane sharing a build resource needs its own build directory. No resource request/release messages; patrol checks aggregate usage only. **The orchestrator does not hold device locks itself**; execution tickets acquire and release device locks within their authorized window.
4. Answers and acceptance go directly to the owning Campaign's orchestrator, without another orchestrator relaying them.
5. Reports are three to five lines at milestones only (`orch-report/1` phases startup / blocker / delivery via `report.mjs`; t3-thread also queues). **External mode** uses the required template in EXTERNAL-ORCHESTRATOR.md (adds `progress`, verify + SHA/clean tree/tests/reviews on receive; no `t3_thread_send` for reports). Name every ticket as `id：short title` (DISPATCH.md); launch thread titles use the same string. Put evidence in delivery files and paths in the report; intermediate progress belongs on the ticket or in delivery files.
6. **Capacity comes from routing settings.** Fill capacity from the resolved limits above; never from memory, a brief, or a project file. Exceeding a limit requires the owner's decision. The optional housekeeping session does **not** count toward `execution` / `design` limits (decision 46).

Done: every dispatch includes the execution exception, long work has taskId, and resource allocation/routine progress creates no messages.

## Entry points

| Entry | Action |
|---|---|
| `/orchestration setup` | Follow [SETUP.md](SETUP.md): local doctor, T3 checks, machine/service, phone, project, optional smoke |
| `/orchestration <goal, spec, map, or tickets>` | Start |
| `/orchestration patrol <campaign>` | One [PATROL.md](PATROL.md) pass |
| `/orchestration takeover <campaign>` | Recover using [STATE.md](STATE.md) |
| `/orchestration answers <campaign>` (webhook wakeup) | Process Inbox pending and check current routing, not full patrol |
| Other messages | Receiving messages below |

Keep existing scheduled prompts working: `巡检`, `接手`, `答复` are compatibility aliases for patrol, takeover, answers respectively.

### Orchestrator handoff (mid-Campaign kind / thread switch)

To move the orchestrator between a T3 thread and an external agent (or thread→thread) on a **live** Campaign, use only:

```text
node <skill-dir>/scripts/handoff.mjs plan|apply|revert <campaignId> --to external:<label>|t3-thread:<threadId>
```

`plan` is dry-run for mutation (still logs one `events.log` line). `apply` updates `campaign.json` (with backup), rebinds webhook labels, writes `handoffs/` revert + operator instructions (T3 schedule delete/recreate, report-to steers), and logs `events.log`. `revert` restores the prior snapshot. Refuse paths cover pending Inbox, leases (`--leases-file` or `--project` for `lease.mjs status`), and in-flight ledger state. Details and forwarder acceptance: [EXTERNAL-ORCHESTRATOR.md](EXTERNAL-ORCHESTRATOR.md). Same-thread recovery without a kind change remains [STATE.md](STATE.md) takeover.

## Start

1. Establish the ticket source. Each dispatchable ticket needs ID, acceptance criteria, and blocking edges. For a spec use /to-tickets if available; for an unsettled goal use /wayfinder if available. Otherwise follow the built-in steps in DISPATCH.md. Discussion tickets are HITL: dispatch there, record the discussion stage, show the thread link in page progress.
2. Create the Campaign directory and three state files per STATE.md. Confirm the T3 project is the target repository; use t3_project_list/t3_project_create if needed. Dispatch with explicit projectId and record it in campaign.json.
3. Check local service health per [INBOX.md](INBOX.md). Restart once if unhealthy, recheck, report a blocker if still unhealthy. Register the Campaign. Create a schedule_task with `{"type":"webhook"}` bound to this thread; transfer its URL to set-webhook over standard input per INBOX.md, observing the transcript boundary there. Never write it into messages, public files, ledgers, or logs. Record Campaign ID, page link, webhook task ID, never its URL.
4. Dispatch the frontier per DISPATCH.md until the effective limits are full: undispatched tickets whose blockers are all closed or merged into mainline. Create the housekeeping session only on first need (HOUSEKEEPING.md), not at start.
5. Create a 60-minute patrol bound to this thread (T3 orchestrator). For `orchestratorKind: external`, the external scheduler invokes the same PATROL/INBOX CLI steps instead of `schedule_task`—see EXTERNAL-ORCHESTRATOR.md. Otherwise: schedule `{"type":"interval","everyMs":3600000}`, prompt only `/orchestration patrol <campaign>`. Use `t3_thread_configuration` to compare provider, model and options (including effort) with the project's orchestrator setting, normally the first `discussion` tier, before creation; record the returned ID. Delete/recreate on model change or takeover.
6. Tell the owner the Inbox link, dispatched tickets, and patrol interval. If launched by an initiator, send these in the queue report for that session to relay to the owner. An already subscribed owner can also enter through the first question notification; do not assume a new device is subscribed.

Done: healthy service, registered Campaign, both schedules bound to this orchestrator, recoverable ledger, owner has page link.

## Receiving messages

Read all queued messages with t3_queue_list, truncated ones with t3_queue_read. Batch with the trigger: owner answers and page comments first; use each ticket's latest valid state. Cancel processed/obsolete messages with t3_queue_cancel; leave unprocessed messages. Execution reports and webhooks are not new owner instructions.

- Webhook/answer reminder: process pending and check routing, including review route notifications, per INBOX.md, no full patrol. Ordinary questions: pending → ack → act → forward → close. Acceptance is handled by the orchestrator, skipping forward. Reforward changed answers; handle comments then ack only.
- Routing-change event (including a verified external report with `phase: routing-change`): check current routing and review route notifications per INBOX.md; the event is a wakeup, not proof of current settings.
- Webhook `{campaign, event: "removed"}`: the owner removed the Campaign from Inbox. Delete only this Campaign's webhook and patrol tasks, append to events.log, and stop patrolling it. Do not ask another acceptance question or register it again. If `pending` reports that the Campaign does not exist, confirm its absence from the local registration and apply the same schedule cleanup; this also recovers a failed removal webhook. Preserve data and report any still-running tickets to the initiator.
- Start/blocker/delivery report: update campaign.json and append one event. Check delivery per DISPATCH.md. Decide authority first; have execution ask the owner directly through ask and continue unaffected work. Record waiting for owner only if the whole ticket stops.
- Discussion conclusion: confirm conclusions and new tickets have final two-axis 0/0; check SHA, clean tree, existence of every listed artifact file. Record dependencies and new tickets as not started, close discussion tickets per project permissions, dispatch frontier.
- Child completion: retrieve the registered taskId result, process it, mark processed. No result is not completion.
- Patrol: follow PATROL.md. Direct owner instruction here: act, keeping unresolved question records consistent without overwriting submitted owner answers.

Done: answers reach their asking thread, state recorded, processed queue entries cancelled; fill capacity, register long work, end turn.

## Pi and Cursor drivers

These rules cover execution tickets on the Pi and Cursor drivers. They refine the message modes above and the replacement rules in DISPATCH.md.

- **Running worker (any driver, including Cursor):** send with `mode=steer` — never `mode=queue` (owner 2026-10-28). This supersedes the earlier decision 38 Cursor-queue amendment. Historical note: steer on some Cursor runs has failed handover or left the thread interrupted; residual risk remains, but leaving corrections in the composer queue is forbidden. Prefer writing non-urgent context on the ticket/delivery files; if the session is wedged, interrupt then `mode=auto` (still not queue).
- **Interrupt only when the session cannot take steer** (dead Pi session, wedged run), not as the default delivery path. Read `recentRuns` after interrupt before sending anything else.
- **Running Pi thread:** `mode=steer`, but first confirm the session is still live, because T3 status can lag behind Pi. Open the newest `.jsonl` under `~/.pi/agent/sessions/<worktree directory name>/`. If its last `stopReason` is `stop` and no newer turn follows it, the session has ended and a steer is lost. Call `t3_thread_interrupt`, then send with `mode=auto`.
- **Post-send verification:** after any worker send, read the thread (active/recent run) and its composer queue. Confirm the payload text is in the active run and absent from the queue. Use [scripts/worker-send.mjs](scripts/worker-send.mjs) `verify` on the snapshots — fail closed until active-run match (`provisional` means re-read, not success). Re-send with the correct mode if the message is in the queue or `mode=queue` was used.
- **Stopped after the startup report:** a Pi or Cursor ticket that sent its startup report, then ended its turn without delivery, blocker report, or waiting subagent. Confirm from its latest run and the worktree, then send one `mode=auto` message: continue from the worktree state and report at delivery or blocker. Send no second continuation without re-reading its latest run.
- **Compression loop:** a Pi or Cursor thread that compacts repeatedly within a few minutes, drops context blocks, or logs `kv_blob_miss` in `~/.cache/pi-cursor/pi-cursor-lifecycle-*.jsonl`. A continuation message does not clear it. Hand over instead:
  1. Stop messaging the old thread; interrupt it if it still runs.
  2. Write a handover file in the Campaign storage: branch, worktree, HEAD, completed and remaining work, validation so far. State that the worktree is the source of truth.
  3. Launch a replacement on the same branch and worktree with `existing_worktree`, using the current route tier. Its first message points to the handover file. Follow DISPATCH.md's replacement rules.
  4. Replace the threadId in campaign.json and log the takeover.

## Authority

| Orchestrator decides | Owner decides through owning Campaign Inbox |
|---|---|
| Dispatch within the effective limits, replace broken threads | Concurrency above the effective limits |
| Implementation details, review tradeoffs, revision scope | Product behavior, appearance, scope changes |
| Fixed check, return, merge local mainline, clean up | Push, release, final product acceptance |
| Clean this Campaign's merged worktrees | Close tickets (project may delegate categories), delete user data, irreversible actions |
| Housekeeping requests (merge/disk/investigate/chore) within hard rules | Authorizing deletes beyond directly reclaimable worktrees; enabling external orchestrator mode |

Project authorization takes precedence within scope. Ask when unsure and continue independent work. Merge permission does not imply push/release permission.

## Close out

1. Once tickets are merged, closed, or removed from scope, ask an acceptance question: kind accept, ticket `Closeout summary` (fixed identifier), and a title in the owner's language. Background lists each ticket link, result, verified/unverified areas, remaining issues. After owner approval close remaining tickets. Rework naming ticket numbers applies only to those; close the rest, then summarize again.
2. Settle/archive this Campaign's execution threads and housekeeping session with T3 (or the external agent’s equivalent), then verify absolute paths before deleting leftover empty worktree directories. Clear `housekeeping.disk.pending` first if set. Archiving does not necessarily release T3/harness process handles; if occupied, log the verified empty directory and leave until the holding process exits; do not retry repeatedly. Keep worktrees/branches whose required push has not succeeded; no-remote/forbidden-push projects use successful post-merge checks.
3. After all tickets close and owner confirms, unregister the Campaign and delete webhook/patrol tasks. Archive data/uploads per STATE.md; verify Campaign absolute path before deleting media/. Do not touch other Campaigns, running tickets, private configuration.
4. Report results, owner confirmation, record locations to initiating thread using queue; append closeout event.

Done: tickets closed/out of scope, none executing; registration and schedules removed; archive rules followed; initiator received report.
