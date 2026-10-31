# Inbox

Each machine runs one persistent web service shared by all projects and Campaigns. There is no Inbox conversation. The service is the only writer of `inbox.json`; orchestrators and execution tickets use commands instead of editing the file. The command entry point is `~/.agents/skills/orchestration/inbox-web/inbox.mjs`; examples below omit its absolute path.

## Start and health

1. Run `node inbox.mjs health`. If unhealthy, restart once: on Windows, run `node inbox.mjs install` to refresh the launcher and replace the running process; on Linux, run `systemctl --user restart orchestration-inbox.service`; on macOS, run `launchctl kickstart -k gui/$(id -u)/org.orchestration.inbox`. If not installed, run `node inbox.mjs install`. Check health again; if it still fails, report the blocker instead of restarting repeatedly.
2. Run `node inbox.mjs register <absolute-Campaign-directory>`; the directory must contain `campaign.json`. Save the returned Campaign ID. Read `remote.publicUrl` from public `machine.json`. For a hub with peers use its origin plus `/?machine=<machine-name>&campaign=<campaignId>`. For a single machine preserve the path prefix of `remote.publicUrl` and add `?campaign=<campaignId>`. URL-encode query values separately. Without a remote entry point, use `http://<local-LAN-address>:<port>/?campaign=<campaignId>`, taking the port from the public machine configuration. Obtain the local LAN address from the current network interfaces; do not guess a field in `machine.json`. Do not include a passphrase in the link.
3. Use `schedule_task` to create a task bound to this orchestrator, with schedule `{"type":"webhook"}` and prompt `/orchestration answers <campaign>`. The URL is a secret displayed by the T3 tool result. Standard input avoids argv exposure, but a literal pipe/here-string in an agent tool call also enters the transcript; it is not a transcript-free transfer. Prefer the owner pasting it in a local unrecorded terminal at `node inbox.mjs set-webhook <campaignId>` (input is hidden). If an authorized agent transfer is used, limit exposure to the tool result and that tool-call input; never echo it or include it in messages, public files, ledgers, logs, or reports. Record only the task ID.

Secrets belong only in `~/.agents/orchestration/private/`; do not read or output their contents. See [inbox-web/README.md](inbox-web/README.md) for persistent installation and public machine configuration. Do not stop this shared service when a Campaign ends.

Done when health is normal, the Campaign is registered, its webhook is bound to its orchestrator and stored safely, and the owner has the web link.

## Questions and acceptance

The execution session writes a UTF-8 JSON question file in the Campaign directory and runs `node inbox.mjs ask <campaignId> <question.json>`. Record the printed question ID in the delivery record. Follow [inbox-web/schema.md](inbox-web/schema.md); do not invent protocol fields.

Decision question example:

```json
{
  "kind": "decide",
  "title": "Release this version now?",
  "ticket": "#42",
  "askerThreadId": "original-asking-threadId",
  "askerLabel": "#42 execution",
  "blocking": false,
  "background": ["Validation is complete; the release window needs a decision.", "Independent documentation work will continue first."],
  "options": [
    {"key":"now","label":"Release now","consequence":"Deploy this release","recommended":true},
    {"key":"later","label":"Release later","consequence":"Keep the current version"}
  ],
  "recommendation": "Release now; validation is complete.",
  "multi": false,
  "media": []
}
```

Ask one thing per question. When the question is about a ticket, name it as `id：short title` in `title`/`askerLabel`/background (DISPATCH.md ticket naming); do not use a bare id. State the background, consequences of each option, recommendation and reason, what is blocked, and what will proceed first. Decision `options[]` must use only `key`, `label`, and `consequence` (optional `recommended`); never `detail` or other fields the page does not render. `multi: true` requires at least two options. Set `blocking` to `true` only when the entire ticket has stopped. Put media in readable files inside the Campaign first, then reference them with `media: [{"path":"media/42/preview.png","caption":"Preview"}]`. Paths must stay inside the Campaign.

After the orchestrator's lightweight check, each product ticket with visible output gets one acceptance question in the Inbox, with all supporting media. Execution tickets send media and delivery reports directly to their own orchestrator, without another orchestrator relaying them. Use `kind: accept`, omit `options`, and describe the changes, verified and unverified parts, and ticket link in `background`; set `askerThreadId` to the owning orchestrator. The page offers pass/rework; rework requires an explanation. Product tickets without visible output and tool, test, or documentation tickets without delegated closure authority wait for the closing summary.

To revise a question already in the Inbox (new facts, a changed recommendation), ask the revised version with `"replaces": "<original-id>"`; never post a second copy without it. The service accepts this only while the original is `open`. If `ask` refuses because the owner has already answered, run `pending`, handle that answer first, and ask anew only if the answer does not settle the question.

Done when the question can be answered independently on a phone and `ask` returns a question ID. Continue the unblocked work.

## Handle answers

On a webhook or patrol:

1. Run `node inbox.mjs pending <campaignId>` and read pending `items` and `messages`. On every webhook wakeup also run `node inbox.mjs routes <campaignId>` and inspect the current effective routes, limits and version: routing-change notifications are not pending Inbox items and webhook payloads may not reach the prompt. Record a relevant change and use current routes for subsequent dispatches; do not change running work. If no relevant change is known, report the checked version rather than claiming there was no change. Images in answers already have absolute paths. Prioritize answers unread for more than 15 minutes.
2. If an entry has `withdrawalPending: true`, its answer was withdrawn. Stop work based on the old answer and send a cancellation/correction to any recipient that already received it, using the message modes below. Only after handling the cancellation run `ack <id> --campaign <campaignId> --submission <submissionId from pending>`; the question stays `open` for a new answer. Do not `forward` or `close` a withdrawn answer. Otherwise run `node inbox.mjs ack <id> --campaign <campaignId> --submission <submissionId from pending>` to mark the question read by the orchestrator. Check the returned current answer, original option text, `note`, `images`, and `redo`; do not act on an older `pending` snapshot or reinterpret a choice as a new requirement.
3. After handling it, use `t3_thread_send` to relay the question ID, full answer, whether it is a revised answer, and absolute image paths to `askerThreadId`. Use `mode=steer` for running execution/worker tickets (any driver, including Cursor) and `mode=auto` if idle — never `mode=queue` for workers (owner 2026-10-28; see SKILL.md and scripts/worker-send.mjs). After send, confirm the relay entered the active run, not the composer queue. Reports and notifications to orchestrators use `queue`; instructions or corrections from the originating session or a session acting for the owner use `steer` (`auto` if idle). If the recipient is on another machine, copy the images there first and attach readable absolute paths on that machine. The owning orchestrator handles acceptance questions itself, records the result, and skips forwarding to itself and the `forward` command. After a pass, merge according to DISPATCH.md. Close only after post-merge checks pass, any authorized push succeeds, and a check confirms there are no new answers. For rework, keep the question `read` and arrange the revision first; do not close early.
4. Only after a successful relay, run `node inbox.mjs forward <id> --campaign <campaignId> --to <recipient-label-or-threadId>`. This records delivery; it does not send a message. Leave failed deliveries pending for retry instead of marking them delivered. The owner can change the answer while you handle it; that returns the question to `saved`/`notified`, and `forward` and `close` then refuse with an unread-answer error. On that refusal, run `pending` and `ack` again, relay the latest answer as a correction, stop work based on the old one, then retry.
5. Keep the question `forwarded` until the execution session implements the answer and reports back. Then read the current question in the local Campaign's `inbox.json` (read-only) and confirm there is no newer `saved`, `notified`, or `read` answer or pending `redo` before running `node inbox.mjs close <id> --campaign <campaignId> --note <implementation-note>`. Do not close the revision window immediately after forwarding. Revising a `forwarded` answer sets `redo` and returns it to pending; acknowledge and relay the latest answer again. Reversing a closed decision requires a new question.

`messages` are comments addressed to the owning orchestrator. Handle them before acknowledging; ack marks them `read`, without `forward`. Close handled comments with `close` before removing a Campaign. Batch the queue before each round, prioritize answers, and do not relay through another orchestrator.

### Review route changes

On each webhook and patrol, resolve `node inbox.mjs route <campaignId> review`. Compare its effective ordered tiers, including options and skipped quota tiers, with the last route successfully notified per execution ticket. Store this state in Campaign storage, separate from routing settings. Notify only execution threads that are currently running, still have review work ahead and have not delivered; re-read each thread and ticket immediately before sending. Never wake an idle or terminal thread, or notify a delivered, merged, closed or blocked ticket. If an eligible running ticket lacks a baseline, notify it once to establish one; missing state never makes an ineligible ticket eligible. Send the current effective review route and version, telling the worker to resolve the route again before each new review round; existing review children continue unchanged. Use the worker message modes and delivery verification in step 3. Record success per ticket only after verified delivery; retry failed delivery only while the thread remains eligible, and re-resolve if the route changes during notification. Do not change an execution thread's own model. Record the result in events.log.

The orchestrator may answer an `open` question within its authority: first read `inbox.json` without editing it to confirm the owner has not answered, then run `node inbox.mjs close <id> --campaign <campaignId> --by orchestrator --note <decision-and-reason>`. After success, relay it to the asking session using the message modes in step 3 and identify it as an orchestrator answer. The service refuses to overwrite an owner's answer; on that refusal, handle the owner's latest answer instead.

Done when pending answers are read, original wording and images reach the correct session, `forward` records only successful delivery, implemented answers are closed, and revised answers are all relayed.

## Chat relay (optional)

When a Campaign has chat relay configured (`node inbox.mjs relay set|status|revoke|resend`), the service may mirror open/revised/withdrawn/settled questions to an external bridge. Orchestrators do not change the pending path: answers may show `answeredVia: "relay:<tokenId>"` and are still owner answers. On `relay.state: failed` during patrol, resend once. See [inbox-web/schema.md](inbox-web/schema.md#chat-relay-optional).

## Disk deletion approval (housekeeping)

When housekeeping lists delete candidates, ask a `decide` question: put the candidate table in `background` (path, size, what it is, why safe, originals). Options such as `all` (delete the list), `partial` (owner names paths in the note), `none` (keep). After the owner answers, pass Inbox id + option + `authorized.txt` path list into the next housekeeping request (HOUSEKEEPING.md).
