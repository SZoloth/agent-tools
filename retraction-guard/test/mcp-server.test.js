import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-server.js");

function session(ledgerPath) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, RETRACTION_GUARD_LEDGER: ledgerPath } });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { request, notify, close: () => child.kill() };
}

test("MCP: initialize, list tools, retract a claim, then block it in a draft", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-mcp-"));
  const s = session(path.join(dir, "retractions.json"));
  try {
    const init = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "retraction-guard");
    s.notify("notifications/initialized");
    const tools = await s.request("tools/list", {});
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["check_draft", "retract_claim", "list_sources"]);

    const retracted = await s.request("tools/call", { name: "retract_claim", arguments: { claim: "grew revenue 4x", reason: "It was 40%, not 4x", source: "Founder, chat", replacement: "grew revenue 40%" } });
    assert.equal(retracted.result.isError, undefined);

    const checked = await s.request("tools/call", { name: "check_draft", arguments: { text: "In two years she grew revenue 4x." } });
    const payload = JSON.parse(checked.result.content[0].text);
    assert.equal(payload.passed, false);
    assert.equal(payload.blocked[0].replacement, "grew revenue 40%");

    const bad = await s.request("tools/call", { name: "retract_claim", arguments: { claim: "x" } });
    assert.equal(bad.result.isError, true);
    const missing = await s.request("nope/method", {});
    assert.equal(missing.error.code, -32601);
  } finally {
    s.close();
  }
});
