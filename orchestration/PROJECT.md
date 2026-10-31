# Project orchestration settings

Each project keeps concrete values in `docs/agents/orchestration.md`, linked from AGENTS.md. Do not copy general workflow. No global instruction file is required. Owner display name is a project setting. Dispatch routes and concurrency limits are not: they live in the Inbox routing settings (decision 44), and a project records only its overrides in the Campaign override file described below. Inbox interface language/display is managed separately.

## Template

````markdown
# Orchestration settings

This project uses /orchestration.

## Storage and capacity
- Campaign storage: <absolute path for each machine>
- Disk warning threshold: <available GB>
- Concurrency limits: not set here; read them from Inbox routing settings (the Campaign override may only tighten them)

## Owner and routing
- Owner display name: you
- Orchestrator: <the session model the owner picks in the composer; the discussion route's first tier is the default>
- Routes: not set here; the discussion, design, visual, research, code, adjudication, review and housekeeping routes live in Inbox routing settings
- Campaign overrides: <none, or the override file below with the rows this project changes>

## Permissions
- <specific restrictions/grants beyond skill defaults>
- <example: documentation tickets may close after merge; push still requires owner approval>

## Resource pools

```json
{
  "resourceNamespace": "unique-project-short-name",
  "resourcePools": {
    "build": [
      {"name":"a", "directory":"/absolute/local/path/build-a"},
      {"name":"b", "directory":"/absolute/local/path/build-b"}
    ],
    "device": [{"name":"phone"}]
  }
}
```

## Tests
- <test tiers and post-merge check documentation>
- <optional explicit list of post-merge checks taking under one minute allowed directly in an orchestrator turn; delegate all others>

## Housekeeping
- enabled: <true|false>
- mergeTargets: <local integration branch names only; never the default branch>
- neverTouch: <absolute paths and globs the session must not delete or modify>
- residentWorktrees: <paths kept even after merge, e.g. daily-job checkouts>
- sharedBuildDirs: <report occupancy only; never delete>
- diskThresholds: <volume → { warningGB, criticalGB }>
- sizeCommand: <fast size command; never full-volume du>
- tempRoot: <absolute temp directory for detached merge checks>
- cleanupLog: <absolute log path>
- toolsDir: <project tools for cleanup scripts>
- mergePrecheck: <command or empty>
- mergeRiskTriggers: <`default`, or comma-separated globs that force the HK zero-context recheck (replace the `scripts/merge-risk.mjs` list; include `default` to extend it, e.g. `core/shared/**, default`)>
- postMergeBatch: 1 (batching is not implemented; values > 1 are rejected)
- postMergeChecks: <commands run in detached worktree after merge>
- chores: <allowed chore categories>

## Orchestrator mode
- kind: t3-thread (default) | external
- external label: <orchestratorRef if external; private file under ~/.agents/orchestration/private/orchestrators/>
````

Done: concrete storage, permissions, resources, tests, routing overrides, optional housekeeping and orchestrator mode; resource JSON readable by script. Routes and limits are referenced, not copied.

## Routing overrides without fixed model names

The global routing table lives in `~/.agents/orchestration/routing.json` and is shared by every machine through the hub. This project does not repeat it. What this project may set is one Campaign override file, `<campaign-dir>/routing.json` under the registered Campaign directory, holding only the rows it actually changes.

At initial setup call `orchestrator_capabilities`, then pipe the same JSON into `node inbox.mjs catalog-write`. Choose available provider instances, model IDs and supported option IDs/values from that snapshot; do not guess IDs or silently use a CLI default. A tier contains the provider instance, model, and explicit options (reasoning/effort and speed/service tier where supported). The orchestrator's own session normally uses the first `discussion` tier; the owner may choose another in the composer. Dispatch reads only the configured routes; the imported table is a starting point, not a dependency on any named model.

Write overrides through Inbox routing settings — the settings page (`?view=routing`), or from scripts `PUT /api/routing` with `{layer: "campaign", campaign: "<campaignId>", patch}` ([inbox-web/schema.md](inbox-web/schema.md)) — never by hand-editing the file. Layers resolve global → machine → Campaign, an override stores only changed fields, and limits may only tighten. Read the result back with `node inbox.mjs route <campaignId> <type>` and `node inbox.mjs routes <campaignId>`; both report which layer each tier and limit came from. Existing tickets keep the tier they were dispatched with.

Route types are discussion, design, visual, research, code, adjudication, review and housekeeping (the housekeeping session only, not tickets); each has an ordered tier list whose first entry is the preferred one.

Classify by the hardest part. All design work uses design, including form, layout, motion, and new visual decisions. Visual implementation of an established design (3D, materials, rendering, visual adjudication) uses visual; non-visual adjudication uses adjudication. Tests/numbers usually indicate code. Editing a page to match existing style without new layout is code even when screenshots are used. Classify mixed tickets by their hardest part; do not split to select models. Device-only acceptance operates devices, captures evidence, records defects, without code. Subscription channels are not harnesses: record actual provider and exact catalog model ID.

Campaign override file shape (only changed fields; placeholders from the catalog):

```json
{
  "routes": {
    "design": {"tiers": [{"instanceId":"<catalog-provider>","model":"<catalog-design-model>","options":[{"id":"<effort-option>","value":"<supported-high-value>"}]}]},
    "code": {"tiers": [{"instanceId":"<catalog-provider>","model":"<catalog-model>","options":[{"id":"<effort-option>","value":"<supported-value>"}]}]}
  },
  "limits": {"execution": 6, "design": 1}
}
```

### Move an existing dispatch configuration

A project that already keeps a pinned dispatch configuration with `projectOverrides` moves it once, and the skill does not do it for them:

1. Seed the shared table: `node inbox.mjs routing-import` on one machine, then confirm the hub synced it to the others.
2. Copy each overridden route row into this Campaign's override file through Inbox routing settings (Campaign layer), one row per route type. Rows identical to the global table are dropped, not copied.
3. Move the capacity numbers into the Campaign `limits`; they may only tighten the global values, so a larger project number needs an owner decision on the global layer instead.
4. Fix quota marks for tiers the project knows are exhausted (`node inbox.mjs quota mark <instanceId/model> --resume <ISO>`).
5. Replace the old table text in project settings with the override pointer, then check `node inbox.mjs routes <campaignId>` against the previous configuration and keep the pinned file until the Campaign ends.

Quota defaults are in DISPATCH.md: on confirmed exhaustion, both new work and already dispatched work move to the next tier immediately; do not wait for reset. The orchestrator stops the previous writer before handing over the same ticket and worktree. Keep these defaults unless the owner explicitly changes them. Record provider-reported reset times, not estimates.

## Use resource pools

First read the project resource adapter. The following lease commands are reference for projects selecting lease.mjs, not a universal patrol or dispatch step. Use the project adapter for acquisition and status; never mix independent lock systems. The adapter also states whether resource handover reports are needed. Self-service adapters send no acquisition/release reports.

Node ≥22, standard library only, Windows, Linux, and macOS supported. From repository root:

```text
node <skill-dir>/scripts/lease.mjs run build -- node tools/build.mjs
node <skill-dir>/scripts/lease.mjs status
node <skill-dir>/scripts/lease.mjs --project <project-settings.md> run device -- <command…>
```

By default read the JSON block containing resourcePools in docs/agents/orchestration.md under cwd. Machines may maintain local copies via --project. resourceNamespace must be unique across projects and identical across all worktrees, Campaigns, settings copies of one project; lane definitions must agree. Locks are shared by same user on one machine, not distributed across machines. status lists all defined pools; orchestrator does not allocate tickets individually. The orchestrator does not hold device locks; only execution tickets that need a device take and release the corresponding lock.

Script takes the first free lane; if all occupied it fails without starting the child, retry later. Wrapper process owns the lock, waits for the child, releases on exit; OS releases on crash/forced termination. Do not delete lock files or return manually. Do not detach children that keep using resources. Killing wrapper may leave descendants; stop associated work with project tools before retrying if necessary.

Children receive ORCH_LEASE_POOL, ORCH_LEASE_LANE, ORCH_LEASE_DIR. directory is optional (e.g. devices); if present it must be an absolute local path. Script passes variables only, without creating directories/changing cwd. Multiple build lanes need different directories, and builds must use ORCH_LEASE_DIR. On Windows, `.cmd`/`.bat` and extensionless names (e.g. bare `npm` → `npm.cmd`) run via shell so Node can start them; `.exe` and Linux/macOS stay direct spawn. `.ps1` still needs an explicit interpreter, e.g. `-- powershell.exe -NoProfile -File tools/build.ps1`. Child exit code passes through; signals produce nonzero exit.

Done: constrained work uses the selected project adapter and assigned lane/directory; query status through that same adapter. Self-service resources create no request/release messages.
