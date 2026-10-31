# Setup

Run this entry in T3 Code v0.1.0 or later. Guide the owner in their language. Steps are resumable: inspect what exists, keep unrelated configuration, fix the failed step and repeat it. Setup gathers answers conversationally; the Node command consumes a prefilled public JSON file. Do not dispatch work until routing and permissions are agreed.

## 1. Diagnose the machine and T3

Resolve `<skill-dir>` to this installed skill. Run:

```text
node <skill-dir>/inbox-web/inbox.mjs doctor
```

Doctor reports `ok` per check and a repair for failures, and exits nonzero when any check fails. It checks Node ≥22, git, GitHub CLI authentication, configured ports (free or matching healthy Inbox), Inbox health, autostart, and the CLI required by the selected remote type. It reads public machine configuration only. Missing service/autostart is expected before installation; missing `gh auth` can be deferred for the local-only smoke but must be fixed before using GitHub tickets. Install missing programs using the owner's platform package manager; `gh auth login` is interactive. Do not copy authentication from another user.

**Agent-only checks (doctor cannot inspect MCP):** call `orchestrator_capabilities`. Verify T3's orchestration tools, thread management, child tasks and scheduled tasks are available, and inspect the live tool catalog for `schedule_task`. Verify webhook/T3 Connect readiness with available T3 connection/status tools. If there is no status tool, check T3's exposed connection information with the owner; do not claim success from Node doctor. Before a real Campaign, use `schedule_task` with `{"type":"webhook"}` and verify a submitted Inbox answer wakes the bound orchestrator; this is the effective T3 Connect check. If unavailable, explain how to enable T3 Connect in their T3 installation and retry; do not invent a second harness integration. Record tool/check outcomes, never webhook URLs. Do not create throwaway recurring tasks just to test tool visibility.

Done: local failures have repairs or explicit deferred steps; actual T3 capabilities and connection readiness are established or clearly pending. Never present local doctor as full setup certification.

## 2. Gather machine and project answers

Check the installed skills directories visible to this T3 session for `implement`, `code-review`, `to-tickets` and `wayfinder`. Offer missing companions as optional with `npx skills add mattpocock/skills -s implement code-review to-tickets wayfinder -g -a '*' -y`; never install without the owner's choice. Continue setup if declined. They are not bundled. The built-in steps in DISPATCH.md prevail on conflict: executors never push/merge and two-axis review uses T3 child tasks. Without companions use the built-in steps. Record which companions were detected; their presence is not a setup prerequisite.

Ask for machine name, LAN/remote ports (defaults 8780/8781), remote method, and project root. Choose **one of the existing five methods**: `none`, `tailscale`, `cloudflared`, `url`, `ssh-reverse`. Follow [remote-access.md](inbox-web/docs/remote-access.md) for prerequisites, fields, external setup and verification. Tailscale/cloudflared/proxy lifecycle stays external; Inbox manages only SSH reverse tunnels. Do not add another remote configuration format.

LAN login defaults to required (`lanTrustSubnet: false`). Offer bypass only if the owner explicitly wants to trust the local subnet. For plain LAN HTTP, login works but push/PWA installation may be unavailable: choose trusted HTTPS for the phone experience. Never claim push is verified on plain LAN HTTP.

For the project ask Campaign storage per machine, disk threshold, owner display name, permissions, resource pools and tests. Optionally ask whether to enable a housekeeping session (HOUSEKEEPING.md; lazy-created later) and whether the orchestrator is a T3 thread or an external agent (EXTERNAL-ORCHESTRATOR.md). Read [PROJECT.md](PROJECT.md) for those fields. **Do not** put concurrency limits or dispatch routes in project settings: they live in Inbox routing settings (decision 44; see [schema.md](inbox-web/schema.md#routing-and-capacity-routingjson)).

**Routing and capacity (Inbox):** check `~/.agents/orchestration/routing.json` (under `INBOX_HOME` when set). If it is missing, run `node <skill-dir>/inbox-web/inbox.mjs routing-import` to seed the built-in 2026-10-23g table (execution 8 / design 2). Customize global or host routes, limits, and quota in the Inbox settings page, never by hand-editing that file. For Campaign-only overrides, use the Campaign layer of the same page; it stores only the changed fields in `<campaign-dir>/routing.json`. Never copy the route table into project settings. Optional setup answers may include `campaignRouting: { "dir": "<campaign-dir>", "limits": {…}, "routes": {…} }` to write that override file. Call `orchestrator_capabilities` and keep a catalog snapshot (`catalog-write`) so settings can validate picks; do not use placeholder profiles for live dispatch.

Write the answers to a temporary **public** JSON file; it must contain no passphrases, keys, subscriptions, webhook URLs or tunnel credentials. Example:

```json
{
  "machine": {
    "name": "my-machine", "port": 8780, "remotePort": 8781,
    "remote": {"type": "none"}, "lanTrustSubnet": false
  },
  "project": {
    "root": "/absolute/project", "storage": "/absolute/campaign-storage",
    "diskWarningGB": 10, "owner": "you",
    "permissions": "Ask before push, release and ticket closure.",
    "resources": {"resourceNamespace": "my-project", "resourcePools": {}},
    "tests": "The project's actual test commands and allowed short post-merge checks."
  }
}
```

On Windows use absolute Windows paths with JSON escaping (or forward slashes). `project` may be omitted to configure the machine first; rerun with project answers later. Existing project settings with different contents are preserved: read and edit them with owner-agreed values instead of replacing them. Existing AGENTS.md content is kept and the project-settings link is added once. Existing machine Campaigns/peers are retained. Legacy `capacity` / `designCapacity` / `routing` keys in an answers file are ignored for project settings.

## 3. Configure, install and check

```text
node <skill-dir>/inbox-web/inbox.mjs setup --answers <public-answers.json>
node <skill-dir>/inbox-web/inbox.mjs doctor
node <skill-dir>/inbox-web/inbox.mjs health
```

The command writes `~/.agents/orchestration/machine.json`, project settings and the AGENTS.md link, installs autostart through the existing platform installer, restarts Inbox to apply configuration, and waits for matching health. It does **not** create `routing.json`; when that file is missing the JSON result includes `routing.present: false` and `routing.fix` pointing at `routing-import`—run that command before live dispatch. Repeat the same answers safely; paths and unrelated registrations remain intact. A failed health check leaves the public settings for repair. Use status and the [Inbox README](inbox-web/README.md) service-manager instructions. Verify service health after a new login/reboot separately. Delete the temporary answer file when no longer needed.

For an isolated trial set `HOME`, `USERPROFILE` on Windows, and `INBOX_HOME` to a newly allocated temporary directory, use a separate skills copy and **two unused non-default ports**. Setting HOME alone does not sandbox system service managers: use the [trial runner](scripts/test/setup-trial.mjs), whose installer runner is simulated, instead of invoking real install. It starts/stops a temporary local server and repeats the prefilled CLI setup path twice. Run `node <skill-dir>/scripts/test/setup-trial.mjs`; only its public JSON record is retained. To test an actual skills CLI installation and companion detection, allocate the isolated home with prefix `orchestration-release-trial-`, install there with `--copy`, and run the installed trial with `--installed`. That mode preserves the caller-allocated isolated home for inspection instead of deleting it. It expects `gh auth` to fail in the empty user config. Do not install into another user's real home, modify existing services, or treat this simulation as login/reboot or fresh-system acceptance.

## 4. Phone login, app and push

In a local, unrecorded interactive terminal run:

```text
node <skill-dir>/inbox-web/inbox.mjs add-device
```

This creates a single-use, five-minute login QR without rotating the passphrase or invalidating existing sessions. It expires on service restart. An already logged-in device can instead use **Add device** in the header on desktop, or in the gear/settings panel on a phone and privately copy the short-lived link. It refuses redirected output. Tokens and login URLs pass from the local admin response to the encoder in memory only. Never use `rotate-token` in an agent transcript to retrieve a URL, paste a login link into chat, or take a QR screenshot. Device links belong to the issuing machine; preserve its path prefix when sharing from a hub. `phone-qr` remains an explicit passphrase-rotation recovery action, coordinated with other machines first.

For recovery with `phone-qr`, optional `--png <new-private-path.png>` saves a new PNG with mode 0600 (Windows home ACLs still apply); it refuses overwrite. A QR image is itself a credential: keep it private, scan locally and delete that exact file afterwards. Do not attach it to logs, tickets, reviews or deliveries. The encoder supports up to 271 UTF-8 bytes; use a shorter public entry URL if necessary. This implementation uses Node's standard library only. The old external Python helpers need not be removed.

Scan on the owner's phone. Confirm the host is reachable and login succeeds. For LAN hostname resolution failures use a reachable configured LAN HTTPS entry or the HTTPS remote method; do not print a token to troubleshoot. With trusted HTTPS, use the browser's Install/Add to Home Screen action, open the installed Inbox, tap the notification bell and grant permission. Register the optional smoke Campaign below, then submit its decision question as the **test push** (new questions can batch for up to two minutes). Confirm the phone notification opens that question. If skipping smoke, register a disposable test Campaign, ask one nonblocking decision, verify notification, close and unregister it. Inspect the question's `push` record in inbox.json for dispatch time and successful push-service count; this is separate from webhook `notify`. Owner confirmation establishes device receipt. Do not call receipt verified until the owner confirms it; repair HTTPS/browser/provider access per the remote guide. Retain only pass/fail evidence, never credentials or subscription data.

Done: phone login, installed app, subscription and actual test notification separately confirmed, or named pending with a reason.

## 5. Optional smoke Campaign

Offer [SMOKE.md](SMOKE.md). It creates a temporary local git repository and two Markdown tickets without any GitHub repository/issues. The dry-run never dispatches real threads. Only an orchestrator may run the live Campaign; execution tickets prepare/dry-run and hand it back. A live Campaign verifies dispatch → Inbox question/answer → report → review → visual owner approval → local merge → owner-approved closeout and cleanup.

Done: report which of local setup, T3 checks, phone, live smoke and login/reboot checks were actually verified. Fresh system-user Windows/Linux acceptance belongs to the final release acceptance; temporary HOME trials do not replace it.
