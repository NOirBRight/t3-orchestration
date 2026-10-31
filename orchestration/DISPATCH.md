# Dispatch, check, and merge

## Routing, review, and quota

Routes, tiers, and limits come from the Inbox routing settings (SKILL.md, decision 44); they are not copied into project settings or briefs. Classify by the ticket's hardest part. All design work uses `design`, including form, layout, motion, and new visual decisions. `visual` covers visual implementation of an established design: 3D, materials, rendering, and visual adjudication. Route non-visual adjudication through `adjudication`. Before each dispatch run `node inbox.mjs route <campaignId> <type>` and take the first entry in `tiers`; `skipped` shows exhausted tiers with a reset time. Honor explicit owner choices; that is what the settings are for. Routing changes affect new dispatches only, so never switch the tier of running work. Select provider, model, and options explicitly, including for CLI work; a tier missing from the catalog snapshot is not a valid selection.

Formal execution tickets use `t3_thread_launch` as independent top-level threads. Orchestrator-owned in-ticket review/advice uses delegate_task as child work, not a top-level thread. Execution sessions cannot use delegate_task except for the two-axis review exception below. Native subagents may be used for necessary parallelism with the same harness/model/effort.

### Execution sessions do not dispatch outward

Only the orchestrator selects and dispatches tiers. A launched execution session must not send work to other sessions using t3_thread_launch, create_threads, delegate_task, schedule_task, or equivalent tools, or change harness/model/effort. Necessary parallel/context-isolated work uses its current harness's native subagents inheriting its configuration, with no provider/model/effort override. **Exception: Standards/Spec review children explicitly use the Campaign's `review` route tier.** If another harness/model is needed, report why and the proposed approach to the orchestrator for a decision. Include this constraint in every dispatch, also after a harness handover. The same outward-dispatch ban applies to the housekeeping session (no review exception).

### Quota exhaustion defaults

Mark confirmed exhaustion once with `node inbox.mjs quota mark <instanceId/model> --resume <ISO>` so every orchestrator skips that tier for new dispatches; `route` then reports it under `skipped`. A mark with a reset time expires on its own. Clear one without a reset time, or one the owner overrides, with `node inbox.mjs quota clear <instanceId/model>`.

1. New work: when reliable quota status or an actual quota rejection confirms the current tier is exhausted, move to the next tier in the route immediately; do not wait for reset.
2. Already dispatched work: when the current tier is confirmed exhausted, stop the old writer and hand over the same ticket, branch, worktree and evidence to the next tier in the route immediately; do not wait for reset, and do not dispatch a duplicate of the same ticket.
3. The orchestrator coordinates that handover; execution sessions report the blocker rather than choosing another harness/model themselves.
4. Code errors, test failures, revisions, and network failures are not quota exhaustion. Use the provider's reset time when marking exhaustion, never invent one. Do not clear a mark because time passed.
5. Do not switch healthy work back when an earlier tier recovers. If every tier in the route is exhausted, record/report a blocker. Do not invent a tier outside the route.

### Reports and handovers

Every launch message must contain the actual dispatching orchestrator threadId, t3_thread_send, mode=queue, and reporting milestones. Research tickets have the same obligation. Merely requesting a document, issue closure, or a summary in the execution thread is insufficient. Recheck after switching harnesses.

Report three to five lines only after startup verification (branch/worktree/HEAD), on a blocker or decision request, and at validated delivery. Evidence and intermediate progress (review rounds, tests running, revision candidates) belong on the ticket or delivery files, not messages. Read resource reporting conditions from the project adapter; self-service resources create no request/release messages. At delivery include branch, worktree, commit, artifact location, review results, actual validation, and unverified areas. Completing a document does not replace reporting. On decision requests state the question and recommendation and stop dependent work.

Retain returned execution threadIds and compare reports with actual artifacts. No report is not completion: if quota/tools prevent reporting, inspect thread, ticket, and branch before quota handling; do not dispatch duplicates. Immediately record ticket IDs in campaign.json awaitingReports and the final initiating threadId in initiator; remove each ID after handling its delivery. Every incoming message returns to those obligations; it does not replace the original task. After all deliveries are checked, send a queue summary to that initiator before ending.

For handover include original ticket, scope, expected artifacts, basis, branch, worktree, progress, validation, and remaining work. Orchestrator coordinates takeover: stop the old writer before the replacement uses the same branch/worktree. Record reason and harness/model changes. Verify actual supported interfaces and checkout binding; never use delegation to bypass permissions or review.

## Execution sessions own two-axis review

All delivery tickets (implementation, research, documentation, modeling, design) and HITL discussion sessions run Standards/Spec review themselves and revise to **0/0** before delivery. The implementation path uses /implement if available; other paths follow the templates below. Discussion review covers final conclusions and the resulting delivery tickets. The orchestrator does not dispatch their review for them or review each intermediate round.

Before starting each review round, execution sessions run `node inbox.mjs route <campaignId> review` on the Campaign's machine and use the current effective ordered tiers, including options and quota skips. A launch-time tier or notification is a snapshot, not a substitute for this check. If the route cannot be read, report a blocker instead of guessing. Already running review children finish unchanged; the next round uses the new route. Batch workers must not adjudicate their own output. After final 0/0 the orchestrator checks only SHA, clean working tree, and existence of every listed artifact file; return inconsistencies without additional verification or repeated axes.

## Optional external skills and built-in steps

These four skills are **optional, not bundled**. Use them when installed; otherwise use these steps without requiring any global instructions. These built-in steps take precedence wherever an external skill conflicts.

- `/wayfinder`: discuss an unsettled goal with the owner, one question at a time with options and a recommendation. Record confirmed decisions/reasons and scope before turning them into tickets.
- `/to-tickets`: split a settled spec/conclusion into independently deliverable tickets. Each needs scope, acceptance criteria, basis, and explicit blocking dependencies; attach to the same map and report IDs/dependencies. Never invent product decisions.
- `/implement`: read the ticket and local contracts, inspect code, make the smallest complete change on the assigned branch, run relevant verification and project-required checks, perform the review below, revise, create a local candidate commit, and document delivery. No push/PR/merge/closure unless the dispatch explicitly authorizes it.
- `/code-review`: pin the base and candidate commit; gather diff/commit list, project standards (including AGENTS.md), and the original ticket plus confirmed decisions. In T3 call delegate_task for **two parallel child reviews**, explicitly selecting the Campaign's `review` route tier. Standards checks documented conventions and maintainability (naming, duplication, misplaced responsibilities, needless abstraction); Spec checks missing/partial requirements, incorrect behavior, and unrequested scope. Require file/line evidence and cited requirement/standard, distinguishing judgement calls. Keep axes separate, resolve findings and rerun affected review until final 0/0. For each later round create new delegate_task calls with original brief, prior findings, responses, unresolved objections, and distinct retry-stable clientRequestIds. Retain taskIds, collect terminal results with task_status; do not continue a review round by sending to childThreadId. For artifacts outside the repository review the actual delivered files too. Execution sessions wait for these children in the same turn, in t3_thread_wait slices of at most about 60 seconds.

Other specialist skills (e.g. research/domain-modeling) may help when available; otherwise inspect primary evidence or define domain terms directly, document findings, and use the same validation/review contract.

## Ticket naming (required)

Every report, patrol note, Inbox question/comment, launch message, and worker/orchestrator message that names a ticket uses **`id：short title`** (full-width colon). Example: `P33：工单与派单模板`. Bare ids (`P33`, `#42`) are not enough. The short title is the same non-empty `title` stored on `campaign.json` `tickets[]` and on ticketed `orch-report/1` bodies.

- Write tickets with the file template below; put the same short title in `campaign.json` via `scripts/campaign-write.mjs` (refuses blank `tickets[].title`).
- Before launch run `node inbox.mjs route <campaignId> <type> --ticket <id>`. The `--ticket` flag loads campaign.json and **refuses** a missing/blank title. On success it prints `ticketRef` and **`threadTitle`** — both are the same `id：title` string. Do not dispatch without a successful routed ticket.
- **`t3_thread_launch` `title` must be exactly that `threadTitle`** (generated by the dispatch tools from `campaign.json`, never free-form like `my-campaign P34`). Generate with `node <skill-dir>/scripts/dispatch-template.mjs title --campaign-dir <dir> --ticket <id>` or take `threadTitle` from `route --ticket`. Missing/blank title is refused. Existing misnamed threads: `t3_thread_update` with `action=rename` and the same `id：short title` string.
- Launch messages must include the **Waiting and reporting** steps (orch-report/1 phases `startup` / `blocker` / `delivery`, sent via `report.mjs`). Validate before send: `node <skill-dir>/scripts/dispatch-template.mjs check-message --file <launch.txt>` (refuses when the section is missing).
- **External Campaigns** (`orchestratorKind: "external"`): the worker report contract is the required template in [EXTERNAL-ORCHESTRATOR.md](EXTERNAL-ORCHESTRATOR.md) (phases `startup` / `progress` / `blocker`|question / `delivery`, `report.mjs` send, loopback forwarder + webhook **path shapes only**, and orchestrator `report.mjs verify` + SHA / clean tree / tests / review checks). **Link that section; do not paste a second copy here.** Validate with `check-message --file <launch.txt> --orchestrator-kind external` or `--campaign-dir <dir>` (auto-detects kind). Filled helper: `dispatch-template.mjs external-section`.
- Reports (`scripts/report.mjs` / `assertPublicReport`, both t3-thread and external) refuse a `ticket` field without `title`. Message lines may use `scripts/ticket-ref.mjs` (`format` / `line`) so worker-send and queue reports stay consistent.

## Ticket file template (required)

Put these fields on the tracker ticket itself (local Markdown or issue body). One ticket, one id, one short title.

```markdown
# <id> <short title in the owner's language>
说明：<same short title, or one plain-language line>
Route type: <discussion|design|visual|research|code|adjudication|review>

## Goal
<one outcome line>

## Scope
1. <in-scope work>
2. …

## Acceptance
- <checkable done criteria>

## Blocked by / Depends on
- <ids or none>

## Evidence and reporting
- Call this ticket **`<id>：<short title>`** in every report, patrol note, and Inbox message.
- Evidence under `<Campaign storage>/deliveries/<id>/` (and `media/<id>/` when visual).
- Milestone reports only (startup after branch/worktree/HEAD check, blocker/decision, validated delivery): three to five lines; lead with `<id>：<short title>`.
- External: `report.mjs` JSON includes `ticket`, `title`, `phase`, `summary`, `evidence` (see EXTERNAL-ORCHESTRATOR.md).
```

## Dispatch one ticket

1. **Prepare.** Put scope and completion criteria on the ticket itself with the ticket file template above, not only in a launch message. Record `ticket` + non-empty `title` on campaign.json before launch (`campaign-write.mjs`). Before dispatch, check `deliveries/<ticket-number>/` for an existing delivery and inspect currently running threads (crosscheck or fresh `t3_thread_list`); do not launch a duplicate for an already-delivered or already-running ticket without an explicit replacement decision. Base a branch on current mainline HEAD: one ticket, one branch, one worktree, created by the orchestrator, not the execution session. Normally use t3_thread_launch workspaceStrategy. When a fixed location is required, first run `git worktree add -b <branch> <absolute-path> <mainline>`, then launch with `existing_worktree` bound to that path; check the live tool schema and actual binding.
2. **Select.** Run `node inbox.mjs route <campaignId> <type> --ticket <id>` and take the first available tier (command fails if that ticket has no title); check the Campaign's effective limits with `node inbox.mjs routes <campaignId>` before adding a ticket. Never edit the routing files by hand.
3. **Preflight and launch.** Resolve the route and confirm the catalog snapshot is current; a dispatch configuration the project still pins covers the non-routing values only (permissions, resource adapter, reporting paths), never the route. Read the live launch schema and orchestrator_capabilities, and run the project read-only checker against the exact JSON to send. It must reject unknown/legacy fields and verify modelSelection.instanceId/model/options and workspaceStrategy. For modeling/design tickets (`design` route, or campaign `kind`/`type`/`labels` containing 建模/modeling/设计/design), the message must contain the literal `build-display-models` or the checker rejects the dispatch. Pass campaign kind/labels via the checker's ticket-meta input. Set **`t3_thread_launch.title` to `threadTitle` from `route --ticket`** (or `dispatch-template.mjs title`). Fill the launch template below with actual **`id：short title`** and paths; run `dispatch-template.mjs check-message` so the Waiting and reporting / orch-report steps are present (add `--orchestrator-kind external` or `--campaign-dir` when the Campaign is external so the EXTERNAL-ORCHESTRATOR.md report template markers are required). A failed check sends nothing.
4. **Verify and record.** Retain the returned threadId and record preparing first. Use t3_thread_read plus t3_thread_configuration (for options), and read Git in the bound worktree, to compare actual provider/model/options, modes, project, worktree, branch and full HEAD with the saved expected binding. Only mark executing after preparation and all comparisons pass. Retain failed-preparation IDs and inspect original thread evidence before considering a replacement; a lost response requires thread-list investigation, not a blind retry. Then record outstanding reports and the obligation to summarize to initiator.

### Launch message template

```text
You are implementing <id>：<short title>: <ticket URL>.

1. Read <ticket>, <tests/domain docs referenced by project AGENTS.md>.
2. Runtime configuration: routing settings version <version> with Campaign override <override path or none>; effective `<route-type>` route tier <instanceId/model/options> from layer <global|machine|campaign>, chosen by the orchestrator. Review route first tier at launch: <review-instanceId/model/options> from layer <global|machine|campaign>. Before each new Standards/Spec review round run `node inbox.mjs route <campaignId> review` on the Campaign's machine and use the current effective tiers and options; if unavailable report a blocker. Existing review children finish unchanged. Non-routing dispatch configuration: <path/version/hash or none>. Verify these before starting; code/test baseline remains <commit>. Branch <branch>, base <commit>; work in this thread's bound checkout. Put delivery.md, reproduction scripts, test logs, etc. in <Campaign storage>/deliveries/<ticket-number>/ for retention. For visual tickets put screenshots/recordings in <Campaign storage>/media/<ticket-number>/. If a screenshot tool cannot choose a path, decode its returned image data into that directory.
3. Use /implement if installed, otherwise DISPATCH.md's built-in implementation steps, including Standards/Spec review and revisions. Stop at a local candidate commit: no push, PR, merge, or issue closure.
4. Constraints: no mainline commits; no --no-verify or --no-gpg-sign; do not delete others' files or expose credentials/tokens; <project resource constraints>.
5. No outward dispatch: do not send work to other sessions with t3_thread_launch, create_threads, delegate_task, schedule_task; do not change harness/model/effort. Necessary parallel work uses this harness's native subagents inheriting its configuration. Sole exception: the two review children use the Campaign's `review` route tier explicitly. Report any need for another harness/model to the orchestrator.
6. Authority: decide implementation details and review tradeoffs. Owner decides product behavior/appearance/scope, push/release, deletion, irreversible actions; ask orchestrator if unsure. For owner decisions follow <skill-dir>/INBOX.md and inbox-web/schema.md: write JSON and run node <skill-dir>/inbox-web/inbox.mjs ask <campaignId> <draft.json> directly for the owning Campaign. Local Campaign directory: <directory>. Its own orchestrator forwards answers, never another orchestrator. Continue unaffected work; report per section 7 only if the whole ticket is blocked.
7. Waiting and reporting (等待与回报): <keep the line for this harness> Claude Code: after starting native background subagents or background commands, end the turn and say what you wait for; their completion wakes this thread. | Pi, Cursor, other: native subagent and background completion do not wake an ended turn, so wait in this turn and end only at delivery, a blocker, or a decision wait. Every wait call (harness wait, t3_thread_wait, task_status) waits at most about 60 seconds; never sleep, so steer can land between calls. Both: wait for review children with t3_thread_wait in slices of at most about 60 seconds; subagents return only after their work has finished and been checked, never right after starting a script. Resources: read and use <Campaign-pinned project resource adapter>; follow its acquisition/status/reporting contract. Only after startup verification (branch/worktree/HEAD), on blocker/decision, or validated delivery, write an orch-report/1 JSON under <Campaign storage>/deliveries/<id>/reports/ with fields: schema "orch-report/1", campaign, ticket "<id>", title "<short title>", phase one of startup|blocker|decision|delivery, threadId (this thread), summary (3–5 lines naming <id>：<short title>). Then send with: node <skill-dir>/scripts/report.mjs --campaign-dir <absolute-campaign-dir> --file <report.json>. Phases that must always be covered: startup, blocker, delivery (plus decision when asking the orchestrator). Do not skip delivery after a local candidate commit. t3-thread Campaigns: also queue the same three-to-five-line note with t3_thread_send mode=queue to orchestrator <actual dispatching threadId>. **External Campaigns: do not copy a second report contract here — follow the required external mode report template in EXTERNAL-ORCHESTRATOR.md** (phases startup/progress/blocker|question/delivery, report.mjs send, loopback forwarder and webhook path shapes, orchestrator verify + SHA/clean tree/tests/reviews). Put intermediate review/test/revision progress on ticket/delivery files, not messages. Delivery includes branch, worktree, final commit, separate review conclusions, actual validation, unverified areas, artifact locations. Before delivery comment on the ticket with changes, verified and unverified areas. For a local Markdown tracker append a `## Delivery notes` section to the ticket on the execution branch.
```

## Dispatch discussion

HITL sessions help the owner settle a question, without product code. Select route by content (new design uses design). Use workspaceStrategy root; discussions changing docs get a branch/worktree like delivery tickets.

```text
You host discussion <id>：<short title>: <URL>. HITL: owner will open this thread; ask one question at a time with options and a recommendation. Runtime configuration: routing settings version <version>; effective <route-type> tier <instanceId/model/options> from layer <global|machine|campaign>.

1. Read <ticket>, <domain docs>. Name this ticket <id>：<short title> in every report and Inbox draft.
2. Record agreed decisions, reasons, and owner's exact words on the ticket.
3. If implementation is needed, use optional /to-tickets or DISPATCH.md's built-in steps to create delivery tickets on the same map with dependencies; each new ticket needs id + short title (ticket file template).
4. Review final conclusions and resulting tickets with optional /code-review or built-in Standards/Spec parallel reviews, revise to 0/0 before reporting. Spec compares original discussion ticket and owner-confirmed decisions. Explicitly select the `review` route tier for children.
5. No outward dispatch or harness/model/effort changes. Necessary native subagents inherit configuration. Only two-axis review children may use the explicit `review` route tier. Report other harness/model needs to the orchestrator.
6. Waiting and reporting (等待与回报): use the harness clause from the delivery template's section 7 (Claude Code ends the turn after starting background subagents; Pi, Cursor, and other harnesses wait in this turn in calls of at most about 60 seconds, never sleep). At startup, blocker/decision, and validated delivery (conclusions + ticket split + review 0/0), write orch-report/1 (schema orch-report/1, ticket, title, phase startup|blocker|decision|delivery, summary) under deliveries/<id>/reports/ and send with report.mjs --campaign-dir <absolute-campaign-dir> --file <report.json>; t3-thread Campaigns also t3_thread_send mode=queue to <actual orchestrator threadId>, three to five lines, leading with <id>：<short title>. **External Campaigns: EXTERNAL-ORCHESTRATOR.md external mode report template (link only; no second copy).** Intermediate progress goes on ticket/delivery files, not messages.
```

Record as for delivery, using the discussion stage in STATE.md.

## Dispatch research, documentation, modeling

These do not write product code or require /implement. They still own Standards/Spec review to 0/0. Select the route by content and prepare branch/worktree as above. Use the seven-section launch template, replacing section 3 only:

```text
3. Research the ticket (use /research if available), follow project documentation workflow for docs, or define domain terms (optional /domain-modeling). Before delivery run optional /code-review or built-in Standards/Spec review against <base>..HEAD for repo changes and actual external artifact files, revise to 0/0. Stop at local candidate commit: no push, PR, merge, closure.
```

Keep the other six sections, adapting read-list and delivery directory; omit media directory for nonvisual tickets.

## Replace an unrecoverable execution thread

Threads may stop reporting after restart, quota exhaustion, or failed context/model handover. First send one continuation message (SKILL.md modes: running worker → `steer`, idle/terminal → `auto`, never `queue` for workers; resolve/verify with scripts/worker-send.mjs); if it cannot start or handover fails, do not keep trying. Read final messages/branch/worktree to establish progress. Start a replacement on **the same branch and worktree**, after stopping old edits. Include old threadId, completed/remaining work; continue the same ticket, do not redo it. Replace threadId in campaign.json, log takeover/reason, stop messaging the old thread. Apply the quota and ordered-tier rules above; code/test/network failures are not exhaustion.

## Check delivery

For final two-axis 0/0 check only: branch SHA matches report, working tree clean, every file listed in the artifact inventory exists. Return mismatches; no screenshot sampling, test reruns, long-log verification, repeated axes, or extra second review. Missing review conclusions go back to execution. Applies to every ticket and discussion conclusion.

After the fixed check, visual product tickets get one acceptance question per ticket through inbox.mjs ask by their owning orchestrator, with media under Campaign media/ (STATE.md). Never route through another orchestrator. Nonvisual tickets wait for closeout summary. Done: three checks agree, two axes zero, required owner acceptance received before merge.

## Dispatch the housekeeping session

When the project enables housekeeping (PROJECT.md § Housekeeping) and work needs a local integration merge, bulk disk cleanup, read-only investigation, a listed chore, or an `ops` rollout that will not kill the HK host process, follow [HOUSEKEEPING.md](HOUSEKEEPING.md). Lazy-create at most one session per Campaign; it does not count toward `execution` / `design` limits.

**Message modes (decision 46 amendment 2026-10-28):** a **new separate matter** (new `HK-n`) → `t3_thread_send mode=queue` (`auto` if idle) with `scripts/worker-send.mjs` `--hk-new-matter` / `newMatter:true`; an instruction/correction on the **current** HK task → `steer` while running, `auto` if idle (no queue). Queue is HK-only and only for new matters; workers still never queue. Put `HK-<n>` in `awaitingReports` on send; append `hk-sent` to events.log; on handled report append `hk-done` and remove the id. No separate HK todo file.

After a **pushed** merge to the skill repo’s main, dispatch one `ops` HK request to roll out to all registered machines and verify identical `skillFolderHash` (HOUSEKEEPING.md).

## Merge and clean up

For checked branches (and required owner approval). When housekeeping is enabled and the target is a listed integration branch, prefer a `merge` request to the housekeeping session for steps 1–2 and bulk evidence; the orchestrator still owns push, default-branch merges, ticket closure, and the small post-merge worktree/branch remove after verification (HOUSEKEEPING.md defaults).

1. Before merging, run the repository merge precheck: `python -m tools.merge_precheck --onto <mainline> --sources <ordered branches>`. It simulates each merge with `git merge-tree --write-tree` and must report conflict files for every step (not only the first). Do not merge while it reports conflicts. When every step is clean, use the related-test commands it lists from `docs/agents/testing.md` (optional `--run` in a temporary worktree that is deleted afterwards). The precheck must not move any branch refs.
   **Risk tiers (decision 53).** A verified candidate already has worker self-test, Standards/Spec 0/0 and the orchestrator evidence check. Before merge run `node <skill-dir>/scripts/merge-risk.mjs --repo <repo> --target <mainline> --branch <branch> --candidate <sha> --verified-base <base at verification> [--triggers-file <project mergeRiskTriggers as JSON>]`: it asserts the candidate SHA, runs `merge-tree` and `diff --check`, and scans changed paths. `tier: scripted` → merge with no extra AI review. `tier: recheck` (shared test config/runners, core shared modules, build/release/signing scripts, CI, or `base-moved`) → the HK zero-context recheck runs first; `base-moved` also means re-verify. `ok: false` → stop.
2. Merge in dependency order. Later branches first integrate mainline on their own branch, resolve conflicts, rerun affected tests and incremental review in execution, then redeliver.
3. Merge local mainline and follow project post-merge tiers. Only explicitly listed sub-minute checks may run in the orchestrator turn; delegate others, record taskId, resume on completion. The post-merge full suite is mandatory after every merge (batching via `postMergeBatch` is not implemented; HOUSEKEEPING.md § Risk-tiered merge checks). Push/closure require passed post-merge checks; push still needs owner authorization or an explicit project grant.
4. Fetch before push. If remote advanced (including another machine's merges), never force push: return to original execution branch/worktree to integrate remote, incrementally validate/review, redeliver, check/merge/check again. Failed push retains worktree and branch until success.
5. After successful authorized push (or successful post-merge checks when the project has no remote or forbids push), verify mainline contains branch and worktree is clean; remove worktree, local branch, this ticket's temporary directories/build artifacts. If deletion authority is unclear, keep and ask through INBOX. Remove the branch and Git worktree registration in the merge round. Occupied empty directories wait for closeout; archiving a thread may not release process handles. Do not force removal of active files. Before reclaiming a worktree, re-check the ticket thread status; if the thread is still live/running, do not remove the worktree.
6. Set merged stage in campaign.json; log merge and every cleanup.
For local Markdown trackers, close approved tickets by appending `## Status` with `Closed`, merge SHA and validation. The orchestrator commits tracker updates on a temporary branch and fast-forwards mainline; never commit directly on mainline.

7. Visual product tickets approved by owner close after checks pass and push succeeds, commenting merge SHA/validation. Others (nonvisual product, tooling, test infrastructure, documentation) stay merged for owner closeout approval. If project grants category closure, still require successful checks/push and comment merge SHA/validation.

Done: all seven launch sections include actual reporting target/queue, execution waiting exception, Campaign ID/draft location, project resource adapter usage. Routes, message-mode rules and resource commands are read from their single configured sources rather than copied into briefs; every dispatch names the tier actually used and its source layer. Memory keeps only a current source pointer and historical evidence. Outstanding reports and initiator obligation recorded. Replacements stop old writer and retain branch/worktree/progress. Merges stay within authorization after a clean merge precheck, delegated checks have results, cleanup paths verified, closure follows permission. The six hard rules in SKILL.md apply throughout; execution must not apply the orchestrator's early-turn-ending rule.
