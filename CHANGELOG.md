# Changelog

## Unreleased

## 0.1.4

- Add `--carry-over-pending` for handoffs that retain awaiting reports and pending Inbox items, with an inventory in the plan and record and report-to instructions for pending workers.

## 0.1.3

- Routing compatibility: `housekeeping` is derived from `research` in memory and written to routing.json (and to peer sync payloads) only when explicitly overridden, so pre-0.1.3 readers keep loading documents and syncs. Unknown route types now warn and are kept instead of failing the whole document. Incoming sync globals without `housekeeping` are backfilled.
- `housekeeping` follows `research` at machine and Campaign layers too unless a layer sets `housekeeping` explicitly (most specific explicit choice wins; otherwise the resolved research route, reported with `derivedFrom: research`).
- `merge-risk.mjs` fails closed: `--verified-base` required; unknown/misspelled/duplicate options are usage errors; stdout is always JSON (`ok:false` + typed `error` on failure); exit codes 0 proceed / 1 precheck stop / 2 usage-config / 3 tool error, so old git or bad refs are no longer reported as merge conflicts. Changed files use `--no-renames` (both rename ends scanned). Docs correct the read-only claim (merge-tree writes unreferenced loose objects; no ref/index/worktree change).
- `mergeRiskTriggers` implemented: `merge-risk.mjs --project <settings.md>` reads it from `## Housekeeping` (`default`, a glob list, or a list including `default` to extend). `postMergeBatch` batching is not implemented: only `1` is accepted, larger values are rejected as `unimplemented`; docs updated.
- Default risk triggers widened (test lists/runners, yarn/pnpm/Cargo/go/Python manifests, `.npmrc`, Dockerfile, vite/playwright configs, Jenkins/Azure CI, `AGENTS.md`, `.cursor/rules`, `RULES-*.md`, `orchestration/scripts/**`); `**/build.*` replaced by named build scripts so `src/build.rs` no longer matches.
- Release manifest ships `merge-risk.mjs` (+ test), `cli-args.mjs`, `ticket-ref.mjs`, `campaign-write.mjs`, `dispatch-template.mjs`, `handoff.mjs`, `worker-send.mjs`; a release test asserts every script referenced in shipped docs, and every relative import of a shipped script, is in the manifest.

## 0.1.2

- Risk-tiered merge checks (decision 53): `scripts/merge-risk.mjs` scripted precheck (candidate SHA, merge-tree, diff --check, path-risk scan, base-moved). HK zero-context recheck only for risk-trigger paths (`mergeRiskTriggers`) or a moved base; post-merge full suite may be batched (`postMergeBatch`) with bisect-and-revert of only the culprit.
- `housekeeping` route type in Inbox routing settings (`inbox.mjs route <campaign> housekeeping`, routing page card); documents without it resolve from their `research` route. HOUSEKEEPING.md launch resolves the HK model from it.
- External mode report template is required in EXTERNAL-ORCHESTRATOR.md (startup/progress/blocker|question/delivery, orch-report/1 fields, `report.mjs` send, loopback forwarder + webhook path shapes, orchestrator `verify` + SHA/clean tree/tests/reviews). DISPATCH.md links it (no second copy). `dispatch-template.mjs check-message --orchestrator-kind external` (or `--campaign-dir`) refuses messages missing the four phases, `report.mjs`, or verify markers; `external-section` helper fills a passing draft.
- `t3_thread_launch.title` must be `id：short title` from campaign.json (`dispatch-template.mjs` / `route --ticket` → `threadTitle`); launch messages must include Waiting and reporting with orch-report/1 startup|blocker|delivery and `report.mjs` (`check-message` refuses gaps). Misnamed threads: `t3_thread_update` rename.
- Ticket file + launch templates in DISPATCH.md; all reports/patrol/Inbox lines name tickets as `id：short title`. `campaign-write.mjs` refuses blank `tickets[].title`; ticketed `orch-report/1` bodies need `title` (`ticket-ref.mjs` / `report.mjs`).
- Housekeeping message modes (decision 46 amendment 2026-10-28): new separate matter → `queue` (`auto` if idle) with `worker-send --hk-new-matter`; current-task instruction → `steer`/`auto`. `ops` HK type; `hk-sent`/`hk-done` tracking (no HK todo file); post-merge skill rollout verified by `skillFolderHash`. `scripts/campaign-write.mjs` checked writer (stage enum, countsTowardLimits, no secrets, backup + atomic).
- Sanctioned mid-Campaign orchestrator handoff: `scripts/handoff.mjs plan|apply|revert` (atomic campaign.json backup, webhook label rebind, T3 schedule instructions, report-to steers, revert record, safety refusals, forwarder acceptance docs).
- Never-queue worker delivery (owner 2026-10-28): running execution threads get `t3_thread_send mode=steer` (idle `auto`); `scripts/worker-send.mjs` refuses/flags `queue` for workers and verifies active-run delivery. Orchestrator reports stay queue-only; HK queue only for new matters.
- Optional chat relay (default off): signed outbound events, bearer inbound on existing submit/item/upload APIs, first-writer 409 for relay, web may override.
- Housekeeping session skill docs (not counted toward concurrency limits).
- External orchestrator mode docs and signed queue-only `report.mjs` helper.

## 0.1.1 - Release candidate

- Isolate Campaign media from Inbox permissions and retain edits made during submission.
- Keep withdrawals pending until explicitly handled; reject stale acknowledgement and closure.
- Persist normal push batches across service restarts and save Campaign removal before notifying the orchestrator.
- Replace running Windows watchdogs during installation and stop them during uninstall, including legacy launchers.
- Correct upgrade, macOS recovery, mobile device setup and LAN authentication instructions; align quota handover with immediate fallback.

Publication remains gated on the release acceptance record; automated checks do not establish phone receipt or login/reboot behavior.

## 0.1.0 - Initial release

- T3 Code Campaign orchestration with ticket routing, two-axis review, handover and patrol.
- Bilingual decision and acceptance Inbox with authenticated LAN access, remote methods and web push.
- Guided setup, doctor, Windows/Linux/macOS autostart and a disposable local smoke Campaign.
