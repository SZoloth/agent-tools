#!/usr/bin/env node

/**
 * agentmail-read - Read a message from AgentMail inbox
 *
 * Usage:
 *   agentmail-read                     # Read latest message
 *   agentmail-read <message-id>        # Read specific message
 *   agentmail-read --latest            # Read latest message
 *   agentmail-read --json              # Output raw JSON
 */

import fs from 'fs';
import path from 'path';

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

async function getLatestMessageId(inboxId) {
  const data = await apiRequest(`/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=1`);
  if (!data.messages || data.messages.length === 0) {
    return null;
  }
  return data.messages[0].message_id;
}

async function getMessage(inboxId, messageId) {
  return apiRequest(`/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
agentmail-read - Read a message from AgentMail inbox

Usage:
  agentmail-read                     Read latest message
  agentmail-read <message-id>        Read specific message by ID
  agentmail-read --latest            Read latest message (explicit)

Options:
  --inbox <email>    Use specific inbox (default from config)
  --json             Output raw JSON
  --links            Extract and list URLs from message
`);
    process.exit(0);
  }

  const config = loadConfig();
  let inboxId = config.default_inbox;
  let messageId = null;
  let jsonOutput = false;
  let showLinks = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--inbox') inboxId = args[++i];
    else if (args[i] === '--json') jsonOutput = true;
    else if (args[i] === '--links') showLinks = true;
    else if (args[i] === '--latest') continue;
    else if (!args[i].startsWith('-')) messageId = args[i];
  }

  // Get latest if no message ID
  if (!messageId) {
    messageId = await getLatestMessageId(inboxId);
    if (!messageId) {
      console.log('📭 No messages in inbox');
      process.exit(0);
    }
  }

  const msg = await getMessage(inboxId, messageId);

  if (jsonOutput) {
    console.log(JSON.stringify(msg, null, 2));
    return;
  }

  // Format output
  console.log('─'.repeat(70));
  console.log(`From:    ${msg.from_ || 'Unknown'}`);
  console.log(`To:      ${(msg.to || []).join(', ')}`);
  if (msg.cc?.length) console.log(`Cc:      ${msg.cc.join(', ')}`);
  console.log(`Subject: ${msg.subject || '(no subject)'}`);
  console.log(`Date:    ${formatDate(msg.timestamp)}`);
  console.log(`Labels:  ${(msg.labels || []).join(', ') || 'none'}`);
  console.log('─'.repeat(70));

  // Show body
  const body = msg.text || msg.extracted_text || msg.html || '(no content)';
  console.log('\n' + body + '\n');

  // Extract links if requested
  if (showLinks) {
    const urlRegex = /https?:\/\/[^\s<>"]+/g;
    const links = body.match(urlRegex) || [];
    if (links.length > 0) {
      console.log('─'.repeat(70));
      console.log('Links found:');
      links.forEach((link, i) => console.log(`  [${i + 1}] ${link}`));
      console.log('');
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
