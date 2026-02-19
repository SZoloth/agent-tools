#!/usr/bin/env node
/**
 * content-scanner.js - Daily content scanner automation
 * Scans iMessage + Readwise for interesting signals, generates a digest.
 *
 * Usage:
 *   node content-scanner.js [--verbose] [--dry-run]
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Paths
const STATE_DIR = path.join(process.env.HOME, '.claude', 'state');
const LOGS_DIR = path.join(process.env.HOME, '.claude', 'logs');
const LOCK_FILE = path.join(STATE_DIR, 'scanner.lock');
const STATE_FILE = path.join(STATE_DIR, 'scanner-state.json');
const DIGEST_FILE = path.join(STATE_DIR, 'scanner-digest.md');
const IMSG_TOOL = path.join(process.env.HOME, 'agent-tools', 'imsg-read.py');
const EVENT_TOOL = path.join(process.env.HOME, 'agent-tools', 'claude-event');

// Flags
const VERBOSE = process.argv.includes('--verbose');
const DRY_RUN = process.argv.includes('--dry-run');

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

const today = new Date().toISOString().slice(0, 10);
const LOG_FILE = path.join(LOGS_DIR, `scanner-${today}.log`);

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  if (VERBOSE) console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { lastScan: {}, lastDigest: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Lock management
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const stat = fs.statSync(LOCK_FILE);
    const age = Date.now() - stat.mtimeMs;
    if (age > LOCK_STALE_MS) {
      log(`Stale lock detected (${Math.round(age / 60000)}min old), removing`);
      fs.unlinkSync(LOCK_FILE);
    } else {
      log('Lock file exists, another scan is running. Exiting.');
      process.exit(0);
    }
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

// Source: iMessage
function scanIMessage() {
  log('Scanning iMessage...');
  try {
    const result = spawnSync('python3', [IMSG_TOOL, '--json', '--days', '1', '--limit', '200'], {
      timeout: 60000,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.status !== 0) {
      log(`iMessage scan failed: ${result.stderr}`);
      return null;
    }
    const messages = JSON.parse(result.stdout);
    log(`iMessage: ${messages.length} messages found`);
    return messages;
  } catch (err) {
    log(`iMessage error: ${err.message}`);
    return null;
  }
}

// Source: Readwise
function scanReadwise() {
  log('Scanning Readwise...');
  const prompt = `Search my Readwise highlights for recent content about: job search, career transitions, product management, design systems, AI/LLM tools, and professional development. Use the mcp__readwise__search_readwise_highlights tool with multiple queries (one per topic). Return a JSON array of relevant highlights with fields: title, text, source, and relevance (why it's relevant). Only return the JSON array, no other text.`;

  try {
    const result = spawnSync('claude', ['-p', '--model', 'sonnet', prompt], {
      timeout: 120000,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.status !== 0) {
      log(`Readwise scan failed: ${(result.stderr || '').slice(0, 500)}`);
      return null;
    }
    // Try to extract JSON from the response
    const output = result.stdout.trim();
    try {
      return JSON.parse(output);
    } catch (_) {
      // Look for JSON array in the output
      const match = output.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      log('Readwise: could not parse JSON from response, returning raw text');
      return [{ text: output, source: 'readwise', title: 'Raw highlights' }];
    }
  } catch (err) {
    log(`Readwise error: ${err.message}`);
    return null;
  }
}

// TODO: Twitter/X scanning - not yet implemented
function scanTwitter() {
  log('Twitter scanning: skipped (not yet implemented)');
  return null;
}

// Generate digest via Claude
function generateDigest(imessageData, readwiseData) {
  log('Generating digest...');

  const combined = {
    imessage: imessageData || [],
    readwise: readwiseData || [],
    // twitter: twitterData || [],  // future
  };

  if (combined.imessage.length === 0 && combined.readwise.length === 0) {
    log('No data from any source, skipping digest generation');
    return null;
  }

  const prompt = `Analyze these signals from my iMessage and Readwise. Categorize each as: job-signal, personal, actionable, or interesting. Generate a brief digest (max 500 words) highlighting:
1. Any job-related signals or opportunities
2. Action items that need follow-up
3. Interesting content worth revisiting
Format as markdown with clear sections.

Here is the data:
${JSON.stringify(combined, null, 2)}`;

  try {
    const result = spawnSync('claude', ['-p', '--model', 'sonnet', prompt], {
      timeout: 120000,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.status !== 0) {
      log(`Digest generation failed: ${(result.stderr || '').slice(0, 500)}`);
      return null;
    }
    return result.stdout.trim();
  } catch (err) {
    log(`Digest error: ${err.message}`);
    return null;
  }
}

// Main
async function main() {
  log(`Content scanner started (verbose=${VERBOSE}, dry-run=${DRY_RUN})`);

  // Ensure directories exist
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  acquireLock();

  try {
    const state = loadState();

    // Run scans (sequential since each shells out)
    const imessageData = scanIMessage();
    const readwiseData = scanReadwise();
    scanTwitter(); // placeholder

    // Generate digest
    const digest = generateDigest(imessageData, readwiseData);

    if (digest) {
      // Write digest
      if (!DRY_RUN) {
        const header = `# Content Scanner Digest\n_Generated: ${new Date().toISOString()}_\n\n`;
        fs.writeFileSync(DIGEST_FILE, header + digest);
        log(`Digest written to ${DIGEST_FILE}`);
      } else {
        log('Dry run: skipping digest write');
      }

      if (VERBOSE) {
        console.log('\n--- DIGEST ---');
        console.log(digest);
        console.log('--- END ---\n');
      }

      // Emit ambient event
      if (!DRY_RUN) {
        try {
          spawnSync(EVENT_TOOL, [
            'Content scanner digest ready - check ~/.claude/state/scanner-digest.md',
            '--source', 'content-scanner',
            '--priority', 'normal',
          ], { timeout: 10000 });
          log('Ambient event emitted');
        } catch (err) {
          log(`Event emission failed: ${err.message}`);
        }
      } else {
        log('Dry run: skipping event emission');
      }

      // Update state
      if (!DRY_RUN) {
        state.lastScan = {
          imessage: imessageData ? new Date().toISOString() : state.lastScan?.imessage,
          readwise: readwiseData ? new Date().toISOString() : state.lastScan?.readwise,
        };
        state.lastDigest = new Date().toISOString();
        state.lastSources = {
          imessageCount: imessageData ? imessageData.length : 0,
          readwiseCount: readwiseData ? (Array.isArray(readwiseData) ? readwiseData.length : 1) : 0,
        };
        saveState(state);
        log('State updated');
      } else {
        log('Dry run: skipping state update');
      }
    } else {
      log('No digest generated (no data or generation failed)');
    }

    log('Content scanner finished successfully');
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    process.exit(1);
  } finally {
    releaseLock();
  }
}

main();
