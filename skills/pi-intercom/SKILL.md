---
name: pi-intercom
description: |
  Discover and communicate with Pi peers locally or across configured SSH machines.
  Use for cross-session handoffs, asynchronous collection requests, replies, and
  pi-subagents supervisor escalations.
---

# Pi Intercom

## Discover → address → respond

1. **Discover the right roster.** `list-cwd` shows peers in your directory; `list`
   shows your local broker pool. For another host, `list-remote` shows trusted
   machines without connecting, then `list-remote` with `machine` lists that
   machine's actual broker aliases, cwd and status.
2. **Use a listed role/runtime alias.** Send to `worker` locally or
   `worker@macbook` remotely. Pane names, terminal titles and repo names are not
   addresses. If a target is missing or ambiguous, re-list and use the candidates;
   no machine or peer is selected automatically.
3. **Send asynchronously for long work.** Use `send` for collection requests and
   handoffs. `ask` blocks, has a timeout, and only works locally.
4. **Respond using `reply`.** In the incoming message's turn, pass only `message`.
   For a later cross-host response, pass `to: "worker@macbook"` from its header.
   Intercom retains recent remote origins and routes to the original broker ID
   internally, not the transient relay CLI. A cross-host reply is a new async
   message, not a blocking/threaded reply. If its context expired, discover again
   and use `send` to a listed alias.

```typescript
intercom({ action: "list-cwd" })
intercom({ action: "list-remote" })
intercom({ action: "list-remote", machine: "macbook" })
intercom({ action: "send", to: "arm-worker@macbook", message: "Collect ARM results and send them when ready." })
// On the recipient:
intercom({ action: "reply", message: "Here are the ARM results…" })
```

## Cross-host constraints

- Remote destinations must be enabled Herdr saved machines or trusted
  `crossMachine.machines` entries. SSH needs noninteractive authentication and
  known host keys. Per-machine command overrides handle different install paths.
- The destination roster is its CLI's broker pool, not every pool on that host.
  Use matching trusted runtime configuration for discovery and relay.
- `send`, `handover`, and origin-aware async `reply` work across hosts.
  Cross-host `ask`, `replyTo`, attachments, supersede/retry, `noWake`, and cwd/project
  routing are unsupported.
- A plain `ssh host 'pi-intercom send … --name bridge'` creates a destination-local
  CLI sender which disconnects. Replies to that bridge stay on that host; it is
  not a transparent two-way bridge. Prefer the native tool with `alias@machine`.
- Each host needs a configured reverse machine label to send a response. Missing
  reverse mappings or source identities produce actionable errors, not a local
  mailbox fallback. Check both sides when setting up a machine.
- “Unverified cross-machine” identifies SSH-asserted metadata, not an authenticated
  Pi session. Delivery timeouts can have unknown outcomes; retries are explicit.

## Local asks and replies

- `ask` needs a live peer and only one ask can wait per session. The default tool
  timeout is 10 minutes (`PI_INTERCOM_ASK_TIMEOUT_MS`); use async `send` for long work.
- `pending` lists local asks waiting on you. With several asks, `reply` with `to`
  selects a sender; `replyTo` selects an exact local ask.
- `send` answers the sole pending ask from its target when unambiguous. Late local
  replies can arrive as ordinary messages and do not complete the original wait.
- Local disconnected named sessions have a bounded mailbox, not permanent storage.

## Supervising pi-subagents

A child uses `contact_supervisor` for owner decisions and structured interviews.
Reply to a blocking escalation with `reply`; a follow-up question belongs in that
reply, not a mutual `ask`. For interviews, return the requested JSON. Progress
updates need no reply; redirect with `send` when necessary.

## Other repos and visible peers

Use `to` plus `cwd` as a local directory guard. For bounded delegated work, prefer
an explicitly requested subagent with `cwd`. Open a visible Herdr project pane
with `openProjectPaneIfMissing` only when the user wants a long-lived visible peer.
`handover` sends a model-written summary; `/handover` lets a human review it first.
`/alias <name>` names the current session for both local and remote rosters.

## Reference

- [Configuration and broker pools](../../README.md#config)
- [CLI and remote setup](../../README.md#scripting-and-remote-machines)
- [Local send versus ask](../../README.md#send-vs-ask)
- [Extension channels](../../README.md#extension-channels)
