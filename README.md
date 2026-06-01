# pi-coms

Agent-to-agent communication for the [Pi coding agent](https://github.com/badlogic/pi-mono). Two patterns, both **local-first over Unix domain sockets** — no HTTP, no ports, no auth tokens:

- **`coms`** — flat peer-to-peer. Each agent dials each other directly. Best for 2 agents.
- **`coms-net`** — hub-and-spoke. A small broker routes all traffic, which adds decoupled discovery, broadcast, and one audit/observability point. Worth it at 3+ agents.

Inspired by disler's [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) coms model, with three ideas grafted in from [`pi-subagents`](https://pi.dev/packages/pi-subagents): file-only large-payload handoff, a `doctor` diagnostic, and declarative model/identity metadata in the pool.

## Which one do I want?

| | `coms` (peer-to-peer) | `coms-net` (hub) |
| --- | --- | --- |
| Transport | direct Unix socket per peer | one Unix socket to a broker |
| Discovery | file registry of peer sockets | one `server.json` + pushed roster |
| Extra process | none | the hub (`bun scripts/coms-net-hub.ts`) |
| Broadcast / ask-all | no | yes (`coms_net_broadcast`) |
| Audit / observability | per-agent logs | one central log + hub stdout |
| Sweet spot | 2 agents | 3+ agents, fan-out, central policy |

For two terminals, use `coms`. Reach for `coms-net` when the pool grows or you want one place to watch and police all messages.

## Prerequisites

- [Pi](https://github.com/badlogic/pi-mono) (`pi` on your PATH)
- [Bun](https://bun.sh) — runs the hub and installs dev types
- [just](https://github.com/casey/just) — optional, for the recipes (`brew install just`)

## Install

```bash
git clone <your-fork-url> pi-coms && cd pi-coms
bun install            # dev/peer types for editor support (pin versions after)
cp .env.sample .env    # add your provider keys
```

You can run the extensions three ways:

1. **Ad-hoc (recommended while iterating):** `pi -e extensions/coms.ts`
2. **Auto-discovered:** copy a file into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local) so `/reload` works.
3. **As a Pi package:** add this repo to `settings.json` `packages` (e.g. `git:github.com/you/pi-coms@v0.1.0`). Note the manifest loads **both** `coms` and `coms-net` at once — for selective use, prefer method 1 or 2.

## Quick start — peer-to-peer (`coms`)

Two terminals, same project directory:

```bash
just coms-planner      # or: just coms planner "Plans the work"
just coms-coder        # or: just coms coder   "Writes the code"
```

Each shows a live pool widget. Ask in plain language — "ask coder to implement the plan" — and the agent uses the `coms_*` tools on its own.

## Quick start — hub (`coms-net`)

```bash
just hub               # terminal 1: the broker (Ctrl+C to stop)
just net-planner       # terminal 2
just net-coder         # terminal 3
```

The hub terminal prints every routed message, so it doubles as your live audit view.

## Tools

Peer-to-peer (`coms.ts`) and hub (`coms-net.ts`) expose the same surface, prefixed `coms_` vs `coms_net_`:

| Tool | Purpose |
| --- | --- |
| `*_list` | Live peers: name, model, live context %, purpose |
| `*_send(target, text \| payload_file)` | Send a prompt; returns a `msg_id` |
| `*_get(msg_id)` | Non-blocking poll: `pending` / `complete` / `error` |
| `*_await(msg_id, timeout_ms)` | Block until the reply lands or timeout |
| `coms_net_broadcast(text)` | (hub only) send to every peer; returns a `msg_id` each |

Commands: `/coms-doctor` and `/coms-net-doctor` print pool health, reachability, and the audit tail.

Flags (per terminal): `--coms-name`, `--coms-purpose`, `--coms-color`.

## How a reply travels back

When agent A sends to B, the prompt is injected into B's session wrapped with a `(coms-id: …)` marker. When B's turn ends, B's final assistant message is shipped back to A, correlated by that marker — so it stays correct even when B's human is also typing. The wrapper is intentionally visible (it tells B who's asking). To make it invisible, strip it in an `input` event handler (source `"extension"`) while stashing the id in a side map.

Replies larger than `*_INLINE_LIMIT` bytes (default 6000) are written to `~/.pi/coms*/projects/<project>/payloads/<msg_id>_reply.md` and the asker receives a pointer instead — keeps big handoffs out of context.

## Configuration

| Var | Default | Effect |
| --- | --- | --- |
| `PI_COMS_MAX_HOPS` / `PI_COMS_NET_MAX_HOPS` | 5 | Drop prompts exceeding this hop count |
| `PI_COMS_TIMEOUT_MS` / `PI_COMS_NET_TIMEOUT_MS` | 1800000 | Default `*_await` timeout |
| `PI_COMS_INLINE_LIMIT` / `PI_COMS_NET_INLINE_LIMIT` | 6000 | Replies larger than this go to a file |
| `PI_COMS_MAX_MESSAGE_BYTES` / `PI_COMS_NET_MAX_MESSAGE_BYTES` | 10485760 | Drop a connection whose un-framed line exceeds this |
| `PI_COMS_MAX_INBOUND` / `PI_COMS_NET_MAX_INBOUND` | 1000 | Cap in-flight inbound prompts (evict oldest) |
| `PI_COMS_INBOUND_TTL_MS` / `PI_COMS_NET_INBOUND_TTL_MS` | 3600000 | Expire inbound prompts never replied to |
| `PI_COMS_PAYLOAD_FILE_MAX_BYTES` / `PI_COMS_NET_PAYLOAD_FILE_MAX_BYTES` | 10485760 | Max `payload_file` size |
| `PI_COMS_ALLOW_PAYLOAD_OUTSIDE_CWD` / `PI_COMS_NET_ALLOW_PAYLOAD_OUTSIDE_CWD` | unset | Set to `1` to allow `payload_file` outside the project dir |
| `PI_COMS_NET_RATE_BURST` / `PI_COMS_NET_RATE_REFILL` | 100 / 50 | Hub per-connection `send`/`register` token bucket (burst / refill-per-sec) |

## Project layout

```
pi-coms/
├── extensions/
│   ├── coms.ts            # peer-to-peer extension
│   └── coms-net.ts        # hub-client extension
├── scripts/
│   └── coms-net-hub.ts    # standalone hub broker (run with bun)
├── package.json           # Pi manifest (pi.extensions) + dev types
├── justfile               # recipes
├── tsconfig.json
├── .env.sample
└── README.md
```

Runtime state lives outside the repo under `~/.pi/coms/` and `~/.pi/coms-net/projects/<project>/` (registry, sockets, payloads, audit log).

## Limitations (v1)

- **Same machine only.** Both tiers use Unix sockets. The wire protocol is transport-agnostic: to go cross-device, swap the hub's `net.createServer({ path })` for a TCP/TLS listener plus a token check — clients and tools are unchanged.
- **Hop tracking** propagates: a send made while handling forwarded prompt(s) inherits the inbound hop count + 1, so forward chains eventually trip the ceiling. It tracks in-flight inbound depth rather than a precise per-message path.
- **Reply correlation** uses the visible `(coms-id: …)` wrapper described above; replies are paired to askers by position within the turn (matching the wrapper's trailing marker on user messages only), so several concurrent inbound prompts (e.g. a broadcast) each get their own answer and a peer can't smuggle a marker to misroute one.
- **Trust model.** Both tiers are gated only by OS file permissions on the socket — any local process that can open it is a peer. Inputs are hardened defensively (envelope/`msg_id` validation, per-connection frame-size cap and hub rate limit, bounded in-flight maps, `payload_file` confined to the project dir), but there is no authentication or per-peer authorization; run only in a trusted local session.

## License

MIT — see [LICENSE](./LICENSE).
