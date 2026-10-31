# Inbox web service

Node ≥ 22, standard library only. Each machine runs one service and registers multiple Campaigns. The page is for the owner; the CLI uses a local-only administration API.

## Start

Run `node server.mjs` in this directory. The default address is `http://localhost:8780/`; devices on the same subnet can also reach it. Exiting the foreground process stops it. Use `node inbox.mjs install` for a persistent service.

Configuration lives in `~/.agents/orchestration/machine.json`. The service also starts without a configuration file:

```json
{
  "name": "machine-a",
  "port": 8780,
  "remotePort": 8781,
  "remote": {"type": "none"},
  "peers": [],
  "campaigns": []
}
```

Choose `remote.type`: `none`, `tailscale`, `cloudflared`, `url`, or `ssh-reverse`. See [Remote access](docs/remote-access.md) for prerequisites, copyable configuration, checks, and push support. Tailscale Serve, Cloudflare Tunnel, and your own reverse proxy are managed separately; only SSH reverse tunnels are started and reconnected by Inbox. `publicUrl` ends in `/` and supports a `/<machine-name>/` prefix. `peers` is an array of `{name, lanUrl, publicUrl}`. `lanHttpsUrl` is reserved for LAN HTTPS.

The remote port binds only to `127.0.0.1` and requires a passphrase cookie. Reverse proxies in front of it must overwrite `X-Forwarded-For` with the real client; see [Remote access](docs/remote-access.md) and [hub.Caddyfile](docs/hub.Caddyfile). The main port admits only local and same-subnet clients; the administration API accepts only loopback requests without `X-Forwarded-For`, and requires the `X-Inbox-Admin` header matching `private/admin-token` (mode 0600). The CLI sends that header automatically. Loopback requests skip page login only when `Host` is `localhost` or `127.0.0.1`. Do not proxy the main port directly to the public internet.

## Commands

| Command | Purpose |
| --- | --- |
| `node inbox.mjs doctor` | Local checks and actionable repairs; T3 MCP/Connect checks are agent steps in [SETUP.md](../SETUP.md) |
| `node inbox.mjs setup --answers <public-answers.json>` | Repeatable machine/project configuration, autostart installation and matching health check |
| `node inbox.mjs phone-qr [--png <new-private-file.png>]` | Rotate login token and show a QR in an unrecorded local terminal; never prints the token URL |
| `node inbox.mjs install` | Install or refresh autostart and start the current service |
| `node inbox.mjs uninstall` | Stop and remove autostart registration, preserving Campaigns and configuration |
| `node inbox.mjs status` | Query autostart registration; on Linux and macOS, also query runtime status |
| `node inbox.mjs health` | Query service and tunnel health; use this for patrols |
| `node inbox.mjs register <dir>` | Register a Campaign directory containing `campaign.json` |
| `node inbox.mjs unregister <campaignId>` | Remove registration, preserving data |
| `node inbox.mjs ask <campaignId> <question.json>` | Validate against [schema.md](schema.md), add to the Inbox, and print the question ID |
| `node inbox.mjs pending <campaignId>` | List pending answers and comments, converting image references to absolute paths |
| `node inbox.mjs ack <id> [--submission <submissionId>]` | Acknowledge the current answer or handled withdrawal; submission ID is required for withdrawal |
| `node inbox.mjs forward <id> --to <label>` | Record the recipient after relaying |
| `node inbox.mjs close <id> [--note <explanation>]` | Close a question |
| `node inbox.mjs close <id> --by orchestrator --note <explanation>` | Close with an orchestrator answer; cannot overwrite an owner's answer |
| `node inbox.mjs rotate-token` | Change the remote passphrase and invalidate old cookies; show the new link only in an interactive terminal |
| `node inbox.mjs set-webhook <campaignId>` | Read the URL from standard input, without echo for interactive entry; output only the save result |
| `node inbox.mjs routing-import [--force]` | Create `~/.agents/orchestration/routing.json` from the built-in 2026-10-23g route table (limits 8 / 2) |
| `node inbox.mjs catalog-write [--allow-missing]` | Store stdin `orchestrator_capabilities` JSON (or `[base, ...search results]`, merged) as `catalog.json`; refuses when a routed model is missing |
| `node inbox.mjs route <campaignId> <type>` | Print the effective ordered model tiers for one route type (JSON) |
| `node inbox.mjs routes [campaignId]` | Print every route type plus effective concurrency limits |
| `node inbox.mjs quota mark <instanceId/model> [--resume <ISO>] [--by orchestrator\|owner]` | Mark a model exhausted for new dispatches |
| `node inbox.mjs quota clear <instanceId/model>` | Clear an exhausted mark |

Routing commands read and write files under `INBOX_HOME` directly (no running admin call). See [schema.md](schema.md#routing-and-capacity-routingjson) for file shapes, HTTP APIs used by the settings page, and hub sync. Machine/Campaign patches use `null` to clear an override; `catalog-write` accepts the live `orchestrator_capabilities` JSON (`providers[]`). The page's **Dispatch settings** view (`?view=routing`, sliders icon in the top bar or the mobile settings sheet) edits the same data: Global / This machine / Campaign layers, ordered tiers chosen from the catalog snapshot, tighten-only concurrency limits, quota marks and per-machine sync status. Edits are drafted and saved as one patch; a version conflict keeps the draft and offers to load the latest version. Without `canManage` the view is read only.

Catalog refresh refuses to overwrite previously known option choices that are absent from a new capture, even with `--allow-missing`. Retry the capability lookup; the existing snapshot and its timestamp remain intact. Only after independently confirming removal upstream, use `catalog-write --allow-option-removal` (or API `allowOptionRemoval: true`) to accept the loss; an empty response alone does not establish removal. `--allow-missing` remains separately required for missing routed models.

The page has four real tabs: **Decisions**, **Reviews**, **Notes** and **Progress** (bottom bar on phones, navigation rail on tablets and desktops). Each tab shows one view; `?tab=accept|message|progress` opens a tab directly (Decisions needs no parameter), and notification links (`#item-<id>`) open the tab holding that item. Switching tabs replaces the address without adding history; Back closes overlays first, then returns to Decisions, then asks for a second press before leaving. The **Progress** tab is the read-only ticket board: tickets by status, version and machine, with a shortcut to items waiting on the owner. It only calls `GET /api/kanban/<id>`; see [schema.md](schema.md#ticket-board-progress-tab-read-only). The old `kanban.html?campaign=<id>` link redirects there.

Styles live in one stylesheet, `public/style.css`. Its two token blocks (light `:root`, dark `:root[data-theme="dark"]`) hold every colour, type size, radius and shadow; rules only reference tokens, and `test/tokens.test.mjs` enforces this.

Every routing or model-settings change that actually alters a layer is reported to the affected Campaign orchestrators (all registered Campaigns for global/machine layers, including a global snapshot accepted from a peer, and only that Campaign for a Campaign override): a `t3-thread` Campaign is woken on its existing answer webhook, an `external` Campaign receives the same signed queue-only POST as `report.mjs`, so the event passes `report.mjs verify`. The public body lists scope, changed route types with tier before/after, limits, quota marks, `changedBy`, `changedAt` (ISO) and the routing version — never tokens, URLs, webhook addresses or signature material. A no-op save emits nothing; delivery failures are logged (`event: routing-event`) without endpoints and never block the save. See [schema.md](schema.md#routing-change-events).

When question IDs overlap across Campaigns, add `--campaign <campaignId>` to `ack`, `forward`, or `close`. Do not put secrets in command arguments or redirect them to public files. Passphrases, cookie keys, VAPID keys, subscriptions, and webhooks belong only in `~/.agents/orchestration/private/`, with directory mode 0700 and file mode 0600 on Linux. Do not commit these files or include them in delivery screenshots.

On Windows, installation creates a scheduled task triggered by the current user's login. The system `conhost.exe --headless` runs the PowerShell supervisor loop written to `~/.agents/orchestration/inbox-launcher.ps1`, independent of the default terminal's hidden-window settings. The supervisor runs at normal priority, and a new one stops the previous supervisor recorded in `inbox-watchdog.pid`. The launcher waits for Node to exit and cleans up SSH tunnels started directly by that process. It stops after normal exit and retries five seconds after an abnormal exit or startup failure. The scheduled task also restarts the supervisor one minute after supervisor failure. Linux installs `~/.config/systemd/user/orchestration-inbox.service`, enables it with `systemctl --user`, and restarts five seconds after failure. macOS installs `~/Library/LaunchAgents/org.orchestration.inbox.plist` and uses `launchctl bootstrap gui/<uid>` to start it in the current GUI login session. It runs at login and retries after failure, with a five-second throttle; normal exit does not restart it. Installation records the absolute Node and server paths and `INBOX_HOME`, without relying on shell startup files. Run install/uninstall/status as the logged-in user, without `sudo`. Status reports whether the plist is installed and whether launchd reports a running process; use `health` to check HTTP readiness. Uninstall unloads the agent and removes only its plist. A user login environment is required; verify autostart after logging in again on each platform. Rerun `install` after changing the installation directory or Node path.

## Push and notifications

After configuring an HTTPS remote entry point, subscribe to web push on the remote page. New questions and acceptance requests are batched within two minutes; questions blocking a ticket send an immediate separate push. Delivery failures or answers unread for fifteen minutes trigger one reminder per submission. Normal batches are persisted privately and resumed after service restart. A crash between delivery and recording completion can repeat a push; its stable notification tag replaces the prior notification. Progress and closure do not send push notifications. Invalid subscriptions are removed automatically. Use the phone's system settings for do not disturb.

Answers are saved before notifying the orchestrator, and remain saved if there is no webhook or notification fails. The orchestrator uses `pending` to find missed answers, acknowledges with `ack`, and relays to the original asking session. The page can retry failed notifications. Real phone push and reverse tunnels require integration verification after the remote entry point is configured.

Upload limits: each image is at most 20MB. The service rejects requests whose `Content-Length` exceeds that before reading the body. Each Campaign also has a 500MB total cap under `inbox/uploads/`; further uploads return 413 until older files are removed.

## Verification

Runtime code uses the Node standard library only. Tests may use root `package.json` `devDependencies` (currently `jsqr` for `qr.test.mjs`). In a new worktree run `npm ci` first, then from the repository root `node --test orchestration/inbox-web/test/*.test.mjs` (or `npm test` for the full suite). Tests use temporary directories and do not change real machine configuration. `INBOX_HOME` can specify a temporary home; the service, CLI, and autostart installer all use the same value. Leave it unset for normal use.

## Remote hub

The owner uses `https://<domain>/?machine=<machine-name>&campaign=<id>`, with the machine name and ID URL-encoded. A Campaign ID alone can also locate a Campaign; include `machine` when the same ID exists on multiple machines. On the phone, log in at the domain root, install the PWA, and tap the bell once to cover all machines. The manifest, icons, and service worker resolve relative to the current entry point; the root scope is `/`. Existing machine paths such as `/machine-a/` and `/machine-b/`, and LAN pages, remain available without redirects. LAN does not provide a hub. The owner may remove a previously installed machine-path app and install the root app instead.

Keep each machine's own `name`, ports, `remote`, and `campaigns` in its `machine.json`. For example, machine-a sets `"peers": [{"name":"machine-b"}]`, and machine-b sets `"peers": [{"name":"machine-a"}]`. For routing sync and machine-layer forwarding, give peers a reachable `lanUrl` or `publicUrl` (trailing slash optional). Remote access uses only same-origin `/<name>/` paths; retain `lanUrl` for switching on older LAN pages. Switching Campaigns in the hub stays at the root path. Answers, uploads, comments, revisions, withdrawals, retries, and media go to the owning machine. Local drafts are separated by machine and Campaign. Unreachable machines are marked in the switcher; refresh or reopen the menu after recovery. A failed subscription registration on one machine is reported; tap the bell again to retry. Registering the same endpoint again does not create duplicates.

### Reverse proxy routing

Use the [generic Caddy hub example](docs/hub.Caddyfile). Replace `example.com` and the two loopback tunnel ports. Proxy each machine path to that machine's remote listener and strip the prefix. The root uses an online machine, with failover to the other. Overwrite `X-Inbox-Hub` with `0` for machine paths and `1` for the root; never trust a client-provided value. Overwrite `X-Forwarded-For` with the real client on every upstream request. The hub header takes effect only on the remote listener. A single-machine entry does not need the hub header or hub routing, but still needs the `X-Forwarded-For` overwrite. Tailscale Serve and Cloudflare Tunnel do not automatically aggregate machines; a multi-machine hub needs the same-origin routing shown here.

The browser sends API operations directly through each machine path; one machine does not store another's data. Failover covers the root page and root assets. Machine paths retain fixed routing; an offline machine's data does not move to another machine. See [Remote access](docs/remote-access.md#multi-machine-hub) for configuration and checks.

### Shared secrets and passphrase rotation

Choose one machine as the secret source. Synchronize only `remote-token`, `cookie-key`, and `vapid.json` to `~/.agents/orchestration/private/` on the other machines. Do not copy the entire private directory or overwrite webhook or subscription files. Use only SSH pipes or SCP file copies. Never carry secret values through `cat`, `echo`, logs, or command arguments; check only copy exit codes and service health. On Linux, the private directory is 0700 and these three files are 0600. Restart all services after first switching to shared VAPID. The owner must resubscribe at the root path for old subscriptions using a different VAPID key, cancelling the old subscription in the browser if necessary. There is no need to delete old subscription files.

Example synchronization from machine-a to machine-b (PowerShell; paths contain filenames, not secret values):

```powershell
scp "$HOME/.agents/orchestration/private/remote-token" "$HOME/.agents/orchestration/private/cookie-key" "$HOME/.agents/orchestration/private/vapid.json" 'machine-b:.agents/orchestration/private/'
ssh machine-b 'chmod 700 ~/.agents/orchestration/private; chmod 600 ~/.agents/orchestration/private/remote-token ~/.agents/orchestration/private/cookie-key ~/.agents/orchestration/private/vapid.json; systemctl --user restart orchestration-inbox.service'
```

`rotate-token` still shows the new passphrase link only in the local interactive terminal; the link uses the hub root. Immediately synchronize `remote-token` and `cookie-key` by file copy after rotation (VAPID need not be synchronized again). Authorization checks reload both files on every request, so old cookies on both machines become invalid after copying, without a restart. Avoid using the other machine until synchronization finishes. Synchronize an offline machine after recovery before reopening access. The cookie Path is fixed at `/`; a shared signing key allows one login. Browsers sending both old machine-path cookies and new root cookies remain supported.

Update the skill with `npx skills add <source-directory>/orchestration -g -a '*' -y`. A source copy on another machine may live at `~/.agents/skill-src/orchestration`. After updating the skill, rerun `node inbox.mjs install` to regenerate the launcher/service definition with the current paths. Windows replaces the old watchdog, including the older encoded launcher; macOS reloads its agent. On Linux also run `systemctl --user restart orchestration-inbox.service`. Verify each machine's `health`, peers, and registered Campaigns are unchanged. Do not copy a new machine.json over existing registrations or private credentials.

## LAN authentication and language

`machine.json` now defaults to `"lanTrustSubnet": false`. Devices on the local subnet must use a passphrase link (or the sign-in form) to receive a session cookie. The sign-in form posts the passphrase or a one-time device code (it does not put secrets in the URL); `?k=` remains for passphrase links, and `?device=` for QR / copied device links. Run `node inbox.mjs rotate-token` locally in a terminal to create a login link; without a remote URL it uses `lanHttpsUrl`, or the local hostname and port. Direct loopback administration remains local-only with the admin token. To keep trusted-subnet behavior on your own machines, add `"lanTrustSubnet": true` at the top level of `~/.agents/orchestration/machine.json`, then restart the service. Auto trust skips common virtual NIC ranges (Tailscale `100.64.0.0/10`, link-local, Docker/Hyper-V/WSL `172.16.0.0/12`, and matching IPv6). To trust only specific ranges, set `"lanTrustCidrs": ["192.168.1.0/24"]` (CIDR strings). When a loopback client sends `X-Forwarded-For`, LAN checks use the rightmost hop. This change does not modify installed machine configuration.

`/api/summary` returns `loggedIn` (valid session cookie) and `canManage` (cookie **or** trusted LAN on the main port when `lanTrustSubnet` is true). The Campaign switcher shows **Remove** from `canManage`, not `loggedIn`. Trusted LAN devices can remove a Campaign without a cookie; the remote listener still requires a cookie. Cross-site write checks (Origin / Sec-Fetch-Site) stay in force. **Add device** still needs a cookie.

The UI follows the browser language (Chinese for `zh`, English otherwise). The EN / 中 button saves a manual preference in this browser. Subscribed devices also save that preference for push notifications. Questions, choices and user notes remain in their original language.

### Known security limits

- HTTP LAN access sends passphrases and cookies without transport encryption. Use a trusted network or configure LAN HTTPS. Trusted-subnet mode deliberately allows matching clients to access Inbox without authentication.
- Remote login throttling uses the rightmost overwritten `X-Forwarded-For` hop (or the socket address if that header is absent). Valid cookies are accepted before the lockout check. Five failed attempts within ten minutes block that source for fifteen minutes. Limits reset when the service restarts. Configure additional rate limiting at the proxy and redact passphrase query strings (`?k=`) from access logs.
- `X-Inbox-Hub` only controls authenticated hub routing; it never grants access. The reverse proxy must overwrite this header and `X-Forwarded-For`, and keep the remote listener loopback-only.
- `/admin` requires `private/admin-token` via `X-Inbox-Admin`. setup generates it; doctor checks that the file exists with mode 0600. Never print the token.
- Media under `/media/` is served with `Content-Security-Policy: sandbox`. All responses set `frame-ancestors 'none'` / `X-Frame-Options: DENY`. In trusted-subnet mode, `/api/summary` echoes `Access-Control-Allow-Origin` only for origins listed on known peers' `lanUrl` / `publicUrl`.
- POSIX private directories/files use 0700/0600. Windows `chmod` does not replace account ACLs; protect the account's home directory. Local processes and Campaign administrators are trusted, including for configured webhook URLs and local lease IPC; the lease username hash is a namespace, not an authorization check.
- Web Push endpoints are limited to the browser services FCM, Mozilla, Apple and WNS to prevent arbitrary server-side requests. Self-hosted and other push services are unsupported. No real FCM delivery, Linux permissions or Windows account ACLs were changed or verified by this ticket's local tests.
- On macOS, lease recovery probes and unlinks a stale socket file in the user's temporary directory. Recovery runs under a `mkdir` guard beside the socket, so concurrent recoverers yield one holder; a guard left by an acquirer killed mid-recovery is ignored after 10 seconds. The temporary directory and local processes must be trusted.

### Add another device

Use **Add device** on a signed-in device to copy a single-use login link, valid for five minutes. It uses the existing session cookie mechanism and leaves the passphrase and existing sessions intact. Links stay in service/browser memory, expire on restart, and are valid only on the issuing machine (preserve its public path in a hub). Share privately, never in transcripts or screenshots. The web action requires a valid login cookie even when subnet trust is enabled. Clipboard copy needs HTTPS or localhost.

Alternatively run `node inbox.mjs add-device` in a local unrecorded interactive terminal. It renders a QR and prints a short one-time code (same five-minute single-use grant; type the code on the login page when a desktop browser cannot scan). It refuses redirected output and returns no link or code to its caller. `phone-qr` remains the explicit recovery/rotation command.

Campaign media is served with a sandbox policy, with scripts and network access disabled. HTML and script files download as attachments; they do not run with Inbox permissions.
