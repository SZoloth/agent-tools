#!/usr/bin/env node

/**
 * agentmail-check - Quick check for new/unread messages
 *
 * Usage:
 *   agentmail-check              # Check default inbox for unread
 *   agentmail-check --all        # Check all inboxes
 *   agentmail-check --watch      # Poll every 30s (until Ctrl+C)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(process.env.HOME, '.agentmail', 'config.json');
const API_BASE = 'https://api.agentmail.to';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: No config found at ~/.agentmail/config.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function apiRequest(endpoint) {
  const config = loadConfig();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  return res.json();
}

async function listInboxes() {
  const data = await apiRequest('/v0/inboxes');
  return data.inboxes || [];
}

async function getUnreadCount(inboxId) {
  const data = await apiRequest(`/v0/inboxes/${encodeURIComponent(inboxId)}/messages?labels=unread&limit=50`);
  return {
    count: data.messages?.length || 0,
    messages: data.messages || []
  };
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

async function checkInbox(inboxId, verbose = true) {
  const { count, messages } = await getUnreadCount(inboxId);

  if (count === 0) {
    if (verbose) console.log(`📭 ${inboxId}: No unread messages`);
    return { inboxId, count: 0, messages: [] };
  }

  console.log(`📬 ${inboxId}: ${count} unread message${count > 1 ? 's' : ''}`);

  if (verbose && messages.length > 0) {
    for (const msg of messages.slice(0, 5)) {
      const from = msg.from_?.replace(/<[^>]+>/g, '').trim() || 'Unknown';
      const subject = msg.subject || '(no subject)';
      const time = formatTime(msg.timestamp || msg.created_at);
      console.log(`   • ${from.slice(0, 20)} - ${subject.slice(0, 40)} (${time})`);
    }
    if (messages.length > 5) {
      console.log(`   ... and ${messages.length - 5} more`);
    }
  }

  return { inboxId, count, messages };
}

async function watchMode(inboxId, interval = 30000) {
  console.log(`👀 Watching ${inboxId} (Ctrl+C to stop)\n`);

  let lastCount = -1;

  const check = async () => {
    const { count, messages } = await getUnreadCount(inboxId);
    const time = new Date().toLocaleTimeString();

    if (count !== lastCount) {
      if (count > 0) {
        console.log(`[${time}] 📬 ${count} unread`);
        if (count > lastCount && lastCount >= 0) {
          const newest = messages[0];
          if (newest) {
            const from = newest.from_?.replace(/<[^>]+>/g, '').trim() || 'Unknown';
            console.log(`   New: ${from} - ${newest.subject || '(no subject)'}`);
          }
        }
      } else {
        console.log(`[${time}] 📭 Inbox empty`);
      }
      lastCount = count;
    }
  };

  await check();
  setInterval(check, interval);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
agentmail-check - Quick check for unread messages

Usage:
  agentmail-check              Check default inbox
  agentmail-check --all        Check all inboxes
  agentmail-check --watch      Poll every 30s
  agentmail-check --quiet      Just output count (for scripts)

Options:
  --inbox <email>    Check specific inbox
  --all              Check all inboxes
  --watch            Continuous polling mode
  --interval <sec>   Watch interval in seconds (default: 30)
  --quiet, -q        Only output number (exit code 0=unread, 1=empty)
`);
    process.exit(0);
  }

  const config = loadConfig();
  let inboxId = config.default_inbox;
  let checkAll = false;
  let watch = false;
  let quiet = false;
  let interval = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inbox') inboxId = args[++i];
    else if (args[i] === '--all') checkAll = true;
    else if (args[i] === '--watch') watch = true;
    else if (args[i] === '--quiet' || args[i] === '-q') quiet = true;
    else if (args[i] === '--interval') interval = parseInt(args[++i]) || 30;
  }

  if (watch) {
    await watchMode(inboxId, interval * 1000);
    return;
  }

  if (checkAll) {
    const inboxes = await listInboxes();
    let totalUnread = 0;

    console.log('');
    for (const inbox of inboxes) {
      const result = await checkInbox(inbox.inbox_id, !quiet);
      totalUnread += result.count;
    }

    if (!quiet) {
      console.log(`\nTotal: ${totalUnread} unread across ${inboxes.length} inbox(es)`);
    } else {
      console.log(totalUnread);
    }

    process.exit(totalUnread > 0 ? 0 : 1);
    return;
  }

  // Single inbox check
  const { count } = await checkInbox(inboxId, !quiet);

  if (quiet) {
    console.log(count);
  }

  process.exit(count > 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
