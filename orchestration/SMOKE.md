# Setup smoke Campaign

No GitHub repository or issue is needed. Use local Markdown tickets as the tracker (DISPATCH.md requires IDs, criteria and blockers, not GitHub). Keep all sandbox changes inside its generated directory. Do not use a product repository for this example.

## Prepare and rehearse

```text
node <skill-dir>/scripts/smoke.mjs prepare <existing-temporary-parent>
node <skill-dir>/scripts/smoke.mjs dry-run <returned-root>
```

`prepare` creates a uniquely named local git repository with main, tickets/1.md (owner question) and tickets/2.md (visual delivery, blocked by ticket 1), a separate Campaign storage directory with two draft questions, a non-secret PNG fixture, and a sandbox marker. It commits the tracker using a repository-local test identity and respects configured signing/hooks. No remotes or GitHub objects are created. The fixture is for dry-run only, never evidence of the visual product.

`dry-run` is a one-shot rehearsal on a newly prepared sandbox: it starts an ephemeral local Inbox on OS-assigned ports, simulates execution/owner/report/review events, exercises the Inbox question and acceptance lifecycle, makes and merges two local branches, simulates owner closeout approval and unregisters the Campaign. It stops its server in finally. `dry-run.json` clearly labels every simulated part and records zero real threads/GitHub issues. It does not verify T3 transport, a browser, real review, mobile push or human judgement. Prepare another sandbox for a second rehearsal or live smoke.

## Live smoke (orchestrator only)

1. Prepare a **fresh** sandbox; do not reuse a completed dry-run. In T3 select/create the project for its returned `repository`, not the skill's development project. Run setup's project questions for this repository and the parent of its returned `campaign` as Campaign storage. The returned `campaign` (`<root>/storage`) is already the Campaign directory; register it directly, without another setup-smoke suffix. Select explicit live profiles; make `tickets/*.md` the tracker. Record real projectId, initiator and orchestrator thread IDs in campaign.json. Do not open tickets on GitHub.
2. Follow SKILL.md Start: check configured service health, register the returned Campaign storage, create its webhook and patrol with T3, record task IDs only. Pass the webhook to `set-webhook` privately. For isolated testing use a temporary HOME and unused ports; do not replace another Campaign's service/configuration.
3. Dispatch local-1 using DISPATCH.md's execution template, a fixed worktree inside this sandbox: the orchestrator first runs `git -C <repository> worktree add -b smoke/local-1 <root>/worktrees/local-1 main`, then launches using `existing_worktree` bound to that path (repeat for local-2 after local-1 merges). Use explicit projectId, model/options and this orchestrator's report target. Give it tickets/1.md and the real Campaign ID. Drafts are skeletons: translate all owner-facing text into the owner's language and complete background, recommendation/reason, blocking status and option consequences per INBOX.md before submission. It substitutes its thread ID in the decision draft and submits through `inbox.mjs ask`. The owner answers Hello/Welcome in Inbox; process pending → ack → relay → forward → close. Verify this submission wakes the orchestrator through T3 Connect and inspect the question's `push` result in inbox.json after the batch delay (up to two minutes). Verify successful push-service count/time separately from webhook notify state; owner confirmation of phone receipt supplements this record. Execution completes its chosen greeting and tests and self-reviews to Standards/Spec 0/0, then reports.
4. Light-check its delivery and merge local-1 into the **sandbox's main**. Remove its branch and Git worktree registration in the same round; an occupied empty directory is an expected leftover until its holding process exits, even after thread archive. The frontier now admits local-2. Dispatch it to create the visual greeting following tickets/2.md; replace the PNG fixture with a real screenshot in a new media/local-2/<batch>/ path and update the acceptance draft to that path. Execution reports after its own 0/0 review. Orchestrator submits its acceptance request to Inbox; owner passes or requests rework. Merge local-2 only after owner passes, then clean its worktree/branch.
5. Submit a closeout acceptance question listing both local ticket results and verified/unverified checks, using the normal summary process. After owner approval, close both local Markdown tickets using DISPATCH.md's `## Status` convention on a temporary closeout branch, commit and fast-forward main (no direct main commit), archive Campaign state/deliveries/uploads, unregister it, remove its webhook/patrol tasks, and report back to the initiator. T3 thread records are settled/archived by the orchestrator. No GitHub closure or push is involved.

Done: two commits trace to real execution threads; answer reaches local-1; actual screenshot approval gates local-2; both local merges and cleanup occur; webhook/patrol are removed and initiator has a report. A script's simulated success does not satisfy these checks.

## Cleanup

First confirm no live threads, processes, worktrees, registrations or scheduled tasks still use this sandbox. Preserve needed public evidence outside it; do not copy private/. After the owner approves deletion of this disposable example, run:

```text
node <skill-dir>/scripts/smoke.mjs cleanup <returned-root>
```

Cleanup resolves the absolute path and verifies the generated marker, original path and directory prefix before recursively removing **that sandbox only**, including its archive. It refuses unrelated paths and symlink roots. It does not unregister live Campaigns or delete T3 tasks for you. Occupied empty worktree directories may remain until T3/harness processes exit; record them, do not repeatedly retry deletion or stop unrelated processes. If retaining the archive, skip full cleanup: use the normal STATE.md closeout to delete only verified media and merged worktrees, and keep the Campaign records. Never delete another repository, real HOME or externally supplied storage.
