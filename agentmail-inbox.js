#!/usr/bin/env node

/**
 * agentmail-inbox - List messages in AgentMail inbox
 *
 * Usage:
 *   agentmail-inbox                    # List recent messages (default inbox)
 *   agentmail-inbox -n 20              # List 20 messages
 *   agentmail-inbox --unread           # Only unread messages
 *   agentmail-inbox --inbox <email>    # Specific inbox
 */

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.env.HOME, '.agentmail', 'config.json');
const API_BASE = 'https://api.agentmail.to';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: No config found at ~/.agentmail/config.json');
    console.error('Create it with: {"api_key": "...", "default_inbox": "..."}');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function listMessages(inboxId, options = {}) {
  const config = loadConfig();

  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.unread) params.set('labels', 'unread');

  const url = `${API_BASE}/v0/inboxes/${encodeURIComponent(inboxId)}/messages?${params}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Error ${res.status}: ${err}`);
    process.exit(1);
  }

  return res.json();
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return d.toLocaleDateString();
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
agentmail-inbox - List messages in AgentMail inbox

Usage:
  agentmail-inbox                    List recent messages
  agentmail-inbox -n 20              List 20 messages
  agentmail-inbox --unread           Only unread messages
  agentmail-inbox --inbox <email>    Use specific inbox

Options:
  -n, --limit <num>     Number of messages (default: 10)
  --unread              Show only unread messages
  --inbox <email>       Inbox email address
  --json                Output raw JSON
`);
    process.exit(0);
  }

  const config = loadConfig();
  let inboxId = config.default_inbox;
  let limit = 10;
  let unread = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--limit') limit = parseInt(args[++i]) || 10;
    else if (args[i] === '--unread') unread = true;
    else if (args[i] === '--inbox') inboxId = args[++i];
    else if (args[i] === '--json') jsonOutput = true;
  }

  const data = await listMessages(inboxId, { limit, unread });

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!data.messages || data.messages.length === 0) {
    console.log(`📭 No ${unread ? 'unread ' : ''}messages in ${inboxId}`);
    return;
  }

  console.log(`\n📬 ${inboxId} (${data.messages.length} messages)\n`);

  for (const msg of data.messages) {
    const isUnread = msg.labels?.includes('unread');
    const marker = isUnread ? '●' : ' ';
    const from = msg.from_?.replace(/<[^>]+>/g, '').trim() || 'Unknown';
    const subject = msg.subject || '(no subject)';
    const date = formatDate(msg.timestamp || msg.created_at);

    console.log(`${marker} ${truncate(from, 25).padEnd(25)} ${truncate(subject, 45).padEnd(45)} ${date}`);
  }

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
