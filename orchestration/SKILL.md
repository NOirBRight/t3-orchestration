---
name: orchestration
description: Orchestrate a Campaign in T3 Code, dispatch execution tickets, communicate through a web Inbox, and patrol until delivery.
disable-model-invocation: true
---

# Orchestration

Requires T3 Code v0.1.0 or later with orchestration MCP, delegate_task, and scheduled tasks. Target T3 Code only. Speak to the owner in their language. The owner display name is configurable, default "you" (PROJECT.md). All routing, quota, reporting, and review rules are included here; no global instruction file or private decision log is required. See [DESIGN.md](DESIGN.md) for operational rationale.

You orchestrate this Campaign. Do not write product code: dispatch the frontier, receive reports, check deliveries, merge, and clean up. The owner uses the web Inbox and issue tracker. One Campaign has one orchestrator for discussion and delivery tickets. If too large, split independent ticket groups into sub-Campaigns, each with an orchestrator, page section, and webhook. Do not split discussion and execution into permanent orchestration roles.

## Read first

- Project `docs/agents/orchestration.md`: concrete storage, capacity, permissions, resource pools, and routing. Use [PROJECT.md](PROJECT.md); agree missing values with the owner before dispatch.
- [DISPATCH.md](DISPATCH.md): routing, quota, templates, review, handover, and merging.
- Messages use `t3_thread_send`. **All messages to execution tickets use `mode=steer`, except running Cursor execution threads use `mode=queue`.** Use `mode=auto` if idle; a thread_not_sendable response to steer means use auto to start a turn. Reports and notifications to the orchestrator use `mode=queue`, never auto. Instructions/corrections from the initiating thread or owner representative to the orchestrator use steer (auto if idle). Do not choose the mode by how much a message seems to affect the work.

Done: source, storage, permissions, capacity, and machine resources are known; material ambiguities resolved before dispatch.

## Six hard rules against backlog

1. **The orchestrator does not wait in a turn.** Only post-merge checks explicitly listed by the project as taking under one minute may run directly. Do not run builds/tests or launch harness background commands and wait for them. Delegate long work with `delegate_task`, record taskId, end the turn, and resume on T3 completion delivery. Do not wait in place with task_status; patrol checks registered unprocessed tasks. **Execution tickets are the exception: wait in the same turn for their own background commands and native subagents, ending only at delivery, a blocker, or a decision wait.** Harness background completion may not wake an execution thread after it ends its turn. Every dispatch must state this exception.
2. For final Standards/Spec **0/0**, check only the reported SHA, clean working tree, and existence of every file listed in the artifact inventory. Return inconsistencies; do not add verification or repeat either review axis.
3. Resources are self-service. Execution tickets wrap commands with [scripts/lease.mjs](scripts/lease.mjs); the process holds the lease and exit releases it. Pools may have multiple lanes; each lane sharing a build resource needs its own build directory. No resource request/release messages; patrol checks aggregate usage only.
4. Answers and acceptance go directly to the owning Campaign's orchestrator, without another orchestrator relaying them.
5. Reports are three to five lines at milestones only. Put evidence in delivery files and paths in the report; intermediate progress belongs on the ticket or in delivery files.
6. Default maximum: **8 running tickets**. Projects may tighten it; exceeding it requires the owner's decision.

Done: every dispatch includes the execution exception, long work has taskId, and resource allocation/routine progress creates no messages.

## Entry points

| Entry | Action |
|---|---|
| `/orchestration setup` | Follow [SETUP.md](SETUP.md): local doctor, T3 checks, machine/service, phone, project, optional smoke |
| `/orchestration <goal, spec, map, or tickets>` | Start |
| `/orchestration patrol <campaign>` | One [PATROL.md](PATROL.md) pass |
| `/orchestration takeover <campaign>` | Recover using [STATE.md](STATE.md) |
| `/orchestration answers <campaign>` (webhook wakeup) | Process INBOX pending only, not full patrol |
| Other messages | Receiving messages below |

Keep existing scheduled prompts working: `巡检`, `接手`, `答复` are compatibility aliases for patrol, takeover, answers respectively.

## Start

1. Establish the ticket source. Each dispatchable ticket needs ID, acceptance criteria, and blocking edges. For a spec use /to-tickets if available; for an unsettled goal use /wayfinder if available. Otherwise follow the built-in steps in DISPATCH.md. Discussion tickets are HITL: dispatch there, record the discussion stage, show the thread link in page progress.
2. Create the Campaign directory and three state files per STATE.md. Confirm the T3 project is the target repository; use t3_project_list/t3_project_create if needed. Dispatch with explicit projectId and record it in campaign.json.
3. Check local service health per [INBOX.md](INBOX.md). Restart once if unhealthy, recheck, report a blocker if still unhealthy. Register the Campaign. Create a schedule_task with `{"type":"webhook"}` bound to this thread; transfer its URL to set-webhook over standard input per INBOX.md, observing the transcript boundary there. Never write it into messages, public files, ledgers, or logs. Record Campaign ID, page link, webhook task ID, never its URL.
4. Dispatch the frontier per DISPATCH.md until capacity is full: undispatched tickets whose blockers are all closed or merged into mainline.
5. Create a 30-minute patrol bound to this thread: schedule `{"type":"interval","everyMs":1800000}`, prompt only `/orchestration patrol <campaign>`. Use `t3_thread_configuration` to compare provider, model and options (including effort) with the project Orchestrator profile before creation; record the returned ID. Delete/recreate on model change or takeover.
6. Tell the owner the Inbox link, dispatched tickets, and patrol interval. If launched by an initiator, send these in the queue report for that session to relay to the owner. An already subscribed owner can also enter through the first question notification; do not assume a new device is subscribed.

Done: healthy service, registered Campaign, both schedules bound to this orchestrator, recoverable ledger, owner has page link.

## Receiving messages

Read all queued messages with t3_queue_list, truncated ones with t3_queue_read. Batch with the trigger: owner answers and page comments first; use each ticket's latest valid state. Cancel processed/obsolete messages with t3_queue_cancel; leave unprocessed messages. Execution reports and webhooks are not new owner instructions.

- Webhook/answer reminder: process pending per INBOX.md, no full patrol. Ordinary questions: pending → ack → act → forward → close. Acceptance is handled by the orchestrator, skipping forward. Reforward changed answers; handle comments then ack only.
- Start/blocker/delivery report: update campaign.json and append one event. Check delivery per DISPATCH.md. Decide authority first; have execution ask the owner directly through ask and continue unaffected work. Record waiting for owner only if the whole ticket stops.
- Discussion conclusion: confirm conclusions and new tickets have final two-axis 0/0; check SHA, clean tree, existence of every listed artifact file. Record dependencies and new tickets as not started, close discussion tickets per project permissions, dispatch frontier.
- Child completion: retrieve the registered taskId result, process it, mark processed. No result is not completion.
- Patrol: follow PATROL.md. Direct owner instruction here: act, keeping unresolved question records consistent without overwriting submitted owner answers.

Done: answers reach their asking thread, state recorded, processed queue entries cancelled; fill capacity, register long work, end turn.

## Authority

| Orchestrator decides | Owner decides through owning Campaign Inbox |
|---|---|
| Dispatch within capacity, models, replace broken threads | Concurrency above capacity |
| Implementation details, review tradeoffs, revision scope | Product behavior, appearance, scope changes |
| Fixed check, return, merge local mainline, clean up | Push, release, final product acceptance |
| Clean this Campaign's merged worktrees | Close tickets (project may delegate categories), delete user data, irreversible actions |

Project authorization takes precedence within scope. Ask when unsure and continue independent work. Merge permission does not imply push/release permission.

## Close out

1. Once tickets are merged, closed, or removed from scope, ask an acceptance question: kind accept, ticket `Closeout summary` (fixed identifier), and a title in the owner's language. Background lists each ticket link, result, verified/unverified areas, remaining issues. After owner approval close remaining tickets. Rework naming ticket numbers applies only to those; close the rest, then summarize again.
2. Settle/archive this Campaign's execution threads with T3, then verify absolute paths before deleting leftover empty worktree directories. Archiving does not necessarily release T3/harness process handles; if occupied, log the verified empty directory and leave until the holding process exits; do not retry repeatedly. Keep worktrees/branches whose required push has not succeeded; no-remote/forbidden-push projects use successful post-merge checks.
3. After all tickets close and owner confirms, unregister the Campaign and delete webhook/patrol tasks. Archive data/uploads per STATE.md; verify Campaign absolute path before deleting media/. Do not touch other Campaigns, running tickets, private configuration.
4. Report results, owner confirmation, record locations to initiating thread using queue; append closeout event.

Done: tickets closed/out of scope, none executing; registration and schedules removed; archive rules followed; initiator received report.
