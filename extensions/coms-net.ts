/**
 * coms-net — connect a Pi agent to a local coms-net hub (hub-and-spoke).
 *
 * Companion to coms-net-hub.ts. Where coms.ts is direct peer-to-peer (each
 * agent dials every other agent's socket), this routes everything through one
 * broker: decoupled discovery, a single audit/observability point, and clean
 * broadcast to the whole pool.
 *
 * Transport is a LOCAL Unix-domain socket to the hub — no HTTP, no ports, no
 * token. Same wire protocol as the hub; swap the hub's listener for TCP later
 * to go cross-device.
 *
 * Tools:
 *   coms_net_list                          - peers currently on the hub
 *   coms_net_send(target, text|file)       - route a prompt; returns msg_id
 *   coms_net_broadcast(text)               - send to every peer; returns msg_ids
 *   coms_net_get(msg_id)                   - non-blocking poll
 *   coms_net_await(msg_id, timeout_ms)     - block for the reply
 *
 * Commands:
 *   /coms-net-doctor                       - hub connection + roster + audit tail
 *
 * Flags: --coms-name, --coms-purpose, --coms-color (as in coms.ts)
 *
 * Start the hub first (bun coms-net-hub.ts from the project dir), then:
 *   pi -e ./coms-net.ts --coms-name planner --coms-purpose "Plans the work"
 *   pi -e ./coms-net.ts --coms-name coder   --coms-purpose "Writes the code"
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_AWAIT_MS = Number(process.env.PI_COMS_NET_TIMEOUT_MS ?? 30 * 60 * 1000);
const HEARTBEAT_MS = 10_000;
const INLINE_REPLY_LIMIT = Number(process.env.PI_COMS_NET_INLINE_LIMIT ?? 6_000);
const RECONNECT_MS = 3_000;

interface PeerRecord {
  name: string; model: string; purpose: string; color: string;
  pid: number; tokens: number; contextWindow: number; ts: number;
}
interface Pending {
  status: "pending" | "complete" | "error";
  response?: string; error?: string;
  resolvers: Array<(v: { status: string; response?: string; error?: string }) => void>;
}

export default function (pi: ExtensionAPI) {
  let selfName = "";
  let model = "unknown";
  let purpose = "general Pi agent";
  let color = "#36F9F6";
  let projectDir = "";
  let serverJson = "";
  let auditLog = "";

  let hub: net.Socket | null = null;
  let connected = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let lastCtx: ExtensionContext | null = null;

  let peers: PeerRecord[] = [];
  const pending = new Map<string, Pending>();
  const inbound = new Map<string, { from: string; hops: number }>();

  pi.registerFlag("coms-name", { description: "Peer name in the coms-net pool", type: "string" });
  pi.registerFlag("coms-purpose", { description: "One-line role shown to peers", type: "string" });
  pi.registerFlag("coms-color", { description: "Widget accent hex color", type: "string" });

  // ---- paths -------------------------------------------------------------
  function projectKey(cwd: string): string {
    const base = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-");
    const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
    return `${base}-${hash}`;
  }
  function audit(line: string) {
    try { fs.appendFileSync(auditLog, `${new Date().toISOString()} ${line}\n`); } catch { /* */ }
  }
  function tokens(): { tokens: number; contextWindow: number } {
    const u = lastCtx?.getContextUsage?.();
    return { tokens: u?.tokens ?? 0, contextWindow: u?.contextWindow ?? 0 };
  }

  // ---- hub connection ----------------------------------------------------
  function hubSocketPath(): string | null {
    try {
      if (!fs.existsSync(serverJson)) return null;
      const s = JSON.parse(fs.readFileSync(serverJson, "utf8"));
      return fs.existsSync(s.socket) ? s.socket : null;
    } catch { return null; }
  }

  function connect(ctx?: ExtensionContext) {
    const sock = hubSocketPath();
    if (!sock) { scheduleReconnect(ctx); renderWidget(ctx); return; }

    hub = net.connect({ path: sock }, () => {
      connected = true;
      const t = tokens();
      send({ t: "register", name: selfName, model, purpose, color, pid: process.pid, tokens: t.tokens, contextWindow: t.contextWindow });
      renderWidget(ctx);
    });

    let buf = "";
    hub.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) onHubMessage(line, ctx);
      }
    });
    const lost = () => {
      if (connected) audit("HUB CONNECTION LOST");
      connected = false; hub = null;
      scheduleReconnect(ctx); renderWidget(ctx);
    };
    hub.on("close", lost);
    hub.on("error", lost);
  }

  function scheduleReconnect(ctx?: ExtensionContext) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(ctx ?? lastCtx ?? undefined); }, RECONNECT_MS);
  }

  function send(obj: unknown): boolean {
    if (!hub || !connected) return false;
    try { hub.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
  }

  function onHubMessage(raw: string, ctx?: ExtensionContext) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === "roster") {
      peers = (m.peers as PeerRecord[]).filter((p) => p.name !== selfName);
      renderWidget(ctx);
    } else if (m.t === "registered") {
      audit(`ONLINE ${selfName}`);
    } else if (m.t === "deliver") {
      // inbound prompt from a peer
      inbound.set(m.msg_id, { from: m.from, hops: m.hops });
      audit(`RECV ${m.msg_id} ${m.from}->${selfName} hops=${m.hops}`);
      const wrapped =
        `[coms-net] Message from peer "${m.from}". Your reply will be sent back to them automatically.\n\n` +
        `${m.text}\n\n(coms-id: ${m.msg_id})`;
      pi.sendUserMessage(wrapped, { deliverAs: "followUp" });
    } else if (m.t === "response") {
      // reply to something we sent
      const p = pending.get(m.msg_id);
      audit(`REPLY ${m.msg_id} ${m.from}->${selfName}${m.isError ? " ERR" : ""}`);
      if (p) {
        p.status = m.isError ? "error" : "complete";
        if (m.isError) p.error = m.text; else p.response = m.text;
        const payload = { status: p.status, response: p.response, error: p.error };
        for (const r of p.resolvers) r(payload);
        p.resolvers = [];
      }
    }
  }

  // ---- reply routing (same coms-id correlation as coms.ts) ---------------
  pi.on("agent_end", async (event, _ctx) => {
    if (inbound.size === 0) return;
    const messages = (event as any).messages ?? [];
    let matchedId: string | undefined;
    for (const msg of messages) {
      const found = extractText(msg).match(/\(coms-id:\s*(msg_[a-f0-9]+)\)/);
      if (found && inbound.has(found[1])) { matchedId = found[1]; break; }
    }
    if (!matchedId) return;

    const rec = inbound.get(matchedId)!;
    inbound.delete(matchedId);

    let replyText = "";
    for (const msg of messages) if (msg?.role === "assistant") replyText = extractText(msg) || replyText;
    replyText = replyText.trim() || "(no response)";

    // file-only handoff for large replies (from pi-subagents)
    let outText = replyText;
    if (replyText.length > INLINE_REPLY_LIMIT) {
      const payloadsDir = path.join(projectDir, "payloads");
      try {
        fs.mkdirSync(payloadsDir, { recursive: true });
        const file = path.join(payloadsDir, `${matchedId}_reply.md`);
        fs.writeFileSync(file, replyText);
        outText = `Reply saved to: ${file} (${formatSize(replyText.length)}, ${replyText.split("\n").length} lines). Read this file for the full response.`;
      } catch { /* fall back to inline */ }
    }
    send({ t: "reply", msg_id: matchedId, from: selfName, to: rec.from, text: outText });
  });

  function extractText(m: any): string {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
    return "";
  }
  function formatSize(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  // ---- send helper -------------------------------------------------------
  function routePrompt(target: string, text: string): string {
    if (!connected) throw new Error("Not connected to a coms-net hub. Start it with: bun coms-net-hub.ts");
    const msg_id = `msg_${crypto.randomBytes(5).toString("hex")}`;
    pending.set(msg_id, { status: "pending", resolvers: [] });
    const ok = send({ t: "send", msg_id, from: selfName, to: target, hops: 1, text });
    if (!ok) { pending.delete(msg_id); throw new Error("Failed to write to hub"); }
    audit(`SEND ${msg_id} ${selfName}->${target}`);
    return msg_id;
  }

  // ---- widget ------------------------------------------------------------
  function renderWidget(ctx?: ExtensionContext) {
    const c = ctx ?? lastCtx;
    if (!c?.hasUI) return;
    const lines: string[] = [];
    const status = connected ? "connected" : "no hub — run: bun coms-net-hub.ts";
    lines.push(`coms-net · "${selfName}" (${model}) · ${status}`);
    if (connected) {
      if (peers.length === 0) lines.push("  no peers online yet");
      for (const p of peers) {
        const pct = p.contextWindow ? `${Math.round((p.tokens / p.contextWindow) * 100)}%` : "n/a";
        lines.push(`  • ${p.name} — ${p.model} ${pct} — ${p.purpose}`);
      }
    }
    c.ui.setWidget("coms-net-pool", lines);
  }

  // ---- tools -------------------------------------------------------------
  pi.registerTool({
    name: "coms_net_list",
    label: "Coms-Net List",
    description: "List peer Pi agents currently connected to the hub, with model, live context usage, and purpose.",
    promptSnippet: "List peer agents on the coms-net hub",
    parameters: Type.Object({}),
    async execute(_id, _p, _s, _u, ctx) {
      lastCtx = ctx; renderWidget(ctx);
      if (!connected) return { content: [{ type: "text", text: "Not connected to a hub. Start it: bun coms-net-hub.ts" }], details: {} };
      if (peers.length === 0) return { content: [{ type: "text", text: "No other peers connected to the hub yet." }], details: {} };
      const text = peers.map((p) => {
        const pct = p.contextWindow ? `${Math.round((p.tokens / p.contextWindow) * 100)}% ctx` : "ctx n/a";
        return `- ${p.name} (${p.model}, ${pct}): ${p.purpose}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: { peers } };
    },
  });

  pi.registerTool({
    name: "coms_net_send",
    label: "Coms-Net Send",
    description: "Route a prompt to a peer via the hub. Returns a msg_id. Use coms_net_get to poll or coms_net_await to block.",
    promptSnippet: "Route a prompt to a peer; returns a msg_id",
    promptGuidelines: ["Call coms_net_list first if unsure which peers exist.", "Use coms_net_await when you need the reply before continuing."],
    parameters: Type.Object({
      target: Type.String({ description: "Peer name (see coms_net_list)" }),
      text: Type.Optional(Type.String()),
      payload_file: Type.Optional(Type.String({ description: "Path to a file used as the prompt body (large payloads)" })),
    }),
    async execute(_id, params, _s, _u, ctx) {
      lastCtx = ctx;
      let body = params.text ?? "";
      if (params.payload_file) {
        const abs = path.resolve(ctx.cwd, params.payload_file.replace(/^@/, ""));
        body = `${body ? body + "\n\n" : ""}${fs.readFileSync(abs, "utf8")}`;
      }
      if (!body.trim()) throw new Error("coms_net_send needs text or a non-empty payload_file");
      const msg_id = routePrompt(params.target, body);
      return { content: [{ type: "text", text: `Routed to ${params.target}. msg_id=${msg_id} (pending). Use coms_net_await("${msg_id}").` }], details: { msg_id, target: params.target } };
    },
  });

  pi.registerTool({
    name: "coms_net_broadcast",
    label: "Coms-Net Broadcast",
    description: "Send the same prompt to every connected peer. Returns one msg_id per peer; await each to gather answers.",
    promptSnippet: "Ask every peer the same thing at once",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params, _s, _u, ctx) {
      lastCtx = ctx;
      if (!connected) throw new Error("Not connected to a hub.");
      if (peers.length === 0) throw new Error("No peers to broadcast to.");
      const sent = peers.map((p) => ({ peer: p.name, msg_id: routePrompt(p.name, params.text) }));
      const text = sent.map((s) => `${s.peer}: ${s.msg_id}`).join("\n");
      return { content: [{ type: "text", text: `Broadcast to ${sent.length} peers:\n${text}` }], details: { sent } };
    },
  });

  pi.registerTool({
    name: "coms_net_get",
    label: "Coms-Net Get",
    description: "Non-blocking poll on a msg_id: pending | complete (with reply) | error.",
    promptSnippet: "Poll a coms-net msg_id without blocking",
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
    name: "coms_net_await",
    label: "Coms-Net Await",
    description: "Block until the reply for a msg_id arrives or the timeout fires.",
    promptSnippet: "Block until a coms-net reply lands",
    parameters: Type.Object({ msg_id: Type.String(), timeout_ms: Type.Optional(Type.Number()) }),
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
        signal?.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
        p.resolvers.push((v) => { clearTimeout(timer); resolve(v); });
      });
      if (result.status === "timeout") throw new Error(`Timed out after ${timeout}ms`);
      if (result.status === "aborted") throw new Error("Cancelled");
      if (result.status === "error") throw new Error(result.error);
      return { content: [{ type: "text", text: result.response ?? "" }], details: { status: "complete" } };
    },
  });

  pi.registerCommand("coms-net-doctor", {
    description: "Show coms-net hub connection, roster, and audit tail",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push(`project dir: ${projectDir}`);
      lines.push(`hub: ${hubSocketPath() ?? "not found (start: bun coms-net-hub.ts)"}`);
      lines.push(`connection: ${connected ? "connected" : "disconnected"}`);
      lines.push(`self: ${selfName} (${model})`);
      lines.push(`peers (${peers.length}): ${peers.map((p) => p.name).join(", ") || "none"}`);
      lines.push(`pending awaits: ${pending.size}, inbound in-flight: ${inbound.size}`);
      try {
        const tail = fs.readFileSync(auditLog, "utf8").trim().split("\n").slice(-8).join("\n");
        if (tail) lines.push("recent audit:\n" + tail.split("\n").map((l) => "  " + l).join("\n"));
      } catch { /* */ }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- lifecycle ---------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    const project = projectKey(ctx.cwd);
    projectDir = path.join(os.homedir(), ".pi", "coms-net", "projects", project);
    serverJson = path.join(projectDir, "server.json");
    auditLog = path.join(projectDir, "coms-net-log");
    fs.mkdirSync(projectDir, { recursive: true });

    model = ctx.model ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : "unknown";
    const flagName = (pi.getFlag?.("coms-name") as string) || "";
    selfName = (flagName || model.split("/").pop() || `pi-${process.pid}`).replace(/[^a-zA-Z0-9_-]/g, "-");
    purpose = (pi.getFlag?.("coms-purpose") as string) || purpose;
    color = (pi.getFlag?.("coms-color") as string) || color;

    connect(ctx);
    heartbeat = setInterval(() => {
      const t = tokens();
      send({ t: "ping", name: selfName, tokens: t.tokens, contextWindow: t.contextWindow });
      renderWidget();
    }, HEARTBEAT_MS);
  });

  pi.on("turn_end", async (_event, ctx) => { lastCtx = ctx; renderWidget(ctx); });

  pi.on("session_shutdown", async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (hub) try { hub.destroy(); } catch { /* */ }
  });
}
