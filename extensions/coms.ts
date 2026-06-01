/**
 * coms — flat peer-to-peer messaging between Pi agents on the same machine.
 *
 * Spine: disler's `coms` model (pi-vs-claude-code) — Unix-socket peers, a file
 * registry for discovery, four tools, a live pool widget, and three safety rails
 * (hop limit, audit log, self-heal).
 *
 * Grafted from pi-subagents: file-only large-payload handoff (keep big replies
 * out of context), a `/coms-doctor` diagnostic, and declarative identity/model
 * metadata so `coms_list` shows each peer's model and live token usage.
 *
 * Tools (callable by the LLM):
 *   coms_list                      - list live peers (name, model, tokens, purpose)
 *   coms_send(target, text, ...)   - send a prompt to a peer; returns a msg_id once acked
 *   coms_get(msg_id)               - non-blocking poll: pending | complete | error
 *   coms_await(msg_id, timeout_ms) - block until the reply lands or timeout
 *
 * Commands:
 *   /coms-doctor                   - registry health, socket reachability, audit tail
 *
 * Flags (set per terminal):
 *   --coms-name <name>     identity in the pool (default: model-or-pid)
 *   --coms-purpose <text>  one-line role shown to peers
 *   --coms-color <hex>     widget accent
 *
 * Run two terminals in the same project dir:
 *   pi -e ./coms.ts --coms-name planner --coms-purpose "Plans the work"
 *   pi -e ./coms.ts --coms-name coder   --coms-purpose "Writes the code"
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config (env-overridable, mirrors disler's PI_COMS_* knobs)
// ---------------------------------------------------------------------------
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS ?? 5);
const DEFAULT_AWAIT_MS = Number(process.env.PI_COMS_TIMEOUT_MS ?? 30 * 60 * 1000);
const HEARTBEAT_MS = 10_000;
// Replies larger than this are written to a file and only a pointer is returned.
const INLINE_REPLY_LIMIT = Number(process.env.PI_COMS_INLINE_LIMIT ?? 6_000);

// Hardening limits (all env-overridable).
// Drop a connection whose un-framed line (no newline yet) exceeds this, so a peer
// can't exhaust memory with one giant line before JSON.parse ever runs.
const MAX_MESSAGE_BYTES = Number(process.env.PI_COMS_MAX_MESSAGE_BYTES ?? 10 * 1024 * 1024);
// Cap receiver-side in-flight prompts and expire ones never replied to, so a peer
// that sends and disconnects can't grow `inbound` without bound.
const MAX_INBOUND = Number(process.env.PI_COMS_MAX_INBOUND ?? 1_000);
const INBOUND_TTL_MS = Number(process.env.PI_COMS_INBOUND_TTL_MS ?? 60 * 60 * 1000);
// payload_file is resolved against cwd and must stay inside it (override with =1),
// with a size ceiling — it's an LLM-callable arbitrary-file read otherwise.
const PAYLOAD_FILE_MAX_BYTES = Number(process.env.PI_COMS_PAYLOAD_FILE_MAX_BYTES ?? 10 * 1024 * 1024);
const ALLOW_PAYLOAD_OUTSIDE_CWD = process.env.PI_COMS_ALLOW_PAYLOAD_OUTSIDE_CWD === "1";
// We mint ids as "msg_" + 10 lowercase hex chars. Reject anything else at ingress so
// a peer can't poison the maps or smuggle path separators into a payload filename.
const MSG_ID_RE = /^msg_[0-9a-f]{10}$/;

// ---------------------------------------------------------------------------
// Envelope types sent over the wire (newline-delimited JSON)
// ---------------------------------------------------------------------------
type Envelope =
  | { type: "prompt"; msg_id: string; from: string; to: string; hops: number; text: string }
  | { type: "ack"; msg_id: string }
  | { type: "response"; msg_id: string; from: string; text: string; isError?: boolean };

interface PeerRecord {
  name: string;
  model: string;
  purpose: string;
  color: string;
  pid: number;
  socket: string;
  tokens: number;
  contextWindow: number;
  ts: number;
}

interface Pending {
  status: "pending" | "complete" | "error";
  response?: string;
  error?: string;
  resolvers: Array<(v: { status: string; response?: string; error?: string }) => void>;
}

export default function (pi: ExtensionAPI) {
  // identity + paths, resolved in session_start
  let self: PeerRecord | null = null;
  let projectDir = "";
  let agentsDir = "";
  let payloadsDir = "";
  let auditLog = "";
  let server: net.Server | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  // sender side: msg_id -> pending reply we are awaiting
  const pending = new Map<string, Pending>();
  // receiver side: msg_id -> who asked + hop count + arrival time, set when a prompt arrives
  const inbound = new Map<string, { from: string; hops: number; ts: number }>();

  pi.registerFlag("coms-name", { description: "Peer name in the coms pool", type: "string" });
  pi.registerFlag("coms-purpose", { description: "One-line role shown to peers", type: "string" });
  pi.registerFlag("coms-color", { description: "Widget accent hex color", type: "string" });

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------
  function projectKey(cwd: string): string {
    const base = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-");
    const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
    return `${base}-${hash}`;
  }

  function ensureDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function readPeers(): PeerRecord[] {
    if (!fs.existsSync(agentsDir)) return [];
    const out: PeerRecord[] = [];
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(agentsDir, file);
      try {
        const rec = JSON.parse(fs.readFileSync(full, "utf8")) as PeerRecord;
        // self-heal: prune dead PIDs and missing sockets
        if (!isAlive(rec.pid) || !fs.existsSync(rec.socket)) {
          try { fs.unlinkSync(full); } catch { /* race with another pruner */ }
          continue;
        }
        out.push(rec);
      } catch {
        try { fs.unlinkSync(full); } catch { /* malformed, drop it */ }
      }
    }
    return out;
  }

  function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function audit(line: string) {
    // bodies are NEVER logged — only routing metadata
    try { fs.appendFileSync(auditLog, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
  }

  // Drop inbound prompts that were never replied to within the TTL (sender vanished
  // or its marker never came back), and evict the oldest when at the size cap.
  function sweepInbound() {
    const now = Date.now();
    for (const [id, rec] of inbound) if (now - rec.ts > INBOUND_TTL_MS) { inbound.delete(id); audit(`EXPIRE ${id}`); }
  }
  function evictOldestInbound() {
    let oldestId: string | undefined;
    let oldestTs = Infinity;
    for (const [id, rec] of inbound) if (rec.ts < oldestTs) { oldestTs = rec.ts; oldestId = id; }
    if (oldestId) { inbound.delete(oldestId); audit(`EVICT ${oldestId} (inbound cap ${MAX_INBOUND})`); }
  }

  // Read a payload_file for coms_send, confined to the project dir and size-capped.
  // Without this an LLM steered by a peer's prompt could read arbitrary local files.
  function readPayloadFile(cwd: string, spec: string): string {
    const root = path.resolve(cwd);
    const abs = path.resolve(root, spec.replace(/^@/, ""));
    if (!ALLOW_PAYLOAD_OUTSIDE_CWD && abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`payload_file must be inside the project dir (${root}). Set PI_COMS_ALLOW_PAYLOAD_OUTSIDE_CWD=1 to override.`);
    }
    const size = fs.statSync(abs).size;
    if (size > PAYLOAD_FILE_MAX_BYTES) throw new Error(`payload_file too large (${size}B > ${PAYLOAD_FILE_MAX_BYTES}B limit)`);
    return fs.readFileSync(abs, "utf8");
  }

  function writeSelf(ctx?: ExtensionContext) {
    if (!self) return;
    if (ctx) {
      const usage = ctx.getContextUsage?.();
      if (usage) {
        self.tokens = usage.tokens ?? self.tokens;
        self.contextWindow = usage.contextWindow ?? self.contextWindow;
      }
    }
    self.ts = Date.now();
    try {
      fs.writeFileSync(path.join(agentsDir, `${self.name}.json`), JSON.stringify(self, null, 2));
    } catch { /* best effort */ }
  }

  // -------------------------------------------------------------------------
  // Socket server: handles both inbound prompts (we're a receiver) and
  // inbound responses (we're a sender awaiting a reply).
  // -------------------------------------------------------------------------
  function startServer() {
    if (!self) return;
    try { if (fs.existsSync(self.socket)) fs.unlinkSync(self.socket); } catch { /* stale */ }

    server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.length > MAX_MESSAGE_BYTES) {
          audit(`DROP oversized frame (${buf.length}B > ${MAX_MESSAGE_BYTES}B)`);
          buf = "";
          try { sock.destroy(); } catch { /* */ }
          return;
        }
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleEnvelope(line, sock);
        }
      });
      sock.on("error", () => { /* peer vanished mid-stream */ });
    });
    server.on("error", (err) => {
      // surface to footer rather than crashing the host
      pi.events.emit("coms:error", { message: String(err) });
    });
    server.listen(self.socket);
  }

  function handleEnvelope(line: string, sock: net.Socket) {
    let env: Envelope;
    try { env = JSON.parse(line) as Envelope; } catch { return; }

    if (env.type === "prompt") {
      // ---- we are the receiver ----
      // Reject malformed envelopes before they touch the maps or the followUp queue.
      if (!MSG_ID_RE.test(env.msg_id ?? "") || typeof env.from !== "string" || typeof env.text !== "string" || typeof env.hops !== "number") {
        audit(`REJECT malformed prompt from ${String(env.from)}`);
        return;
      }
      if (env.hops > MAX_HOPS) {
        audit(`DROP ${env.msg_id} ${env.from} hops=${env.hops}`);
        sendTo(env.from, { type: "response", msg_id: env.msg_id, from: self!.name, text: `Dropped: hop limit ${MAX_HOPS} exceeded`, isError: true });
        return;
      }
      // Bound memory: evict the oldest in-flight prompt if we're at the cap.
      if (inbound.size >= MAX_INBOUND && !inbound.has(env.msg_id)) evictOldestInbound();
      try { sock.write(JSON.stringify({ type: "ack", msg_id: env.msg_id } as Envelope) + "\n"); } catch { /* */ }
      inbound.set(env.msg_id, { from: env.from, hops: env.hops, ts: Date.now() });
      audit(`RECV ${env.msg_id} ${env.from}->${self!.name} hops=${env.hops}`);

      const wrapped =
        `[coms] Message from peer "${env.from}". Your reply will be sent back to them automatically.\n\n` +
        `${env.text}\n\n` +
        `(coms-id: ${env.msg_id})`;
      // followUp: queue until idle so it becomes the next processed prompt
      pi.sendUserMessage(wrapped, { deliverAs: "followUp" });
    } else if (env.type === "ack") {
      // handled inline by the sender's connection logic (see sendPrompt)
      pi.events.emit(`coms:ack:${env.msg_id}`, {});
    } else if (env.type === "response") {
      // ---- we are the sender, reply has arrived ----
      audit(`REPLY ${env.msg_id} ${env.from}->${self!.name}${env.isError ? " ERR" : ""}`);
      const p = pending.get(env.msg_id);
      if (p) {
        p.status = env.isError ? "error" : "complete";
        if (env.isError) p.error = env.text; else p.response = env.text;
        const payload = { status: p.status, response: p.response, error: p.error };
        for (const r of p.resolvers) r(payload);
        p.resolvers = [];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------
  function peerByName(name: string): PeerRecord | undefined {
    return readPeers().find((p) => p.name === name);
  }

  // Outgoing hop count. If we're currently handling forwarded inbound prompt(s),
  // continue their chain (+1) so A->B->C->... eventually trips MAX_HOPS instead of
  // looping forever; an agent-initiated send (no inbound in flight) starts at 1.
  // This tracks in-flight inbound depth, not a precise per-message path, and only
  // over-counts while unrelated inbound is briefly pending — which fails safe.
  function nextHops(): number {
    let max = 0;
    for (const rec of inbound.values()) if (rec.hops > max) max = rec.hops;
    return max + 1;
  }

  // fire-and-forget delivery of an envelope to a named peer
  function sendTo(name: string, env: Envelope): Promise<void> {
    return new Promise((resolve) => {
      const peer = peerByName(name);
      if (!peer) { resolve(); return; }
      const c = net.connect({ path: peer.socket }, () => {
        c.write(JSON.stringify(env) + "\n");
        c.end();
      });
      c.on("error", () => resolve());
      c.on("close", () => resolve());
    });
  }

  // send a prompt and resolve once the receiver acks (or rejects on failure)
  function sendPrompt(target: string, text: string, hops: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = peerByName(target);
      if (!peer) { reject(new Error(`No live peer named "${target}". Try coms_list.`)); return; }

      const msg_id = `msg_${crypto.randomBytes(5).toString("hex")}`;
      const env: Envelope = { type: "prompt", msg_id, from: self!.name, to: target, hops, text };

      const acked = { done: false };
      const ackTimer = setTimeout(() => {
        if (!acked.done) reject(new Error(`Peer "${target}" did not ack within 10s`));
      }, 10_000);

      const c = net.connect({ path: peer.socket }, () => {
        c.write(JSON.stringify(env) + "\n");
      });
      let cbuf = "";
      c.on("data", (chunk) => {
        cbuf += chunk.toString("utf8");
        let nl: number;
        while ((nl = cbuf.indexOf("\n")) >= 0) {
          const line = cbuf.slice(0, nl); cbuf = cbuf.slice(nl + 1);
          try {
            const reply = JSON.parse(line) as Envelope;
            if (reply.type === "ack" && reply.msg_id === msg_id) {
              acked.done = true;
              clearTimeout(ackTimer);
              pending.set(msg_id, { status: "pending", resolvers: [] });
              audit(`SEND ${msg_id} ${self!.name}->${target} hops=${hops}`);
              c.end();
              resolve(msg_id);
            }
          } catch { /* ignore */ }
        }
      });
      c.on("error", (err) => { clearTimeout(ackTimer); reject(err); });
    });
  }

  // -------------------------------------------------------------------------
  // Reply routing: when a coms-triggered turn ends, ship the final assistant
  // message back to whoever asked. Correlation is by the embedded coms-id, so
  // it survives interleaving with the human's own prompts.
  // -------------------------------------------------------------------------
  pi.on("agent_end", async (event, _ctx) => {
    if (inbound.size === 0) return;
    const messages = (event as any).messages ?? [];

    // Pair each inbound coms-id with the final assistant message that followed
    // it, walking the turn in order. A single agent run can carry several
    // injected prompts (followUps processed back-to-back), so matching by
    // position keeps each reply with its own asker instead of cross-wiring them
    // or orphaning all but the first.
    //
    // Scan only user messages, and take the LAST coms-id in each: our wrapper
    // always appends the genuine marker as the trailer (after the peer-supplied
    // body), so a peer can't smuggle an earlier id to steal a concurrent reply,
    // and a tool result that echoes the marker can't trigger a spurious flush.
    // Reserve each entry (delete + capture `from`) here, before any await, so a
    // re-entrant agent_end can't rebuild the list and double-send.
    const replies: Array<{ id: string; from: string; text: string }> = [];
    let cur: { id: string; from: string; text: string } | null = null;
    const flush = () => { if (cur) replies.push(cur); cur = null; };
    for (const m of messages) {
      if (m?.role === "user") {
        const ids = [...extractText(m).matchAll(/\(coms-id:\s*(msg_[a-f0-9]+)\)/g)];
        const id = ids.at(-1)?.[1];
        const rec = id ? inbound.get(id) : undefined;
        // reserving (delete) means a repeated id yields rec===undefined next time, so no re-flush guard needed
        if (id && rec) { flush(); inbound.delete(id); cur = { id, from: rec.from, text: "" }; continue; }
      }
      if (cur && m?.role === "assistant") {
        const t = extractText(m).trim();
        if (t) cur.text = t; // keep the latest assistant text for this id
      }
    }
    flush();

    for (const { id, from, text } of replies) {
      const body = text.trim() || "(no response)";
      // pi-subagents-style file-only handoff for large replies
      let outText = body;
      if (body.length > INLINE_REPLY_LIMIT) {
        ensureDir(payloadsDir);
        const file = path.join(payloadsDir, `${id}_reply.md`);
        try {
          fs.writeFileSync(file, body);
          outText = `Reply saved to: ${file} (${formatSize(body.length)}, ${body.split("\n").length} lines). Read this file for the full response.`;
        } catch { /* fall back to inline */ }
      }
      await sendTo(from, { type: "response", msg_id: id, from: self!.name, text: outText });
    }
  });

  function extractText(m: any): string {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
    }
    return "";
  }

  function formatSize(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  // -------------------------------------------------------------------------
  // Pool widget
  // -------------------------------------------------------------------------
  function renderWidget(ctx?: ExtensionContext) {
    if (!ctx?.hasUI || !self) return;
    const peers = readPeers().filter((p) => p.name !== self!.name);
    const lines: string[] = [];
    const pct = self.contextWindow ? Math.round((self.tokens / self.contextWindow) * 100) : 0;
    lines.push(`coms · you are "${self.name}" (${self.model}) ${pct}% ctx`);
    if (peers.length === 0) {
      lines.push("  no peers online — start another pi with --coms-name");
    } else {
      for (const p of peers) {
        const ppct = p.contextWindow ? Math.round((p.tokens / p.contextWindow) * 100) : 0;
        const age = Math.round((Date.now() - p.ts) / 1000);
        const stale = age > HEARTBEAT_MS / 1000 * 3 ? " (stale)" : "";
        lines.push(`  • ${p.name} — ${p.model} ${ppct}% — ${p.purpose}${stale}`);
      }
    }
    ctx.ui.setWidget("coms-pool", lines);
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "coms_list",
    label: "Coms List",
    description: "List live peer Pi agents in this project's pool, with name, model, live context usage, and purpose.",
    promptSnippet: "List peer agents you can message via coms",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const peers = readPeers().filter((p) => p.name !== self?.name);
      renderWidget(ctx);
      if (peers.length === 0) {
        return { content: [{ type: "text", text: "No other peers online. Start another pi instance with --coms-name in this same project directory." }], details: {} };
      }
      const text = peers.map((p) => {
        const pct = p.contextWindow ? `${Math.round((p.tokens / p.contextWindow) * 100)}% ctx` : "ctx n/a";
        return `- ${p.name} (${p.model}, ${pct}): ${p.purpose}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: { peers } };
    },
  });

  pi.registerTool({
    name: "coms_send",
    label: "Coms Send",
    description: "Send a prompt to a peer agent by name. Returns a msg_id once the peer acknowledges. Use coms_get to poll or coms_await to block for the reply.",
    promptSnippet: "Send a prompt to a peer agent; returns a msg_id",
    promptGuidelines: ["Call coms_list first if you are unsure which peers exist.", "Use coms_await when you need the answer before continuing; use coms_get for fire-and-forget pings."],
    parameters: Type.Object({
      target: Type.String({ description: "Peer name to send to (see coms_list)" }),
      text: Type.Optional(Type.String({ description: "Prompt text. Omit if using payload_file." })),
      payload_file: Type.Optional(Type.String({ description: "Path to a file whose contents become the prompt body (for large payloads)." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      let body = params.text ?? "";
      if (params.payload_file) {
        body = `${body ? body + "\n\n" : ""}${readPayloadFile(ctx.cwd, params.payload_file)}`;
      }
      if (!body.trim()) throw new Error("coms_send requires text or a non-empty payload_file");
      const msg_id = await sendPrompt(params.target, body, nextHops());
      renderWidget(ctx);
      return { content: [{ type: "text", text: `Sent to ${params.target}. msg_id=${msg_id} (status: pending). Use coms_await("${msg_id}") to wait for the reply.` }], details: { msg_id, target: params.target } };
    },
  });

  pi.registerTool({
    name: "coms_get",
    label: "Coms Get",
    description: "Non-blocking poll on a msg_id. Returns pending, complete (with the reply), or error.",
    promptSnippet: "Poll a coms msg_id without blocking",
    parameters: Type.Object({ msg_id: Type.String() }),
    async execute(_id, params) {
      const p = pending.get(params.msg_id);
      if (!p) throw new Error(`Unknown msg_id "${params.msg_id}".`);
      if (p.status === "pending") return { content: [{ type: "text", text: "pending" }], details: { status: "pending" } };
      if (p.status === "error") return { content: [{ type: "text", text: `error: ${p.error}` }], details: { status: "error" } };
      return { content: [{ type: "text", text: p.response ?? "" }], details: { status: "complete" } };
    },
  });

  pi.registerTool({
    name: "coms_await",
    label: "Coms Await",
    description: "Block until the reply for a msg_id arrives or the timeout fires. Returns the peer's response text.",
    promptSnippet: "Block until a coms reply lands",
    parameters: Type.Object({
      msg_id: Type.String(),
      timeout_ms: Type.Optional(Type.Number({ description: `Default ${DEFAULT_AWAIT_MS}ms` })),
    }),
    async execute(_id, params, signal) {
      const p = pending.get(params.msg_id);
      if (!p) throw new Error(`Unknown msg_id "${params.msg_id}".`);
      if (p.status !== "pending") {
        if (p.status === "error") throw new Error(p.error);
        return { content: [{ type: "text", text: p.response ?? "" }], details: { status: "complete" } };
      }
      const timeout = params.timeout_ms ?? DEFAULT_AWAIT_MS;
      const result = await new Promise<{ status: string; response?: string; error?: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ status: "timeout" }), timeout);
        const onAbort = () => resolve({ status: "aborted" });
        signal?.addEventListener("abort", onAbort, { once: true });
        p.resolvers.push((v) => { clearTimeout(timer); resolve(v); });
      });
      if (result.status === "timeout") throw new Error(`Timed out after ${timeout}ms waiting on ${params.msg_id}`);
      if (result.status === "aborted") throw new Error("Cancelled");
      if (result.status === "error") throw new Error(result.error);
      return { content: [{ type: "text", text: result.response ?? "" }], details: { status: "complete" } };
    },
  });

  // -------------------------------------------------------------------------
  // /coms-doctor — diagnostics (borrowed from pi-subagents' doctor)
  // -------------------------------------------------------------------------
  pi.registerCommand("coms-doctor", {
    description: "Show coms pool health: peers, socket reachability, audit tail",
    handler: async (_args, ctx) => {
      const peers = readPeers();
      const lines: string[] = [];
      lines.push(`project: ${projectDir}`);
      lines.push(`self: ${self?.name} (${self?.model}) socket=${self?.socket}`);
      lines.push(`server listening: ${server?.listening ? "yes" : "no"}`);
      lines.push(`peers (${peers.length}):`);
      for (const p of peers) {
        const reachable = fs.existsSync(p.socket) && isAlive(p.pid);
        lines.push(`  ${reachable ? "✓" : "✗"} ${p.name} pid=${p.pid} ${p.socket}`);
      }
      lines.push(`pending awaits: ${pending.size}, inbound in-flight: ${inbound.size}`);
      try {
        const tail = fs.readFileSync(auditLog, "utf8").trim().split("\n").slice(-8).join("\n");
        if (tail) lines.push("recent audit:\n" + tail.split("\n").map((l) => "  " + l).join("\n"));
      } catch { /* no log yet */ }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    projectDir = path.join(os.homedir(), ".pi", "coms", "projects", projectKey(ctx.cwd));
    agentsDir = path.join(projectDir, "agents");
    payloadsDir = path.join(projectDir, "payloads");
    auditLog = path.join(projectDir, "coms-log");
    ensureDir(agentsDir);
    ensureDir(payloadsDir);

    const model = ctx.model ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : "unknown";
    const flagName = (pi.getFlag?.("coms-name") as string) || "";
    const name = (flagName || model.split("/").pop() || `pi-${process.pid}`).replace(/[^a-zA-Z0-9_-]/g, "-");
    const usage = ctx.getContextUsage?.();

    self = {
      name,
      model,
      purpose: (pi.getFlag?.("coms-purpose") as string) || "general Pi agent",
      color: (pi.getFlag?.("coms-color") as string) || "#36F9F6",
      pid: process.pid,
      socket: path.join(projectDir, `${name}.sock`),
      tokens: usage?.tokens ?? 0,
      contextWindow: usage?.contextWindow ?? 0,
      ts: Date.now(),
    };

    startServer();
    writeSelf(ctx);
    renderWidget(ctx);
    audit(`ONLINE ${self.name} pid=${self.pid}`);

    heartbeat = setInterval(() => { writeSelf(ctx); renderWidget(ctx); sweepInbound(); }, HEARTBEAT_MS);
  });

  pi.on("turn_end", async (_event, ctx) => { writeSelf(ctx); renderWidget(ctx); });

  pi.on("session_shutdown", async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (server) try { server.close(); } catch { /* */ }
    if (self) {
      audit(`OFFLINE ${self.name}`);
      try { fs.unlinkSync(path.join(agentsDir, `${self.name}.json`)); } catch { /* */ }
      try { fs.unlinkSync(self.socket); } catch { /* */ }
    }
  });
}
