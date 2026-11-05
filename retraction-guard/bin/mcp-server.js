#!/usr/bin/env node
/**
 * retraction-guard MCP server (stdio, newline-delimited JSON-RPC, no dependencies).
 *
 * Tools:
 *   check_draft    Check prose before it reaches a person. Blocks retracted claims and confidential names, lists unbacked numbers.
 *   retract_claim  Record a person's correction so no later agent can repeat the claim.
 *   list_sources   Show what's retracted, what's approved (and where the proof lives), and what's superseded.
 *
 * Ledger: $RETRACTION_GUARD_LEDGER, else ./retractions.json in the server's working directory.
 *
 * Register with Claude Code:
 *   claude mcp add retraction-guard -e RETRACTION_GUARD_LEDGER=/abs/path/retractions.json -- node /abs/path/bin/mcp-server.js
 */

import path from "node:path";
import readline from "node:readline";
import { check, loadLedger, retract, saveLedger, summarize } from "../src/guard.js";

const PROTOCOL_VERSION = "2025-06-18";
const ledgerPath = () => path.resolve(process.env.RETRACTION_GUARD_LEDGER ?? "retractions.json");

const TOOLS = [
  {
    name: "check_draft",
    description:
      "Run this on any prose before a person sees it or it gets sent: emails, posts, bios, résumés, reports. " +
      "Returns blocked findings (claims a person retracted, confidential names) that must be cut or replaced with the suggested wording, " +
      "and check findings (numbers not backed by an approved claim or a source) to trace or cut. " +
      "A retracted claim stays blocked even if your notes or sources repeat it: the correction is newer than the note.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The draft to check." },
        sources: { type: "array", items: { type: "string" }, description: "Optional source texts (a job post, research, an email thread) whose numbers count as backed." },
      },
      required: ["text"],
    },
  },
  {
    name: "retract_claim",
    description:
      "Call this the moment a person corrects a fact (\"that number is wrong\", \"we never said that\", \"stop using X\"). " +
      "It records the claim as retracted with the person's reason and where the correction came from, so no later agent can bring it back. " +
      "Only record corrections a person made; never retract on your own judgment.",
    inputSchema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "The shortest phrase that is wrong, with its number if it has one: 'shipped in four months', not the whole sentence it appeared in. One retraction per wrong fact." },
        reason: { type: "string", description: "What the person said, close to their words." },
        source: { type: "string", description: "Where the correction came from, e.g. 'Dana, chat, 2026-11-04'." },
        replacement: { type: "string", description: "What to say instead, if the person gave one." },
        terms: { type: "array", items: { type: "string" }, description: "Optional key words that identify the claim, if the automatic ones are too broad." },
      },
      required: ["claim", "reason", "source"],
    },
  },
  {
    name: "list_sources",
    description: "List retracted claims (with reasons and replacements), approved claims (with where the proof lives), and superseded approvals. Read this before drafting anything with numbers in it.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function callTool(name, args = {}) {
  const file = ledgerPath();
  if (name === "check_draft") {
    if (typeof args.text !== "string") throw new Error("text is required");
    const result = check(args.text, loadLedger(file), { sources: args.sources ?? [] });
    const verdict = result.passed
      ? result.check.length ? "Nothing blocked. Trace or cut the numbers listed under check." : "Clean."
      : "Blocked. Cut or replace every blocked finding, then check again.";
    return text({ verdict, ...result });
  }
  if (name === "retract_claim") {
    const { ledger, entry, superseded } = retract(loadLedger(file), { ...args, by: "agent-on-behalf-of-person" });
    saveLedger(file, ledger);
    return text({ retracted: entry, superseded });
  }
  if (name === "list_sources") return text(summarize(loadLedger(file)));
  throw new Error(`Unknown tool: ${name}`);
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "retraction-guard", version: "0.1.0" },
      instructions: "Call list_sources before drafting, check_draft before handing prose to a person, and retract_claim whenever a person corrects a fact.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    try {
      return callTool(params?.name, params?.arguments);
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }
  if (id === undefined) return undefined;
  const error = new Error(`Method not found: ${method}`);
  error.code = -32601;
  throw error;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  if (message.id === undefined) return; // notifications need no reply
  try {
    const result = handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`);
  }
});

