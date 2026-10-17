# Dispatch, check, and merge

## Routing, review, and quota

Use the project profiles/routes from [PROJECT.md](PROJECT.md), selected from orchestrator_capabilities. Honor explicit owner choices. Classify by the ticket's hardest part; running work does not change model when routing settings change. Select provider, model, and options explicitly, including for CLI work; confirm actual support before invoking.

Formal execution tickets use `t3_thread_launch` as independent top-level threads. Orchestrator-owned in-ticket review/advice uses delegate_task as child work, not a top-level thread. Execution sessions cannot use delegate_task except for the two-axis review exception below. Native subagents may be used for necessary parallelism with the same harness/model/effort.

### Execution sessions do not dispatch outward

Only the orchestrator selects and dispatches execution profiles. A launched execution session must not send work to other sessions using t3_thread_launch, create_threads, delegate_task, schedule_task, or equivalent tools, or change harness/model/effort. Necessary parallel/context-isolated work uses its current harness's native subagents inheriting its configuration, with no provider/model/effort override. **Exception: Standards/Spec review children explicitly use the configured review profile.** If another harness/model is needed, report why and the proposed approach to the orchestrator for a decision. Include this constraint in every dispatch, also after a harness handover.

### Quota exhaustion defaults

1. New work: when reliable quota status or an actual quota rejection confirms primary exhaustion, use the designated fallback immediately; do not wait for reset.
2. Already dispatched work: if automatic reset is at most **24 hours away, including exactly 24**, retain the task, harness, and model and wait. Do not switch or dispatch a duplicate.
3. If reset is more than 24 hours away, or no reset time is supplied and checking still cannot establish it, hand over to the designated fallback harness/model.
4. Code errors, test failures, revisions, and network failures are not quota exhaustion. Use the provider's reset time, never invent one.
5. Do not switch a healthy fallback task back when primary quota recovers. If fallback is exhausted too, already dispatched tasks within the 24-hour window still wait; otherwise record/report a blocker. Do not invent a third route.

### Reports and handovers

Every launch message must contain the actual dispatching orchestrator threadId, t3_thread_send, mode=queue, and reporting milestones. Research tickets have the same obligation. Merely requesting a document, issue closure, or a summary in the execution thread is insufficient. Recheck after switching harnesses.

Report three to five lines only after startup verification (branch/worktree/HEAD), on a blocker or decision request, and at validated delivery. Evidence and intermediate progress (review rounds, tests running, revision candidates) belong on the ticket or delivery files, not messages. Resources are self-service leases: no request/release messages. At delivery include branch, worktree, commit, artifact location, review results, actual validation, and unverified areas. Completing a document does not replace reporting. On decision requests state the question and recommendation and stop dependent work.

Retain returned execution threadIds and compare reports with actual artifacts. No report is not completion: if quota/tools prevent reporting, inspect thread, ticket, and branch before quota handling; do not dispatch duplicates. Immediately record ticket IDs in campaign.json awaitingReports and the final initiating threadId in initiator; remove each ID after handling its delivery. Every incoming message returns to those obligations; it does not replace the original task. After all deliveries are checked, send a queue summary to that initiator before ending.

For handover include original ticket, scope, expected artifacts, basis, branch, worktree, progress, validation, and remaining work. Orchestrator coordinates takeover: stop the old writer before the replacement uses the same branch/worktree. Record reason and harness/model changes. Verify actual supported interfaces and checkout binding; never use delegation to bypass permissions or review.

## Execution sessions own two-axis review

All delivery tickets (implementation, research, documentation, modeling, design) and HITL discussion sessions run Standards/Spec review themselves and revise to **0/0** before delivery. The implementation path uses /implement if available; other paths follow the templates below. Discussion review covers final conclusions and the resulting delivery tickets. The orchestrator does not dispatch their review for them or review each intermediate round.

Review children explicitly use the project's review profile, not the execution model by inheritance. Batch workers must not adjudicate their own output. After final 0/0 the orchestrator checks only SHA, clean working tree, and existence of every listed artifact file; return inconsistencies without additional verification or repeated axes.

## Optional external skills and built-in steps

These four skills are **optional, not bundled**. Use them when installed; otherwise use these steps without requiring any global instructions. These built-in steps take precedence wherever an external skill conflicts.

- `/wayfinder`: discuss an unsettled goal with the owner, one question at a time with options and a recommendation. Record confirmed decisions/reasons and scope before turning them into tickets.
- `/to-tickets`: split a settled spec/conclusion into independently deliverable tickets. Each needs scope, acceptance criteria, basis, and explicit blocking dependencies; attach to the same map and report IDs/dependencies. Never invent product decisions.
- `/implement`: read the ticket and local contracts, inspect code, make the smallest complete change on the assigned branch, run relevant verification and project-required checks, perform the review below, revise, create a local candidate commit, and document delivery. No push/PR/merge/closure unless the dispatch explicitly authorizes it.
- `/code-review`: pin the base and candidate commit; gather diff/commit list, project standards (including AGENTS.md), and the original ticket plus confirmed decisions. In T3 call delegate_task for **two parallel child reviews**, explicitly selecting the configured review profile. Standards checks documented conventions and maintainability (naming, duplication, misplaced responsibilities, needless abstraction); Spec checks missing/partial requirements, incorrect behavior, and unrequested scope. Require file/line evidence and cited requirement/standard, distinguishing judgement calls. Keep axes separate, resolve findings and rerun affected review until final 0/0. For each later round create new delegate_task calls with original brief, prior findings, responses, unresolved objections, and distinct retry-stable clientRequestIds. Retain taskIds, collect terminal results with task_status; do not continue a review round by sending to childThreadId. For artifacts outside the repository review the actual delivered files too. Execution sessions wait for these children in the same turn.

Other specialist skills (e.g. research/domain-modeling) may help when available; otherwise inspect primary evidence or define domain terms directly, document findings, and use the same validation/review contract.

## Dispatch one ticket

1. **Prepare.** Put scope and completion criteria on the ticket itself, not only in a launch message. Base a branch on current mainline HEAD: one ticket, one branch, one worktree, created by the orchestrator, not the execution session. Normally use t3_thread_launch workspaceStrategy. When a fixed location is required, first run `git worktree add -b <branch> <absolute-path> <mainline>`, then launch with `existing_worktree` bound to that path; check the live tool schema and actual binding.
2. **Select.** Choose the configured route for the hardest part; project model/capacity settings take precedence.
3. **Launch.** Use t3_thread_launch with the template below. Verify all seven sections before sending, with actual IDs and paths substituted.
4. **Record.** Save threadId, branch, actual worktree path (query t3_worktree_list after launch), profile, and executing stage in campaign.json; append a dispatch event. Record outstanding reports and the obligation to summarize to initiator.

### Launch message template

```text
You are implementing <ticket ID/title>: <ticket URL>.

1. Read <ticket>, <tests/domain docs referenced by project AGENTS.md>.
2. Branch <branch>, base <commit>; work in this thread's bound checkout. Put delivery.md, reproduction scripts, test logs, etc. in <Campaign storage>/deliveries/<ticket-number>/ for retention. For visual tickets put screenshots/recordings in <Campaign storage>/media/<ticket-number>/. If a screenshot tool cannot choose a path, decode its returned image data into that directory.
3. Use /implement if installed, otherwise DISPATCH.md's built-in implementation steps, including Standards/Spec review and revisions. Stop at a local candidate commit: no push, PR, merge, or issue closure.
4. Constraints: no mainline commits; no --no-verify or --no-gpg-sign; do not delete others' files or expose credentials/tokens; <project resource constraints>.
5. No outward dispatch: do not send work to other sessions with t3_thread_launch, create_threads, delegate_task, schedule_task; do not change harness/model/effort. Necessary parallel work uses this harness's native subagents inheriting its configuration. Sole exception: the two review children use the configured review profile explicitly. Report any need for another harness/model to the orchestrator.
6. Authority: decide implementation details and review tradeoffs. Owner decides product behavior/appearance/scope, push/release, deletion, irreversible actions; ask orchestrator if unsure. For owner decisions follow <skill-dir>/INBOX.md and inbox-web/schema.md: write JSON and run node <skill-dir>/inbox-web/inbox.mjs ask <campaignId> <draft.json> directly for the owning Campaign. Local Campaign directory: <directory>. Its own orchestrator forwards answers, never another orchestrator. Continue unaffected work; report per section 7 only if the whole ticket is blocked.
7. Same-turn waiting and reporting: wait in this turn for your own background commands and native subagents; end only at delivery, a blocker, or a decision wait. Block on review completion with t3_thread_wait or a supported waiting task_status; native/background work uses harness waits/completion notifications. Do not sleep-poll; read completed results directly. Harness background completion may not wake a thread after it ends its turn. Resources: node <skill-dir>/scripts/lease.mjs --project <project-settings.md> run <pool> -- <command…>, self-service, no request/release messages. Only after startup verification (branch/worktree/HEAD), on blocker/decision, or validated delivery, use t3_thread_send (mode=queue) to orchestrator <actual dispatching threadId> for a three-to-five-line report: ticket, progress/evidence, problem, next step. Put intermediate review/test/revision progress on ticket/delivery files, not messages. Delivery includes branch, worktree, final commit, separate review conclusions, actual validation, unverified areas, artifact locations. Before delivery comment on the ticket with changes, verified and unverified areas. For a local Markdown tracker append a `## Delivery notes` section to the ticket on the execution branch.
```

## Dispatch discussion

HITL sessions help the owner settle a question, without product code. Select route by content (new design uses design). Use workspaceStrategy root; discussions changing docs get a branch/worktree like delivery tickets.

```text
You host discussion <ticket ID/title>: <URL>. HITL: owner will open this thread; ask one question at a time with options and a recommendation.

1. Read <ticket>, <domain docs>.
2. Record agreed decisions, reasons, and owner's exact words on the ticket.
3. If implementation is needed, use optional /to-tickets or DISPATCH.md's built-in steps to create delivery tickets on the same map with dependencies.
4. Review final conclusions and resulting tickets with optional /code-review or built-in Standards/Spec parallel reviews, revise to 0/0 before reporting. Spec compares original discussion ticket and owner-confirmed decisions. Explicitly select configured review profile for children.
5. No outward dispatch or harness/model/effort changes. Necessary native subagents inherit configuration. Only two-axis review children may use the explicit configured review profile. Report other profile needs to orchestrator.
6. Wait in this turn for your own background/native work; end only at delivery, blocker, or decision wait. Block on reviews using t3_thread_wait or supported waiting task_status; use harness waits for native/background work, no sleep polling. Completion may not wake an ended thread. Report startup with t3_thread_send mode=queue to <actual orchestrator threadId>, three to five lines. After conclusions, ticket split and review 0/0, report conclusions, ticket IDs, dependencies, validation and artifact location to that same target. Intermediate progress goes on ticket/delivery files, not messages.
```

Record as for delivery, using the discussion stage in STATE.md.

## Dispatch research, documentation, modeling

These do not write product code or require /implement. They still own Standards/Spec review to 0/0. Select profile by content and prepare branch/worktree as above. Use the seven-section launch template, replacing section 3 only:

```text
3. Research the ticket (use /research if available), follow project documentation workflow for docs, or define domain terms (optional /domain-modeling). Before delivery run optional /code-review or built-in Standards/Spec review against <base>..HEAD for repo changes and actual external artifact files, revise to 0/0. Stop at local candidate commit: no push, PR, merge, closure.
```

Keep the other six sections, adapting read-list and delivery directory; omit media directory for nonvisual tickets.

## Replace an unrecoverable execution thread

Threads may stop reporting after restart, quota exhaustion, or failed context/model handover. First send one continuation message (SKILL.md modes); if it cannot start or handover fails, do not keep trying. Read final messages/branch/worktree to establish progress. Start a replacement on **the same branch and worktree**, after stopping old edits. Include old threadId, completed/remaining work; continue the same ticket, do not redo it. Replace threadId in campaign.json, log takeover/reason, stop messaging the old thread. Apply quota wait/fallback rules above; code/test/network failures are not exhaustion.

## Check delivery

For final two-axis 0/0 check only: branch SHA matches report, working tree clean, every file listed in the artifact inventory exists. Return mismatches; no screenshot sampling, test reruns, long-log verification, repeated axes, or extra second review. Missing review conclusions go back to execution. Applies to every ticket and discussion conclusion.

After the fixed check, visual product tickets get one acceptance question per ticket through inbox.mjs ask by their owning orchestrator, with media under Campaign media/ (STATE.md). Never route through another orchestrator. Nonvisual tickets wait for closeout summary. Done: three checks agree, two axes zero, required owner acceptance received before merge.

## Merge and clean up

For checked branches (and required owner approval):

1. Merge in dependency order. Later branches first integrate mainline on their own branch, resolve conflicts, rerun affected tests and incremental review in execution, then redeliver.
2. Merge local mainline and follow project post-merge tiers. Only explicitly listed sub-minute checks may run in the orchestrator turn; delegate others, record taskId, resume on completion. Push/closure require passed post-merge checks; push still needs owner authorization or an explicit project grant.
3. Fetch before push. If remote advanced (including another machine's merges), never force push: return to original execution branch/worktree to integrate remote, incrementally validate/review, redeliver, check/merge/check again. Failed push retains worktree and branch until success.
4. After successful authorized push (or successful post-merge checks when the project has no remote or forbids push), verify mainline contains branch and worktree is clean; remove worktree, local branch, this ticket's temporary directories/build artifacts. If deletion authority is unclear, keep and ask through INBOX. Remove the branch and Git worktree registration in the merge round. Occupied empty directories wait for closeout; archiving a thread may not release process handles. Do not force removal of active files.
5. Set merged stage in campaign.json; log merge and every cleanup.
For local Markdown trackers, close approved tickets by appending `## Status` with `Closed`, merge SHA and validation. The orchestrator commits tracker updates on a temporary branch and fast-forwards mainline; never commit directly on mainline.

6. Visual product tickets approved by owner close after checks pass and push succeeds, commenting merge SHA/validation. Others (nonvisual product, tooling, test infrastructure, documentation) stay merged for owner closeout approval. If project grants category closure, still require successful checks/push and comment merge SHA/validation.

Done: all seven launch sections include actual reporting target/queue, execution waiting exception, Campaign ID/draft location, lease usage. Outstanding reports and initiator obligation recorded. Replacements stop old writer and retain branch/worktree/progress. Merges stay within authorization, delegated checks have results, cleanup paths verified, closure follows permission. The six hard rules in SKILL.md apply throughout; execution must not apply the orchestrator's early-turn-ending rule.
