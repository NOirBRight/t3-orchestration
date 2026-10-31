# Orchestrator-only rules

Read before the first dispatch. These rules apply only to the orchestrating session; execution sessions follow the public agent rules, not this file. Routes, tiers, limits, and quota state come from the Inbox routing settings (decision 44). This file never lists models or providers.

## Classify the ticket

Pick the route type by the ticket's hardest part. Do not split a ticket to choose a model.

- `discussion`: orchestration and overall product or direction discussion: scope, sequencing, priority, cross-module tradeoffs. Turning an already-settled scope into a checklist, or removing false positives, is `adjudication`.
- `design`: all design work, including form, layout, motion, and frontends that need a new design.
- `visual`: visual implementation of an established design: 3D, materials, rendering, and visual adjudication. New design decisions use `design`.
- `research`: exploration, research, batch processing, documents, text, search, and pure on-device acceptance (operating the device, capturing screenshots, recording defects, no code).
- `code`: backend, debugging, code, and frontends that reuse an existing style without a new design. Judged by tests and numbers.
- `adjudication`: non-visual final decisions, second review, false-positive removal, tradeoff decisions, and checklists for the owner. Visual adjudication uses `visual`.
- `review`: the Standards and Spec child reviews of `code-review`.
- `housekeeping`: the Campaign's housekeeping session (HOUSEKEEPING.md). Not a ticket route; resolve it with `node inbox.mjs route <campaignId> housekeeping`.

A batch worker never adjudicates its own output; send visual adjudication to `visual`, non-visual aggregation and second review to `adjudication`, and Standards/Spec checks to `review`.

## Dispatch

- Before each dispatch, run `node inbox.mjs route <campaignId> <type> --ticket <id>` and use the first entry in `tiers`. `skipped` lists exhausted tiers. Record the chosen `instanceId/model/options` and its source layer in campaign.json and in the launch message. `--ticket` refuses a missing/blank `title` and returns `threadTitle` (`id：short title`).
- Set `t3_thread_launch.title` to that `threadTitle` only (or `dispatch-template.mjs title --campaign-dir … --ticket …`). Never free-form titles like `<campaignId> <id>`. Misnamed live threads: `t3_thread_update` `action=rename` to the same string.
- Project settings name only the Campaign override file and that project's own overrides. Never copy a model table into project settings, briefs, or memory.
- Routing-table edits affect new dispatches only; do not retarget a healthy running ticket for those edits. Quota exhaustion follows DISPATCH.md ("Quota exhaustion defaults"): already-dispatched work hands over to the next tier immediately.
- Check capacity with `node inbox.mjs routes <campaignId>` before adding a ticket. Design tickets run at most two at a time; start the next one only after the owner accepts a delivered design ticket. Keep owner questions about designs to the essential images and three to five lines; details stay in the delivery directory.
- Formal execution tickets are independent top-level threads (`t3_thread_launch`). In-ticket review or advice is child work of the orchestrator (`delegate_task`), not a top-level thread.
- The two child reviews of `code-review` run in parallel and use the Campaign's `review` route tier, stated explicitly. A child that hits quota moves to the next tier in `tiers`.
- Before sending a launch message, confirm that it contains:
  - the real orchestrator `threadId` (or external ref) that receives reports;
  - the **Waiting and reporting** section with `orch-report/1` phases `startup` / `blocker` / `delivery` and the `report.mjs` send command (validate with `dispatch-template.mjs check-message`); t3-thread mode also keeps `t3_thread_send mode=queue`; **external mode** must include the required template in EXTERNAL-ORCHESTRATOR.md (phases include `progress`, plus `report.mjs verify` / SHA / clean tree / tests / review) and pass `check-message --orchestrator-kind external` (or `--campaign-dir`);
  - the rule that the execution session must not send work outward or change harness, model, or effort;
  - the harness-specific waiting clause.
  Recheck this after any harness change.
- After launch, verify the thread against the expected binding (DISPATCH.md, step 4), including that the live title equals `threadTitle`. Record the ticket in campaign.json as awaiting a report, with the initiating `threadId` to summarize to.

## Quota and handover

- Confirm exhaustion from reliable quota status or an actual provider rejection, then mark it with `node inbox.mjs quota mark <instanceId/model> --resume <ISO>`. Clear it with `quota clear` when it is confirmed back or the owner says so.
- Apply the quota rules in DISPATCH.md ("Quota exhaustion defaults") to new and already-dispatched tickets.
- Code errors, test failures, revisions, and network failures are not quota exhaustion.
- When every tier in the route is exhausted, record a blocker and report it. Do not add a route outside the settings.
- A takeover does not switch back when an earlier tier recovers.
- Handover carries the original ticket, scope, expected artifacts, basis, branch, worktree, progress, validation, and remaining work. The replacement continues the same ticket and does not redo it.
- Stop the old writer before the replacement uses the same branch and worktree. Record the reason and any harness or model change.
- Verify the checkout binding with the tools' supported interfaces. Delegation never bypasses permissions or review.

## Housekeeping vs orchestrator-owned work

- Send integration-branch merges, bulk disk cleanup, read-only investigation, listed chores, and `ops` rollouts that do not kill the HK host process to the housekeeping session when enabled (HOUSEKEEPING.md).
- Keep with the orchestrator: default-branch merges, push, ticket closure, Inbox decisions, dispatch, sub-minute post-merge checks the project lists for the orchestrator turn, and any T3/Codex/harness restart that would kill the HK thread (owner approval + `events.log`).
- Housekeeping does not count toward limits; still at most one session per Campaign.
- HK message modes: new matter → queue (`auto` if idle) with `--hk-new-matter`; current-task instruction → steer/auto. No HK todo file — `hk-sent`/`hk-done` + `awaitingReports`.
- After a pushed merge to the skill repo main, rollout to all registered machines is one `ops` HK task verified by identical `skillFolderHash`.

## Reports and closeout

- A missing report is not completion. Inspect the thread, branch, and delivery record first; do not dispatch a duplicate of the same ticket.
- When any message arrives, return to the awaiting-report record first. A new message does not change the original task. The same applies to `HK-*` housekeeping reports (`hk-sent` until `hk-done`).
- After every delivery is checked, send one queued summary to the initiating thread, then end.
- External orchestrator mode (EXTERNAL-ORCHESTRATOR.md) uses the same rules; only wakeup and report transport differ.
