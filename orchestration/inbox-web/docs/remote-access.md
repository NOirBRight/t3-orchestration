# Remote access

Choose one entry method per machine. Save the example as `~/.agents/orchestration/machine.json`, preserving existing Campaigns and peers. Examples use the normal ports; for an isolated trial set `INBOX_HOME` to a new temporary home and replace **both** ports everywhere with unused ports, for example 18780 and 18781. `INBOX_HOME` is a home directory, not the `.agents/orchestration` directory. Start Inbox with `node server.mjs` from the parent directory. Restart it after configuration changes.

Every HTTPS entry targets `http://127.0.0.1:<remotePort>` on the Inbox machine, which requires passphrase login. Do not expose the LAN administration port through a tunnel. Set `publicUrl` to the browser URL, ending in `/`; it is used for origin checks and notification links. Plain HTTP URLs are accepted for development, but remote push needs trusted HTTPS, browser permission, and access to the browser's push provider. Localhost development is a browser exception, not LAN push support.

Inbox does not install or supervise Tailscale, cloudflared, or reverse proxies. Keep those running separately and verify them after login/reboot. `node inbox.mjs health` checks Inbox; `tunnel: disabled` is expected for all modes except managed `ssh-reverse` and says nothing about an external tunnel's health.

For each HTTPS method, check the public login page with `curl --silent --output /dev/null --write-out '%{http_code}\n' <publicUrl>` (`curl.exe` on Windows; use `NUL` instead of `/dev/null`). Expect HTTP 200. This proves TLS and the page route, not login or push: then log in in a browser, open a Campaign, subscribe, and send a test question to verify notification delivery. Do not put the passphrase or cookies in commands or logs.

## none: LAN only

Prerequisite: the client can reach the machine on the local subnet; allow the selected LAN port through the local firewall. No DNS, tunnel, or remote account is required.

```json
{"name":"machine-a","port":8780,"remotePort":8781,"remote":{"type":"none"},"peers":[],"campaigns":[]}
```

Check from the machine with `node inbox.mjs health`, then open `http://<LAN-address>:8780/` on a same-subnet device (or use the curl check above with that address). There is no public entry and no push over plain LAN HTTP. `none` disables managed tunnels; it does not remove an independently configured proxy or stop the loopback remote listener. Stop any old external tunnel when switching to LAN only.

## tailscale: HTTPS within a tailnet

Prerequisites: Tailscale is installed and connected on the server and client; enable MagicDNS and HTTPS certificates in the tailnet, and allow client access in tailnet policy. This method uses Serve, which shares within the tailnet.

```json
{"name":"machine-a","port":8780,"remotePort":8781,"remote":{"type":"tailscale","publicUrl":"https://machine-a.example-tailnet.ts.net/"},"peers":[],"campaigns":[]}
```

Run `tailscale serve --bg http://127.0.0.1:8781`. Use the HTTPS URL it reports as `publicUrl`; restart Inbox after saving it. Check `tailscale serve status`, then perform the public URL check from a connected client. Push is available over this HTTPS URL, subject to the browser requirements above. Serve with `--bg` resumes after Tailscale restarts. See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve) for flags and removal; do not reset existing Serve routes during an isolated trial.

## cloudflared: Cloudflare Tunnel

Prerequisites: cloudflared, a Cloudflare account/domain, and a named tunnel with a published HTTPS hostname pointing to this machine. In the tunnel's published application settings, set the service to `http://127.0.0.1:8781`. Run the connector separately, using a private credential file or the provider's protected service setup; do not put a tunnel token in `machine.json` or command logs.

```json
{"name":"machine-a","port":8780,"remotePort":8781,"remote":{"type":"cloudflared","publicUrl":"https://inbox.example.com/"},"peers":[],"campaigns":[]}
```

For a locally managed tunnel, this is a configuration template. Replace both placeholders with the tunnel ID and an absolute path to its credential file under `~/.agents/orchestration/private/`. Store the config there too; keep credentials out of the repository.

```yaml
tunnel: <tunnel-id>
credentials-file: <absolute-private-directory>/<tunnel-id>.json
ingress:
  - hostname: inbox.example.com
    service: http://127.0.0.1:8781
  - service: http_status:404
```

Run `cloudflared tunnel --config <absolute-config-file> run`, then perform the public URL check. For local config, also check `cloudflared tunnel --config <absolute-config-file> ingress validate`. Push is available over HTTPS. See [Cloudflare's configuration reference](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/). Avoid quick-tunnel URLs for persistent notification links. Do not cache Inbox API responses or place an extra interactive authentication gateway in front of service-worker assets without testing login and push.

## url: your own HTTPS reverse proxy

Prerequisites: a stable HTTPS hostname and an existing reverse proxy with a trusted certificate. On the same machine, proxy to `127.0.0.1:8781`. If the proxy runs elsewhere, provide a protected tunnel to that loopback listener; do not change its bind address.

```json
{"name":"machine-a","port":8780,"remotePort":8781,"remote":{"type":"url","publicUrl":"https://inbox.example.com/"},"peers":[],"campaigns":[]}
```

A same-machine Caddy site can use:

```caddyfile
inbox.example.com {
    reverse_proxy 127.0.0.1:8781
}
```

Perform the public URL check, then browser login and push checks. Push is available with trusted HTTPS. Inbox does not create the proxy or issue its certificate.

## ssh-reverse: advanced VPS deployment

Prerequisites: OpenSSH on the Inbox machine, a key-authenticated SSH alias `inbox-relay` in the user's SSH config, a server allowing remote forwarding, and an HTTPS reverse proxy on that server. Confirm the host key interactively before starting Inbox; its SSH process uses batch mode. Bind the server-side forwarded port only to loopback.

```json
{"name":"machine-a","port":8780,"remotePort":8781,"remote":{"type":"ssh-reverse","sshHost":"inbox-relay","remoteBindHost":"127.0.0.1","remoteBindPort":9781,"publicUrl":"https://inbox.example.com/"},"peers":[],"campaigns":[]}
```

The VPS proxy targets `http://127.0.0.1:9781`; Inbox starts SSH and reconnects on failure. Check `node inbox.mjs health` for `tunnel: running`, then perform the public URL check. A running SSH process alone does not prove the proxy works. Push is available over trusted HTTPS. Manage VPS/proxy deployment separately from Inbox installation.

## Multi-machine hub

Use one HTTPS origin for the hub and each machine path. For example, set machine-a's `publicUrl` to `https://example.com/machine-a/` and `peers` to `[{"name":"machine-b"}]`; machine-b uses `https://example.com/machine-b/` and `[{"name":"machine-a"}]`. Each machine keeps its own ports, tunnel settings, and Campaigns. With SSH, forward machine-a to server loopback port 9781 and machine-b to 9782.

Deploy [hub.Caddyfile](hub.Caddyfile) at the shared origin. It strips machine prefixes and overwrites the hub header. Other proxies must provide equivalent routing. Direct per-machine Tailscale/Cloudflare hostnames alone do not provide a shared-origin hub.

Check `caddy validate --config <site-config> --adapter caddyfile` before applying the site configuration. Check `https://example.com/`, `/machine-a/`, and `/machine-b/` with the URL check above. Then follow the [shared-secret setup](../README.md#shared-secrets-and-passphrase-rotation), log in at the root, and subscribe once. Verify switching and submitting to both machines, and root failover while one machine is offline. One offline machine must not block another; its own data remains unavailable until it returns. The hub does not replicate Campaign data or provide a LAN hub.
