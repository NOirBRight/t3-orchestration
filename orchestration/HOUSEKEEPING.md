# Housekeeping session

Optional per-Campaign resident session for work that is **not a ticket**: local merges onto integration branches, disk cleanup, read-only investigation, operations rollouts that do not kill the HK host process, and project-listed chores. The orchestrator decides what to do; the housekeeping session only executes. With no request it stays idle.

Design basis: `docs/design/housekeeping.md`, decisions 46–47 and 53 (including the 2026-10-28 owner amendment on message modes, `ops`, and tracking). An example project’s existing `housekeeping` field stays compatible; migrating that project’s brief is deferred (decision 46).

## Role

| Is | Is not |
| --- | --- |
| One top-level thread per Campaign (`t3_thread_launch`) | A second orchestrator (no dispatch, no Inbox decisions) |
| Long-lived context for merge/disk patterns | An execution ticket (no product code, no two-axis review) |
| Request-driven only | A `delegate_task` child (has its own thread and branch) |

**Does not count toward `execution` / `design` limits** (`countsTowardLimits` must be `false`; missing means false). At most one housekeeping session per Campaign (decision 46).

## Create (lazy)

Create on first need (disk pressure, integration merge, or an explicit owner request)—not at Campaign start (decision 46).

1. Orchestrator creates a small branch/worktree for logs and scripts only (no product changes), same prepare steps as DISPATCH.md “Dispatch one ticket”.
2. **Route:** run `node inbox.mjs route <campaignId> housekeeping` and use the first entry in `tiers` for the HK thread's provider/model/options (decision 53; edit it in Inbox routing settings like other route types). A routing document without a `housekeeping` row resolves it from its own `research` route, the previous behavior. Record the tier and source layer in `campaign.json.housekeeping.model`. On quota exhaustion follow DISPATCH.md like any route.
3. Launch with the template below. Record `housekeeping` on campaign.json (STATE.md). Do not increment running ticket counts against limits.
4. No outward dispatch from the housekeeping session (same ban as execution tickets; no review exception).

### Launch message template

```text
You are the housekeeping session for Campaign <campaignId>.
Orchestrator threadId: <id> (report with t3_thread_send mode=queue only).
Hard rules: HOUSEKEEPING.md. Project settings: docs/agents/orchestration.md § Housekeeping.
You do not count toward execution/design limits. You are not a ticket.
With no request, stay idle. Do not invent work. Do not dispatch outward.
Request format and evidence directory: HOUSEKEEPING.md.
```

## Message mode (decision 46 owner amendment 2026-10-28)

Orchestrator → housekeeping (resolve with [scripts/worker-send.mjs](scripts/worker-send.mjs)):

| What you are sending | Mode | Flag |
| --- | --- | --- |
| **New / different matter** (new `HK-n`, or unrelated work that must not cut into the current plan) | `queue` (`auto` if idle) | Required: `newMatter: true` / `--hk-new-matter` |
| **Instruction or correction on the HK session's current task** | `steer` while running; `auto` if idle | No new-matter flag; never `queue` |

The `queue` exception is **HK-only and only for new separate matters**. Workers/execution tickets still never queue (decision 38 / 2026-10-28). Do not `t3_thread_interrupt` a merge, delete, or rollout mid-flight; correct them with steer on the current task, or queue a follow-up matter after it finishes.

Housekeeping → orchestrator: `mode=queue`, three to five lines. Evidence under `housekeeping/<HK-id>/`.

## Request format

```text
HK-<n> <type>
Campaign: <campaignId>   orchestrator threadId: <id> (report queue)
Goal: <one line>
Params: <type-specific; merge: branch, delivery SHA, verified base, tier from merge-risk.mjs>
Auth: <none | Inbox <id> option <key>; paths in housekeeping/HK-<n>/authorized.txt>
Report: housekeeping/HK-<n>/report.md; message three to five lines only
```

Types: `merge` | `disk` | `investigate` | `chore` | `ops`. One request runs at a time; further **new** matters use `queue` (`auto` if idle) with `--hk-new-matter`. Re-sending the same `HK-n` is idempotent: if `housekeeping/HK-n/` already has a result, restate it.

### Tracking (no HK todo file)

Do **not** keep a separate housekeeping todo-list file. Each `HK-n` is sent as a message and tracked only through:

1. `awaitingReports` — add `HK-<n>` when sent; remove after the report is handled.
2. `events.log` — one line per milestone (no secrets, no long logs):

```text
<ISO-time> HK-<n> hk-sent type=<type> thread=<hkThreadId> evidence=housekeeping/HK-<n>/
<ISO-time> HK-<n> hk-done type=<type> result=<one-line> evidence=housekeeping/HK-<n>/report.md
```

Optional related lines: `hk-replace` (session replaced), `hk-continue` (patrol resume). Patrol lists outstanding HK items as: ids in `awaitingReports` matching `HK-*` that have `hk-sent` without a later `hk-done` (HOUSEKEEPING.md / PATROL.md). Do not store request history arrays in campaign.json.

### ops

Params: goal, machine list (or “all registered”), commands, expected `skillFolderHash` when rolling out the skill.

Allowed under `ops`: skill rollouts such as `npx skills update orchestration -g` / `npx skills add <source>/orchestration -g -a '*' -y`, cleanup, and upgrades that **do not** restart the T3/Codex (or other harness) process hosting **this** HK thread.

**Not** HK `ops` — stay with the external/T3 orchestrator after owner approval, and log the decision in `events.log`: any T3/Codex/harness restart or host reboot that would kill the HK thread itself.

**Post-merge skill rollout rule:** after a merge to the skill repo’s default branch (`main`) is **pushed**, rolling the new skill out to **every registered machine** is one `ops` HK request. Done when each machine reports the same `skillFolderHash` (content hash of the installed orchestration skill folder, e.g. under `~/.agents/skills/orchestration`) matching the expected hash for that release. Record per-machine hashes under `housekeeping/HK-<n>/` and summarize in the report.

Hard rules below still apply (no push from HK, no tags, no default-branch merge).

## Hard rules (always)

1. No push to any remote.
2. No merge into `main` / `master` / the project default branch. `merge` only updates branches listed in project `housekeeping.mergeTargets`. Default-branch merges stay with the orchestrator (decision 7).
3. No tags.
4. No issue/ticket closure or tracker status changes.
5. No delete of retained build data or worktrees unless the request carries explicit owner authorization (Inbox question id + option + path list). Authorize path-by-path; one-shot per request. Exception: “directly reclaimable” worktrees (below) may use `git worktree remove` only, keeping the branch.
6. Never touch: project never-touch list, `~/.agents/orchestration/private/`, other sessions’ locks/processes, other Campaigns, shared build dirs (report occupancy only).
7. Never read or print secrets, credentials, webhook URLs; no device serials in files.
8. No outward dispatch; no harness/model/effort change.
9. Do not edit any ticket worktree. Merges use object/ref ops (`merge-tree` / `commit-tree` / `update-ref` with old value). Checks run in a fresh detached worktree and delete it afterward.
10. Resolve paths to absolute form and assert they fall inside the authorized set before delete; on failure log and leave in place.
11. Every ref update carries the expected old value; mismatch → stop and report.
12. If any rule might be violated, do nothing and report.

## Practices

### merge

Params: ticket, branch, delivery SHA, verified base SHA, target integration branch, post-merge checks.

1. Assert delivery SHA is that branch’s HEAD; target ∈ `mergeTargets`.
2. Run the scripted precheck (`scripts/merge-risk.mjs`, below) and the project merge precheck if configured; else `git merge-tree --write-tree`. Run the zero-context recheck only when the precheck returns `tier: recheck`.
3. Clean: `commit-tree` + `update-ref` with old value (fast-forward same).
4. Code conflicts → stop, list files, return to orchestrator/ticket. Mechanical doc-only conflicts may resolve in a temp worktree keeping both sides.
5. Post-merge checks in detached worktree under project `tempRoot`, once per merge.
6. On new failures vs baseline: if target still equals C, roll back with `update-ref`; else leave and report.
7. Delete temp worktree after absolute-path assert.
8. Report new SHA, check summary, log path. Push/close stay with orchestrator per DISPATCH.md.

### Risk-tiered merge checks (decision 53)

Before HK merges, each candidate already has worker self-test plus Standards/Spec review and the orchestrator's evidence check. HK adds:

| Candidate | HK pre-merge | Post-merge |
| --- | --- | --- |
| Touches a **risk trigger** path, or the target **moved since verification** | Scripted precheck + **zero-context AI recheck** (a fresh-context reviewer reads the diff against the target, no worker context). Moved base also needs re-verify by the ticket first. | Full suite |
| Anything else | **Scripted precheck only**, no extra AI | Full suite |

Scripted precheck (`node <skill-dir>/scripts/merge-risk.mjs --repo <repo> --target <target> --branch <branch> --candidate <sha> --verified-base <sha> [--project <docs/agents/orchestration.md> | --triggers-file <json>]`). `--verified-base` is required; unknown or misspelled options (e.g. `--verified_base`) are usage errors. It moves no ref and touches no worktree or index; `git merge-tree --write-tree` does write unreferenced loose objects into the repo's object store (pruned by `git gc`), so it is not strictly read-only. Needs git 2.38+.
1. Assert candidate SHA equals branch HEAD.
2. `git merge-tree --write-tree` conflict check against the current target.
3. `git diff --check` on the candidate range.
4. File list (`--no-renames`, so both ends of a rename are scanned) and path-risk scan against the triggers; compare verified base with the current target.

Always check the **exit code**, not only the JSON: `0` may proceed per `tier`; `1` precheck stop (`stops`: `merge-conflict` with `conflicts`, `diff-check`, `candidate-not-branch-head`); `2` usage/config error (missing or unknown option, bad project setting, `postMergeBatch` > 1); `3` tool error (git failed or too old, unknown ref). Stdout is always one JSON object; on `2`/`3` it is `{ ok:false, error:{ type, message } }` with `type` `usage`, `config`, `unimplemented` or `tool`. A tool error is never a merge conflict: fix the environment and rerun. Any non-zero exit → do not merge; stop and report. `tier` is `recheck` or `scripted`; `reasons` lists `risk-path` and/or `base-moved`; `triggerSource` says which list was used.

Risk triggers: pass the project settings file with `--project`; the script reads `mergeRiskTriggers` from its `## Housekeeping` section (PROJECT.md). Value is `default` or a comma-separated glob list (backticks optional); a list replaces the defaults unless it contains `default`, e.g. `core/shared/**, default` adds the project's core shared modules to the built-in list. Unset → the default list: shared test config, lists and runners (`package.json`, `tests/list*.txt`, `test/manifest.json`, `tools/test_*.py`, `tools/test-*.ps1`, test/vite/playwright configs), lockfiles and dependency manifests (npm, yarn, pnpm, Cargo, `go.mod`, `pyproject.toml`, `requirements*.txt`, `.npmrc`), build/release/signing scripts (named build scripts, `Makefile`, Gradle, `Dockerfile`, root `build.rs`), CI (`.github/**`, GitLab, CircleCI, `Jenkinsfile`, `azure-pipelines*.yml`), agent rules (`AGENTS.md`, `.cursor/rules/**`, `RULES-*.md`) and `orchestration/scripts/**` (including `merge-risk.mjs` itself).

Batching is not implemented: `postMergeBatch` must be `1` (one full suite after every merge). `merge-risk.mjs --project` rejects a larger value as `unimplemented` (exit 2).

### disk

1. Read free space on configured volumes. Below warning → candidates list; below critical → report immediately.
2. Size with the project’s fast command only; never full-volume `du`.
3. **Directly reclaimable** worktree (all must hold): branch already in a mergeTarget or default remote ref; working tree only tool noise (project-defined); no live T3 thread on it; not product root or orchestrator worktree; not a resident worktree. Then `git worktree remove`, keep branch.
4. Everything else → `candidates.md` for owner decide via Inbox; execute only with Auth line + `authorized.txt`.
5. Log every deletion to the project cleanup log.

### investigate

Read-only. Write `report.md` with conclusion, evidence, gaps, suggestions. No product edits.

### chore

Only categories in project `housekeeping.chores`, or a one-off with explicit orchestrator auth stating goal, bounds, and reversibility.

### ops

See Message mode § ops above. Light check: every targeted machine listed in the report; `skillFolderHash` values identical when the goal is a skill rollout; no host-process restart claimed without orchestrator+owner path.

## Light check (orchestrator)

- `merge`: reported SHA is on the target branch; check line and log path exist.
- `disk`: cleanup log exists; freed amount matches report.
- `ops`: machine list complete; rollout hashes match when required; `hk-done` logged and `HK-*` removed from `awaitingReports`.
Do not re-run checks (same spirit as DISPATCH.md “Check delivery”).

## Patrol and takeover

- PATROL item 3: treat `HK-*` in `awaitingReports` like in-flight work. List outstanding HK items from `awaitingReports` ∪ (`hk-sent` without later `hk-done` in events.log). Interrupted/failed/cancelled with no report → one current-task continue with `mode=auto` (idle/terminal) or `steer` if still running — not a new-matter queue; if unrecoverable, replace on the same branch and log old threadId (`hk-replace`).
- PATROL item 4 (when housekeeping enabled): orchestrator only reads free space; if below warning and no open `disk` request / `HK-*` disk entry, send one **new-matter** `disk` request (`queue` / `auto` if idle, `--hk-new-matter`). Do not clean or list candidates itself. Campaigns without housekeeping keep the previous patrol disk wording.
- Takeover: notify housekeeping of the new orchestrator threadId / report target. If HK is idle, `auto`; if running on a task, `steer` (current-task correction). Only use new-matter `queue` when the notify must not cut into an in-flight merge/delete/rollout and can wait — prefer steer so the report target updates immediately when safe.
- Close out: archive the housekeeping thread with execution threads; clear `housekeeping.disk.pending` first if set; no open `HK-*` in `awaitingReports`.

## Project settings (`docs/agents/orchestration.md`)

See PROJECT.md § Housekeeping for the field list (`mergeTargets`, `neverTouch`, `residentWorktrees`, `sharedBuildDirs`, `diskThresholds`, `sizeCommand`, `tempRoot`, `cleanupLog`, `toolsDir`, `mergePrecheck`, `mergeRiskTriggers`, `postMergeBatch`, `chores`, `postMergeChecks`).

## Defaults recorded (no further owner wait)

| Topic | Default |
| --- | --- |
| Route type | `housekeeping` route in Inbox routing settings (decision 53); missing row falls back to the document's `research` route |
| Default-branch merge | Orchestrator only |
| Post-merge small cleanup | Orchestrator keeps worktree/branch remove after verified merge; housekeeping handles bulk disk and integration merges |
| Progress board | Not shown (not a ticket) |
| Create timing | Lazy (confirmed) |
| PM brief migration | Deferred (confirmed) |
