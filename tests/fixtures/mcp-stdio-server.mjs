#!/usr/bin/env node
/**
 * Synthetic MCP stdio server for gateway tests.
 *
 * Implements just enough of MCP 2025-06-18 over newline-delimited JSON-RPC: initialize, tools/list,
 * tools/call and request cancellation. It never touches the network and prints nothing to stdout
 * except JSON-RPC messages.
 *
 * Options:
 *   --pid-file <path>       write the server PID once, before initialize
 *   --cancelled-file <path> append one line per cancelled tools/call request id
 *   --fail                  print a secret marker to stderr and exit before serving
 */
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};

if (argv.includes("--fail")) {
  process.stderr.write("MCP-FIXTURE-FAILURE-SECRET\n");
  process.exit(3);
}

const pidFile = option("--pid-file");
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
const cancelledFile = option("--cancelled-file");

const INSTRUCTIONS = "SYNTHETIC-SERVER-INSTRUCTIONS: echo checks the transport; fail returns an error result.";

const TOOLS = [
  {
    name: "echo",
    description: "Echo one label as text and structured content",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", description: "Label to echo" } },
      required: ["label"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "a-b",
    description: "Dashed tool whose sanitized name collides with a_b",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "a_b",
    description: "Underscored tool whose sanitized name collides with a-b",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fail",
    description: "Return an MCP error result",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Answer after a delay, unless the request is cancelled",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
  },
];

const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function callTool(id, name, args) {
  if (name === "echo") {
    result(id, {
      content: [{ type: "text", text: `echo:${String(args?.label)}` }],
      structuredContent: { label: args?.label, pid: process.pid },
    });
    return;
  }
  if (name === "fail") {
    result(id, { content: [{ type: "text", text: "synthetic failure" }], isError: true });
    return;
  }
  if (name === "a-b" || name === "a_b") {
    result(id, { content: [{ type: "text", text: `collision:${name}` }], structuredContent: { tool: name } });
    return;
  }
  if (name === "slow") {
    const requested = typeof args?.ms === "number" ? args.ms : 30_000;
    const timer = setTimeout(() => {
      pending.delete(id);
      result(id, { content: [{ type: "text", text: "slow answer" }] });
    }, Math.min(Math.max(requested, 1), 60_000));
    pending.set(id, timer);
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown synthetic tool" } });
}

function onRequest(message) {
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "synthetic-stdio", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
      return;
    case "ping":
      result(message.id, {});
      return;
    case "tools/list":
      result(message.id, { tools: TOOLS });
      return;
    case "tools/call":
      callTool(message.id, message.params?.name, message.params?.arguments ?? {});
      return;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}

function onNotification(message) {
  if (message.method !== "notifications/cancelled") return;
  const id = message.params?.requestId;
  if (id === undefined || id === null) return;
  const timer = pending.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(id);
  }
  if (cancelledFile !== undefined) appendFileSync(cancelledFile, `${String(id)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || message.id === null) onNotification(message);
    else onRequest(message);
  }
});
process.stdin.on("end", () => process.exit(0));
