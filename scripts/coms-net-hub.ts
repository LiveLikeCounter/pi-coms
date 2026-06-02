/**
 * coms-net-hub — a local message broker for Pi agents (hub-and-spoke).
 *
 * This is the `coms-net` architecture (central hub, persistent connections,
 * server-pushed roster) over a LOCAL Unix-domain socket instead of HTTP/SSE.
 * No ports, no auth token — access is gated by OS file permissions on the
 * socket, the same way disler's local `coms` tier is.
 *
 * The wire protocol is transport-agnostic. To go cross-device later, swap the
 * `net.createServer({ path })` listener for a TCP/TLS listener plus a token
 * check in `onMessage`; nothing else changes.
 *
 * Run it from your project directory (same dir the agents run in):
 *   bun coms-net-hub.ts
 *   # or with node + tsx:  npx tsx coms-net-hub.ts
 *
 * Then start agents with the coms-hub.ts extension. They auto-discover the hub
 * via server.json. Ctrl+C to stop the hub.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const MAX_HOPS = Number(process.env.PI_COMS_NET_MAX_HOPS ?? 5);
const HEARTBEAT_MS = 10_000;
const STALE_AFTER = HEARTBEAT_MS * 3;

// Hardening limits (all env-overridable).
// Drop a connection whose un-framed line exceeds this (memory-exhaustion guard).
const MAX_MESSAGE_BYTES = Number(process.env.PI_COMS_NET_MAX_MESSAGE_BYTES ?? 10 * 1024 * 1024);
// Per-connection token bucket throttling `send`/`register`: capacity allows a burst
// (e.g. one broadcast fanning to many peers), refill caps the sustained rate so a
// compromised peer can't flood the pool. ping/reply pass freely.
const RATE_BURST = Number(process.env.PI_COMS_NET_RATE_BURST ?? 100);
const RATE_REFILL_PER_SEC = Number(process.env.PI_COMS_NET_RATE_REFILL ?? 50);
const MSG_ID_RE = /^msg_[0-9a-f]{10}$/;

interface Bound { name?: string; tokens: number; last: number; }

// Refill then spend one token; false means the connection is over its rate budget.
function takeToken(bound: Bound): boolean {
  const now = Date.now();
  bound.tokens = Math.min(RATE_BURST, bound.tokens + ((now - bound.last) / 1000) * RATE_REFILL_PER_SEC);
  bound.last = now;
  if (bound.tokens < 1) return false;
  bound.tokens -= 1;
  return true;
}

function projectKey(cwd: string): string {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-");
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

interface PeerRecord {
  name: string;
  model: string;
  purpose: string;
  color: string;
  pid: number;
  tokens: number;
  contextWindow: number;
  ts: number;
}

interface Client {
  conn: net.Socket;
  record: PeerRecord;
}

const cwd = process.cwd();
const project = projectKey(cwd);
const projectDir = path.join(os.homedir(), ".pi", "coms-net", "projects", project);
const socketPath = path.join(projectDir, "hub.sock");
const serverJson = path.join(projectDir, "server.json");
const auditLog = path.join(projectDir, "coms-net-log");

fs.mkdirSync(projectDir, { recursive: true });

const clients = new Map<string, Client>(); // by name

function audit(line: string) {
  // routing metadata only — never message bodies
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(auditLog, entry); } catch { /* best effort */ }
  process.stdout.write(entry);
}

function roster(): PeerRecord[] {
  return [...clients.values()].map((c) => c.record);
}

function pushRoster() {
  const msg = JSON.stringify({ t: "roster", peers: roster() }) + "\n";
  for (const c of clients.values()) {
    try { c.conn.write(msg); } catch { /* dropped, sweep will clean */ }
  }
}

function sendToClient(name: string, obj: unknown): boolean {
  const c = clients.get(name);
  if (!c) return false;
  try { c.conn.write(JSON.stringify(obj) + "\n"); return true; } catch { return false; }
}

function onMessage(raw: string, conn: net.Socket, bound: Bound) {
  let m: any;
  try { m = JSON.parse(raw); } catch { return; }

  switch (m.t) {
    case "register": {
      if (typeof m.name !== "string" || !m.name) return;
      if (!takeToken(bound)) { audit(`RATE-LIMIT ${m.name} register`); return; }
      const record: PeerRecord = {
        name: m.name, model: m.model ?? "unknown", purpose: m.purpose ?? "",
        color: m.color ?? "#36F9F6", pid: m.pid ?? 0,
        tokens: m.tokens ?? 0, contextWindow: m.contextWindow ?? 0, ts: Date.now(),
      };
      // name collision: last writer wins, evict the old connection
      const existing = clients.get(record.name);
      if (existing && existing.conn !== conn) { try { existing.conn.destroy(); } catch { /* */ } }
      clients.set(record.name, { conn, record });
      bound.name = record.name;
      audit(`REGISTER ${record.name} (${record.model}) pid=${record.pid}`);
      try { conn.write(JSON.stringify({ t: "registered", you: record.name }) + "\n"); } catch { /* */ }
      pushRoster();
      break;
    }
    case "ping": {
      const c = bound.name ? clients.get(bound.name) : undefined;
      if (c) {
        c.record.ts = Date.now();
        if (typeof m.tokens === "number") c.record.tokens = m.tokens;
        if (typeof m.contextWindow === "number") c.record.contextWindow = m.contextWindow;
      }
      break;
    }
    case "send": {
      if (!MSG_ID_RE.test(m.msg_id ?? "") || typeof m.from !== "string" || typeof m.to !== "string" || typeof m.text !== "string") {
        audit(`REJECT malformed send from ${String(m.from)}`);
        return;
      }
      // a client may only send as its own registered identity (anti-spoofing)
      if (!bound.name || m.from !== bound.name) { audit(`REJECT send from=${m.from} bound=${bound.name ?? "?"}`); return; }
      if (!takeToken(bound)) {
        // surface the drop so the sender's await resolves instead of hanging to its timeout
        audit(`RATE-LIMIT ${bound.name} send`);
        sendToClient(m.from, { t: "response", msg_id: m.msg_id, from: m.to, text: "Dropped: hub rate limit exceeded", isError: true });
        return;
      }
      const hops = Number.isSafeInteger(m.hops) && m.hops >= 1 ? m.hops : 1;
      if (hops > MAX_HOPS) {
        audit(`DROP ${m.msg_id} ${m.from}->${m.to} hops=${hops}`);
        sendToClient(m.from, { t: "response", msg_id: m.msg_id, from: m.to, text: `Dropped: hop limit ${MAX_HOPS} exceeded`, isError: true });
        return;
      }
      audit(`ROUTE ${m.msg_id} ${m.from}->${m.to} hops=${hops}`);
      const ok = sendToClient(m.to, { t: "deliver", msg_id: m.msg_id, from: m.from, hops, text: m.text });
      if (!ok) {
        sendToClient(m.from, { t: "response", msg_id: m.msg_id, from: m.to, text: `No live peer "${m.to}"`, isError: true });
      }
      break;
    }
    case "reply": {
      if (!MSG_ID_RE.test(m.msg_id ?? "") || typeof m.from !== "string" || typeof m.to !== "string") {
        audit(`REJECT malformed reply from ${String(m.from)}`);
        return;
      }
      // a client may only reply as its own registered identity (anti-spoofing)
      if (!bound.name || m.from !== bound.name) { audit(`REJECT reply from=${m.from} bound=${bound.name ?? "?"}`); return; }
      audit(`REPLY ${m.msg_id} ${m.from}->${m.to}${m.isError ? " ERR" : ""}`);
      sendToClient(m.to, { t: "response", msg_id: m.msg_id, from: m.from, text: m.text, isError: m.isError });
      break;
    }
    default:
      break;
  }
}

const server = net.createServer((conn) => {
  const bound: Bound = { tokens: RATE_BURST, last: Date.now() };
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) onMessage(line, conn, bound);
    }
    // Consume complete frames first; only an oversized un-framed remainder is the DoS case.
    if (buf.length > MAX_MESSAGE_BYTES) {
      audit(`DROP oversized frame from ${bound.name ?? "?"} (${buf.length}B > ${MAX_MESSAGE_BYTES}B)`);
      buf = "";
      try { conn.destroy(); } catch { /* */ }
    }
  });
  const drop = () => {
    if (bound.name && clients.get(bound.name)?.conn === conn) {
      clients.delete(bound.name);
      audit(`DISCONNECT ${bound.name}`);
      pushRoster();
    }
  };
  conn.on("close", drop);
  conn.on("error", drop);
});

// stale sweep: drop peers that stopped pinging
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [name, c] of clients) {
    if (now - c.record.ts > STALE_AFTER) {
      try { c.conn.destroy(); } catch { /* */ }
      clients.delete(name);
      audit(`STALE ${name}`);
      changed = true;
    }
  }
  if (changed) pushRoster();
}, HEARTBEAT_MS);

function shutdown() {
  audit("HUB SHUTDOWN");
  try { server.close(); } catch { /* */ }
  try { fs.unlinkSync(socketPath); } catch { /* */ }
  try { fs.unlinkSync(serverJson); } catch { /* */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* stale socket */ }
server.listen(socketPath, () => {
  fs.writeFileSync(serverJson, JSON.stringify({ socket: socketPath, pid: process.pid, project, started: Date.now() }, null, 2));
  audit(`HUB ONLINE project=${project} socket=${socketPath}`);
  process.stdout.write(`coms-net hub listening. Project "${project}". Ctrl+C to stop.\n`);
});
