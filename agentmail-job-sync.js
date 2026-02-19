#!/usr/bin/env node

/**
 * agentmail-job-sync - Sync job application emails to pipeline state
 *
 * Scans agentmail inbox for job-related emails, matches sender domains
 * against Application folders, detects status patterns, and updates:
 * - ~/.claude/state/cos-state.json
 * - Application_Research_Notes.md in each matched folder
 * - Closes beads issues when rejections detected
 *
 * Usage:
 *   agentmail-job-sync              # Run sync (dry-run by default)
 *   agentmail-job-sync --apply      # Apply changes
 *   agentmail-job-sync --verbose    # Show detailed matching
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const CONFIG_PATH = path.join(process.env.HOME, '.agentmail', 'config.json');
const STATE_PATH = path.join(process.env.HOME, '.claude', 'state', 'cos-state.json');
const APPLICATIONS_DIR = path.join(
  process.env.HOME,
  'Documents/LLM CONTEXT/1 - personal/job_search/Applications'
);
const API_BASE = 'https://api.agentmail.to';

const STATUS_PATTERNS = {
  rejection: [
    /unfortunately/i,
    /won't be moving forward/i,
    /will not be moving forward/i,
    /not moving forward/i,
    /decided not to proceed/i,
    /decided to move forward with other candidates/i,
    /pursued other candidates/i,
    /not the right fit/i,
    /position has been filled/i,
    /regret to inform/i,
    /after careful consideration/i,
  ],
  confirmation: [
    /thank(s|ing)? (you )?for (your )?(applying|application|interest)/i,
    /received your application/i,
    /application (has been |was )?received/i,
    /confirming (your )?application/i,
  ],
  interview: [
    /schedule (a|an|your)? ?(phone|video|interview|call|chat)/i,
    /like to (set up|schedule|arrange)/i,
    /interview (with|at)/i,
    /next step(s)? in (the|our) (interview|hiring|process)/i,
    /move (you )?forward (to|with)/i,
    /advance (you )?to/i,
    /calendly\.com/i,
    /pick a time/i,
  ],
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: No agentmail config found at ~/.agentmail/config.json');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { version: '1.0', job_pipeline: {}, last_updated: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchMessages(inboxId, apiKey, limit = 50) {
  const url = `${API_BASE}/v0/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

function getApplicationFolders() {
  const folders = [];
  if (!fs.existsSync(APPLICATIONS_DIR)) return folders;

  const entries = fs.readdirSync(APPLICATIONS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folderPath = path.join(APPLICATIONS_DIR, entry.name);
    const notesPath = path.join(folderPath, 'Application_Research_Notes.md');
    const beadsPath = path.join(folderPath, '.beads-issue');

    const companyMatch = entry.name.match(/^\d*-?(.+)$/);
    const companyName = companyMatch ? companyMatch[1].toLowerCase() : entry.name.toLowerCase();

    folders.push({
      name: entry.name,
      path: folderPath,
      company: companyName,
      hasNotes: fs.existsSync(notesPath),
      hasBeads: fs.existsSync(beadsPath),
      notesPath,
      beadsPath,
    });
  }

  return folders;
}

function extractDomain(fromField) {
  const emailMatch = fromField.match(/<([^>]+)>/) || fromField.match(/([^\s]+@[^\s]+)/);
  if (!emailMatch) return null;

  const email = emailMatch[1].toLowerCase();
  const domainMatch = email.match(/@([^@]+)$/);
  return domainMatch ? domainMatch[1] : null;
}

function matchCompanyToFolder(domain, companyName, folders) {
  if (!domain) return null;

  const domainBase = domain.replace(/\.(com|io|co|org|net)$/, '').toLowerCase();

  for (const folder of folders) {
    const folderCompany = folder.company
      .replace(/-/g, '')
      .replace(/\s/g, '')
      .toLowerCase();

    if (
      domainBase.includes(folderCompany) ||
      folderCompany.includes(domainBase) ||
      domain.includes(folder.company)
    ) {
      return folder;
    }

    if (companyName) {
      const normalizedCompany = companyName.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (folderCompany.includes(normalizedCompany) || normalizedCompany.includes(folderCompany)) {
        return folder;
      }
    }
  }

  return null;
}

function detectStatus(content) {
  for (const pattern of STATUS_PATTERNS.interview) {
    if (pattern.test(content)) return { status: 'interview', pattern: pattern.source };
  }

  for (const pattern of STATUS_PATTERNS.rejection) {
    if (pattern.test(content)) return { status: 'rejection', pattern: pattern.source };
  }

  for (const pattern of STATUS_PATTERNS.confirmation) {
    if (pattern.test(content)) return { status: 'confirmation', pattern: pattern.source };
  }

  return null;
}

function readBeadsIssue(beadsPath) {
  if (!fs.existsSync(beadsPath)) return null;
  return fs.readFileSync(beadsPath, 'utf-8').trim();
}

function updateApplicationNotes(notesPath, statusInfo, emailDate) {
  if (!fs.existsSync(notesPath)) return false;

  let content = fs.readFileSync(notesPath, 'utf-8');
  const dateStr = new Date(emailDate).toISOString().split('T')[0];

  const statusEmoji = {
    rejection: '\u2717 REJECTED',
    interview: '\ud83d\udcc6 INTERVIEW INVITE',
    confirmation: '\u2713 CONFIRMED',
  };

  const newStatus = statusEmoji[statusInfo.status] || statusInfo.status.toUpperCase();

  const statusLineRegex = /^\*\*Application Status:\*\*.*/m;
  if (statusLineRegex.test(content)) {
    content = content.replace(
      statusLineRegex,
      `**Application Status:** ${newStatus} (${dateStr})`
    );
  } else {
    const insertPoint = content.indexOf('---');
    if (insertPoint > 0) {
      content =
        content.slice(0, insertPoint) +
        `**Application Status:** ${newStatus} (${dateStr})\n` +
        content.slice(insertPoint);
    }
  }

  const notesSection = content.match(/## Notes & Updates\n([\s\S]*?)(?=\n## |\n---|\n\*Research|$)/);
  const noteEntry = `**${dateStr}:** Auto-detected ${statusInfo.status} via email sync`;

  if (notesSection) {
    const existingNotes = notesSection[1];
    if (!existingNotes.includes(noteEntry) && !existingNotes.includes(`Auto-detected ${statusInfo.status}`)) {
      content = content.replace(
        /## Notes & Updates\n/,
        `## Notes & Updates\n\n${noteEntry}\n`
      );
    }
  }

  fs.writeFileSync(notesPath, content);
  return true;
}

function closeBeadsIssue(issueId, reason) {
  try {
    execFileSync('bd', ['close', issueId, '-r', reason], {
      cwd: path.join(process.env.HOME, 'Documents/LLM CONTEXT/1 - personal'),
      stdio: 'pipe',
      timeout: 30000,
    });
    return true;
  } catch (err) {
    console.error(`  Failed to close beads issue ${issueId}: ${err.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const applyChanges = args.includes('--apply');
  const verbose = args.includes('--verbose');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
agentmail-job-sync - Sync job application emails to pipeline state

Usage:
  agentmail-job-sync              Run sync (dry-run by default)
  agentmail-job-sync --apply      Apply changes to notes and close beads issues
  agentmail-job-sync --verbose    Show detailed matching information

Detects:
  - Rejections: "unfortunately", "won't be moving forward", etc.
  - Confirmations: "thanks for applying", "received your application"
  - Interview invites: "schedule", "interview", "next steps"
`);
    process.exit(0);
  }

  const config = loadConfig();
  const inboxId = config.default_inbox;

  console.log(`Scanning ${inboxId} for job-related emails...`);

  const folders = getApplicationFolders();
  if (verbose) {
    console.log(`Found ${folders.length} application folders`);
  }

  const data = await fetchMessages(inboxId, config.api_key, 100);

  if (!data.messages || data.messages.length === 0) {
    console.log('No messages found');
    return;
  }

  console.log(`Processing ${data.messages.length} messages...\n`);

  const state = loadState();
  if (!state.job_pipeline) state.job_pipeline = {};
  if (!state.job_pipeline.email_syncs) state.job_pipeline.email_syncs = [];

  const changes = [];

  for (const msg of data.messages) {
    const domain = extractDomain(msg.from || '');
    const fromName = (msg.from || '').replace(/<[^>]+>/, '').trim();

    const folder = matchCompanyToFolder(domain, fromName, folders);
    if (!folder) {
      if (verbose) {
        console.log(`  Skip: ${domain} - no matching folder`);
      }
      continue;
    }

    const content = msg.preview + ' ' + (msg.subject || '');
    const statusInfo = detectStatus(content);

    if (!statusInfo) {
      if (verbose) {
        console.log(`  Skip: ${folder.name} - no status pattern detected`);
      }
      continue;
    }

    const syncKey = `${folder.name}:${statusInfo.status}:${msg.timestamp}`;
    if (state.job_pipeline.email_syncs.includes(syncKey)) {
      if (verbose) {
        console.log(`  Skip: ${folder.name} - already processed`);
      }
      continue;
    }

    console.log(`[${statusInfo.status.toUpperCase()}] ${folder.name}`);
    console.log(`  From: ${msg.from}`);
    console.log(`  Subject: ${msg.subject}`);
    console.log(`  Date: ${msg.timestamp}`);

    changes.push({
      folder,
      statusInfo,
      message: msg,
      syncKey,
    });
  }

  if (changes.length === 0) {
    console.log('\nNo new status changes detected.');
    return;
  }

  console.log(`\n${changes.length} status change(s) detected.`);

  if (!applyChanges) {
    console.log('\nDry run - no changes applied. Use --apply to apply changes.');
    return;
  }

  console.log('\nApplying changes...\n');

  // Group changes by folder and pick the most important status per folder
  // Priority: interview > rejection > confirmation
  const statusPriority = { interview: 3, rejection: 2, confirmation: 1 };
  const folderChanges = new Map();

  for (const change of changes) {
    const existing = folderChanges.get(change.folder.name);
    const changePriority = statusPriority[change.statusInfo.status] || 0;
    const existingPriority = existing ? statusPriority[existing.statusInfo.status] || 0 : 0;

    // Take this change if higher priority, or same priority but more recent
    if (!existing || changePriority > existingPriority ||
        (changePriority === existingPriority && new Date(change.message.timestamp) > new Date(existing.message.timestamp))) {
      folderChanges.set(change.folder.name, change);
    }
  }

  // Apply only the winning change per folder
  for (const change of folderChanges.values()) {
    const { folder, statusInfo, message, syncKey } = change;

    if (folder.hasNotes) {
      const updated = updateApplicationNotes(folder.notesPath, statusInfo, message.timestamp);
      if (updated) {
        console.log(`  Updated: ${folder.notesPath}`);
      }
    }

    if (statusInfo.status === 'rejection' && folder.hasBeads) {
      const issueId = readBeadsIssue(folder.beadsPath);
      if (issueId) {
        const closed = closeBeadsIssue(issueId, `Rejection email received ${message.timestamp}`);
        if (closed) {
          console.log(`  Closed beads issue: ${issueId}`);
        }
      }
    }
  }

  // Mark all detected emails as synced to avoid reprocessing
  for (const change of changes) {
    state.job_pipeline.email_syncs.push(change.syncKey);
  }

  state.job_pipeline.last_email_sync = new Date().toISOString();
  saveState(state);
  console.log(`\nState saved to ${STATE_PATH}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
