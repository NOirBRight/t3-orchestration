# Project orchestration settings

Each project keeps concrete values in `docs/agents/orchestration.md`, linked from AGENTS.md. Do not copy general workflow. No global instruction file is required. Routing and owner display name are **project settings**, not machine.json fields; agents read them as instructions. Inbox interface language/display is managed separately.

## Template

````markdown
# Orchestration settings

This project uses /orchestration.

## Storage and capacity
- Campaign storage: <absolute path for each machine>
- Disk warning threshold: <available GB>
- Running tickets: 8 (may be reduced; owner approves exceeding it)
- Of those, tickets needing new design: <limit; 0 disables new-design dispatch>

## Owner and routing
- Owner display name: you
- Orchestrator: <providerInstanceId, model ID, explicit options from live catalog; owner may choose another>
- Profiles and routes: <fill using procedure below>

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
````

Done: concrete storage, capacity, permissions, resources, tests, routing; resource JSON readable by script.

## Configure routing without fixed model names

At initial setup call `orchestrator_capabilities`. Choose available provider instances, model IDs, supported option IDs/values from that actual catalog. Agree concrete profiles with the owner and write them in project settings before dispatch; do not guess IDs or silently use a CLI default. A profile contains providerInstanceId, model, and explicit options (reasoning/effort and speed/service tier where supported). Also select the orchestrator profile; the owner may choose another manually. No named model is a built-in dependency.

Give each configurable default category a primary and designated fallback profile:

| Route | Ticket's hardest part | Default selection intent |
|---|---|---|
| design | Modeling, interface design, layout, animation, frontend requiring new design | Strong design reasoning, high effort |
| research | Exploration, research, batch work, documents, writing, search, device-only acceptance | Efficient batch/research profile, high effort |
| code | Backend, debugging, code, frontend following existing design | Coding profile, medium effort |
| adjudication | Consolidation, second review, false-positive removal, tradeoffs, owner-facing findings | Strong reasoning profile, high effort |
| review | Standards and Spec review children | Explicit adjudication/review profile, high effort |

High/medium describe selection intent: record the corresponding supported option/value rather than sending an unsupported generic option. Agree alternatives with the owner if unavailable. Batch workers must not adjudicate their own results; consolidation/second review use the adjudication/review profile. Running tickets do not change model just because the table changes.

Classify design versus code by acceptance evidence: visual judgement means design; tests/numbers mean code. Editing a page to match existing style without new layout is code even when screenshots are used. Classify mixed tickets by their hardest part; do not split to select models. Device-only acceptance operates devices, captures evidence, records defects, without code. Subscription channels are not harnesses: record actual provider and exact catalog model ID.

Example shape (replace all placeholders from the catalog; instruction format, not application-parsed configuration):

```json
{
  "profiles": {
    "coding":{"providerInstanceId":"<catalog-provider>","model":"<catalog-model>","options":{"<effort-option>":"<supported-value>"}},
    "reviewing":{"providerInstanceId":"<catalog-provider>","model":"<catalog-review-model>","options":{"<effort-option>":"<supported-high-value>"}},
    "backup":{"providerInstanceId":"<catalog-fallback-provider>","model":"<catalog-fallback-model>","options":{"<effort-option>":"<supported-value>"}}
  },
  "routes": {
    "design":{"primary":"<design-profile>","fallback":"backup"},
    "research":{"primary":"<research-profile>","fallback":"backup"},
    "code":{"primary":"coding","fallback":"backup"},
    "adjudication":{"primary":"reviewing","fallback":"backup"},
    "review":{"primary":"reviewing","fallback":"backup"}
  }
}
```

Quota defaults are in DISPATCH.md: new work uses designated fallback on reliable exhaustion; already dispatched work waits if reset is at most 24 hours away, otherwise hand over. Keep these defaults unless the owner explicitly changes them in project settings. Record provider-reported reset times, not estimates.

## Use resource pools

Node ≥22, standard library only, Windows, Linux, and macOS supported. From repository root:

```text
node <skill-dir>/scripts/lease.mjs run build -- node tools/build.mjs
node <skill-dir>/scripts/lease.mjs status
node <skill-dir>/scripts/lease.mjs --project <project-settings.md> run device -- <command…>
```

By default read the JSON block containing resourcePools in docs/agents/orchestration.md under cwd. Machines may maintain local copies via --project. resourceNamespace must be unique across projects and identical across all worktrees, Campaigns, settings copies of one project; lane definitions must agree. Locks are shared by same user on one machine, not distributed across machines. status lists all defined pools; orchestrator does not allocate tickets individually.

Script takes the first free lane; if all occupied it fails without starting the child, retry later. Wrapper process owns the lock, waits for the child, releases on exit; OS releases on crash/forced termination. Do not delete lock files or return manually. Do not detach children that keep using resources. Killing wrapper may leave descendants; stop associated work with project tools before retrying if necessary.

Children receive ORCH_LEASE_POOL, ORCH_LEASE_LANE, ORCH_LEASE_DIR. directory is optional (e.g. devices); if present it must be an absolute local path. Script passes variables only, without creating directories/changing cwd. Multiple build lanes need different directories, and builds must use ORCH_LEASE_DIR. Windows ps1/cmd requires an explicit interpreter, e.g. `-- powershell.exe -NoProfile -File tools/build.ps1`, no implicit shell. Child exit code passes through; signals produce nonzero exit.

Done: constrained work wrapped with run, assigned lane/directory used; status shows lane, holder PID, start time (free lanes null). No request/release messages.
