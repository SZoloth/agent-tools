#!/usr/bin/env node

/**
 * cchist - Claude Code History
 * Search and browse Claude Code conversation history
 *
 * Usage:
 *   cchist.js search "keyword"           # Search all conversations
 *   cchist.js list                       # List recent sessions
 *   cchist.js list --days 7              # Sessions from last 7 days
 *   cchist.js read <session-id>          # Read full session
 *   cchist.js read <session-id> --summary # Summarize session
 *   cchist.js --project ~/myproject      # Filter by project
 *   cchist.js --json                     # JSON output
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    command: null,
    query: null,
    sessionId: null,
    project: null,
    days: null,
    limit: 20,
    json: false,
    summary: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'search' && !opts.command) {
      opts.command = 'search';
      opts.query = args[++i];
    } else if (arg === 'list' && !opts.command) {
      opts.command = 'list';
    } else if (arg === 'read' && !opts.command) {
      opts.command = 'read';
      opts.sessionId = args[++i];
    } else if (arg === '--project' || arg === '-p') {
      opts.project = args[++i];
    } else if (arg === '--days' || arg === '-d') {
      opts.days = parseInt(args[++i]);
    } else if (arg === '--limit' || arg === '-n') {
      opts.limit = parseInt(args[++i]);
    } else if (arg === '--json' || arg === '-j') {
      opts.json = true;
    } else if (arg === '--summary' || arg === '-s') {
      opts.summary = true;
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  return opts;
}

function showHelp() {
  console.log(`cchist - Claude Code History

Usage:
  cchist.js search "keyword"           Search all conversations for text
  cchist.js list                       List recent sessions
  cchist.js read <session-id>          Read full session transcript

Options:
  -p, --project PATH    Filter by project path
  -d, --days N          Only sessions from last N days
  -n, --limit N         Max results (default: 20)
  -j, --json            Output as JSON
  -s, --summary         Show summary only (for read)
  -v, --verbose         Show more details
  -h, --help            Show this help

Examples:
  cchist.js search "firebase"          Find conversations mentioning firebase
  cchist.js list --days 7              Sessions from last week
  cchist.js read abc123 --summary      Summarize a specific session`);
}

function getProjectDirs() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
    .map(f => ({
      name: f,
      path: path.join(PROJECTS_DIR, f),
      displayPath: f.replace(/-/g, '/').replace(/^\//, '')
    }));
}

function getSessionFiles(projectPath, opts = {}) {
  if (!fs.existsSync(projectPath)) return [];

  const files = fs.readdirSync(projectPath)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fullPath = path.join(projectPath, f);
      const stat = fs.statSync(fullPath);
      return {
        id: f.replace('.jsonl', ''),
        path: fullPath,
        size: stat.size,
        modified: stat.mtime,
      };
    })
    .filter(f => f.size > 0)
    .sort((a, b) => b.modified - a.modified);

  // Filter by days
  if (opts.days) {
    const cutoff = Date.now() - (opts.days * 24 * 60 * 60 * 1000);
    return files.filter(f => f.modified.getTime() > cutoff);
  }

  return files;
}

function readSessionMessages(sessionPath) {
  const content = fs.readFileSync(sessionPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        messages.push({
          role: 'user',
          content: typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content[0]?.text || JSON.stringify(entry.message.content),
          timestamp: entry.timestamp,
        });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        if (text) {
          messages.push({
            role: 'assistant',
            content: text,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  return messages;
}

function searchSessions(query, opts) {
  const results = [];
  const queryLower = query.toLowerCase();
  const projects = getProjectDirs();

  for (const project of projects) {
    // Filter by project if specified
    if (opts.project && !project.displayPath.includes(opts.project.replace(/\//g, '-'))) {
      continue;
    }

    const sessions = getSessionFiles(project.path, opts);

    for (const session of sessions) {
      try {
        const messages = readSessionMessages(session.path);
        const matches = [];

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.content.toLowerCase().includes(queryLower)) {
            // Get context: previous and next message
            const context = {
              match: msg,
              before: messages[i - 1] || null,
              after: messages[i + 1] || null,
              index: i,
            };
            matches.push(context);
          }
        }

        if (matches.length > 0) {
          results.push({
            sessionId: session.id,
            project: project.displayPath,
            modified: session.modified,
            matchCount: matches.length,
            matches: matches.slice(0, 3), // Limit matches per session
            totalMessages: messages.length,
          });
        }
      } catch (e) {
        // Skip unreadable sessions
      }

      if (results.length >= opts.limit) break;
    }
    if (results.length >= opts.limit) break;
  }

  return results.sort((a, b) => b.modified - a.modified);
}

function listSessions(opts) {
  const results = [];
  const projects = getProjectDirs();

  for (const project of projects) {
    if (opts.project && !project.displayPath.includes(opts.project)) {
      continue;
    }

    const sessions = getSessionFiles(project.path, opts);

    for (const session of sessions) {
      try {
        const messages = readSessionMessages(session.path);
        const firstUserMsg = messages.find(m => m.role === 'user');

        results.push({
          sessionId: session.id,
          project: project.displayPath,
          modified: session.modified,
          size: session.size,
          messageCount: messages.length,
          preview: firstUserMsg?.content?.slice(0, 100) || '(no preview)',
        });
      } catch (e) {
        // Skip unreadable
      }

      if (results.length >= opts.limit) break;
    }
    if (results.length >= opts.limit) break;
  }

  return results.sort((a, b) => b.modified - a.modified);
}

function readSession(sessionId, opts) {
  const projects = getProjectDirs();

  for (const project of projects) {
    const sessionPath = path.join(project.path, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionPath)) {
      const messages = readSessionMessages(sessionPath);
      const stat = fs.statSync(sessionPath);

      return {
        sessionId,
        project: project.displayPath,
        modified: stat.mtime,
        messageCount: messages.length,
        messages: opts.summary ? messages.slice(0, 6) : messages,
      };
    }
  }

  return null;
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(str, len) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

// Main
const opts = parseArgs();

if (!opts.command) {
  showHelp();
  process.exit(1);
}

try {
  if (opts.command === 'search') {
    if (!opts.query) {
      console.error('Error: search requires a query');
      process.exit(1);
    }

    const results = searchSessions(opts.query, opts);

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) {
        console.log(`No results found for "${opts.query}"`);
      } else {
        console.log(`Found ${results.length} session(s) matching "${opts.query}":\n`);

        for (const r of results) {
          console.log(`━━━ ${r.sessionId.slice(0, 8)} ━━━`);
          console.log(`  Project: ${r.project}`);
          console.log(`  Date: ${formatDate(r.modified)}`);
          console.log(`  Matches: ${r.matchCount} in ${r.totalMessages} messages`);

          for (const m of r.matches.slice(0, 2)) {
            console.log(`  ┌─ [${m.match.role}]`);
            console.log(`  │ ${truncate(m.match.content, 200)}`);
            console.log(`  └─`);
          }
          console.log();
        }
      }
    }

  } else if (opts.command === 'list') {
    const results = listSessions(opts);

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) {
        console.log('No sessions found');
      } else {
        console.log(`Recent sessions (${results.length}):\n`);

        for (const r of results) {
          const sizeKB = Math.round(r.size / 1024);
          console.log(`${r.sessionId.slice(0, 8)}  ${formatDate(r.modified).padEnd(18)} ${String(r.messageCount).padStart(3)} msgs  ${String(sizeKB).padStart(4)}KB`);
          console.log(`  └─ ${truncate(r.preview, 80)}`);
        }
      }
    }

  } else if (opts.command === 'read') {
    if (!opts.sessionId) {
      console.error('Error: read requires a session ID');
      process.exit(1);
    }

    // Support partial session IDs
    let sessionId = opts.sessionId;
    if (sessionId.length < 36) {
      // Find matching session
      const projects = getProjectDirs();
      for (const project of projects) {
        const sessions = getSessionFiles(project.path, {});
        const match = sessions.find(s => s.id.startsWith(sessionId));
        if (match) {
          sessionId = match.id;
          break;
        }
      }
    }

    const session = readSession(sessionId, opts);

    if (!session) {
      console.error(`Session not found: ${opts.sessionId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(session, null, 2));
    } else {
      console.log(`Session: ${session.sessionId}`);
      console.log(`Project: ${session.project}`);
      console.log(`Date: ${formatDate(session.modified)}`);
      console.log(`Messages: ${session.messageCount}`);
      if (opts.summary) {
        console.log(`(showing first ${session.messages.length} messages)\n`);
      }
      console.log('─'.repeat(60) + '\n');

      for (const msg of session.messages) {
        const role = msg.role === 'user' ? '👤 USER' : '🤖 CLAUDE';
        console.log(`${role} (${formatDate(msg.timestamp)})`);
        console.log(opts.summary ? truncate(msg.content, 500) : msg.content);
        console.log();
      }
    }
  }
} catch (e) {
  console.error('Error:', e.message);
  if (opts.verbose) console.error(e.stack);
  process.exit(1);
}
