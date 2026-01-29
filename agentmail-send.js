#!/usr/bin/env node

/**
 * agentmail-send - Send email via AgentMail
 *
 * Usage:
 *   agentmail-send <to> <subject>              # Interactive body input
 *   agentmail-send <to> <subject> -m "body"    # Message inline
 *   echo "body" | agentmail-send <to> <subject> # Body from stdin
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const CONFIG_PATH = path.join(process.env.HOME, '.agentmail', 'config.json');
const API_BASE = 'https://api.agentmail.to';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: No config found at ~/.agentmail/config.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

async function sendMessage(inboxId, { to, subject, text, html, cc, bcc }) {
  const config = loadConfig();

  const body = {
    to: Array.isArray(to) ? to : [to],
    subject,
    text
  };

  if (html) body.html = html;
  if (cc) body.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];

  const res = await fetch(`${API_BASE}/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  return res.json();
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function promptForBody() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('Enter message body (Ctrl+D to send, Ctrl+C to cancel):');
    let body = '';
    rl.on('line', (line) => {
      body += line + '\n';
    });
    rl.on('close', () => {
      resolve(body.trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length < 2) {
    console.log(`
agentmail-send - Send email via AgentMail

Usage:
  agentmail-send <to> <subject>              Interactive body input
  agentmail-send <to> <subject> -m "body"    Message inline
  echo "body" | agentmail-send <to> <subject>  Body from stdin

Options:
  -m, --message <text>   Message body
  --cc <email>           CC recipient
  --bcc <email>          BCC recipient
  --inbox <email>        Send from specific inbox
  --html                 Treat body as HTML

Examples:
  agentmail-send user@example.com "Hello" -m "Hi there!"
  cat letter.txt | agentmail-send user@example.com "Important"
`);
    process.exit(args.length < 2 ? 1 : 0);
  }

  const config = loadConfig();
  let inboxId = config.default_inbox;
  let to = null;
  let subject = null;
  let body = null;
  let cc = null;
  let bcc = null;
  let isHtml = false;

  // Parse positional args first
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--message') {
      body = args[++i];
    } else if (args[i] === '--inbox') {
      inboxId = args[++i];
    } else if (args[i] === '--cc') {
      cc = args[++i];
    } else if (args[i] === '--bcc') {
      bcc = args[++i];
    } else if (args[i] === '--html') {
      isHtml = true;
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }

  if (positional.length < 2) {
    console.error('Error: Need <to> and <subject>');
    process.exit(1);
  }

  to = positional[0];
  subject = positional[1];

  // Get body from stdin if piped, or prompt
  if (!body) {
    const stdinData = await readStdin();
    if (stdinData) {
      body = stdinData;
    } else if (process.stdin.isTTY) {
      body = await promptForBody();
    }
  }

  if (!body) {
    console.error('Error: No message body provided');
    process.exit(1);
  }

  const payload = {
    to,
    subject,
    text: isHtml ? undefined : body,
    html: isHtml ? body : undefined,
    cc,
    bcc
  };

  console.log(`Sending from ${inboxId}...`);

  const result = await sendMessage(inboxId, payload);

  console.log(`✓ Email sent to ${to}`);
  if (result.message_id) {
    console.log(`  Message ID: ${result.message_id}`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
