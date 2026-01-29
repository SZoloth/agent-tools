#!/usr/bin/env node

/**
 * chat-summarizer.js - Daily chat summarizer for Slack and Google Chat
 *
 * Orchestrates browser-based scraping of chat messages and uses Claude
 * to generate a daily summary saved to ~/summaries/YYYY-MM-DD.md
 *
 * Designed to be run by launchd at 6am daily.
 *
 * Note: Uses execSync with hardcoded paths only (no user input).
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths
const HOME = process.env.HOME;
const SUMMARIES_DIR = path.join(HOME, 'summaries');
const LOGS_DIR = path.join(SUMMARIES_DIR, 'logs');
const STATE_FILE = path.join(HOME, '.claude', 'state', 'chat-summarizer-state.json');
const BROWSER_TOOLS = path.join(HOME, 'agent-tools', 'browser-tools');
const LIB_DIR = path.join(HOME, 'agent-tools', 'lib');

// Get script directory for imports
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Today's date for filename
const TODAY = new Date().toISOString().split('T')[0];
const LOG_FILE = path.join(LOGS_DIR, `summarizer-${TODAY}.log`);
const NOTIFY_TITLE = 'Claude cleanup';
const NOTIFY_APP = path.join(HOME, 'Applications', 'Snitch.app');

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function notifyKill(message) {
  log(message);
  try {
    if (fs.existsSync(NOTIFY_APP)) {
      execSync(`/usr/bin/open -a ${JSON.stringify(NOTIFY_APP)} --args ${JSON.stringify(message)} ${JSON.stringify(NOTIFY_TITLE)}`);
      return;
    }
    const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${NOTIFY_TITLE}"`;
    execSync(`/usr/bin/osascript -e ${JSON.stringify(script)}`);
  } catch {}
}

function ensureDirs() {
  [SUMMARIES_DIR, LOGS_DIR, path.dirname(STATE_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { last_run: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function alreadyRanToday(state) {
  if (!state.last_run) return false;
  const lastRun = state.last_run.split('T')[0];
  return lastRun === TODAY;
}

async function startBrowser() {
  log('Starting Chrome with user profile...');

  try {
    // Check if already running - uses fixed URL, safe
    execSync('curl -s http://localhost:9222/json/version', { stdio: 'pipe' });
    log('Chrome already running on :9222');
    return true;
  } catch {
    // Need to start it
  }

  try {
    const browserStart = path.join(BROWSER_TOOLS, 'browser-start.js');
    // Note: path is constructed from constants, not user input
    execSync(`node "${browserStart}" --profile`, {
      stdio: 'inherit',
      timeout: 60000
    });
    log('Chrome started with user profile');

    // Give it a moment to fully initialize
    await new Promise(r => setTimeout(r, 3000));
    return true;
  } catch (err) {
    log(`Error starting Chrome: ${err.message}`);
    return false;
  }
}

async function runScraper(scraperName) {
  const scraperPath = path.join(LIB_DIR, `${scraperName}.js`);

  return new Promise((resolve) => {
    log(`Running ${scraperName}...`);

    const child = spawn('node', [scraperPath], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 2 minute timeout per scraper
    const timeout = setTimeout(() => {
      notifyKill(`${scraperName} timeout, killing process`);
      child.kill('SIGTERM');
    }, 2 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      log(`${scraperName} finished with code ${code}`);

      if (stderr) {
        log(`${scraperName} stderr: ${stderr.substring(0, 500)}`);
      }

      // Try to parse JSON from the output
      try {
        // Find the JSON part (after "--- Results ---")
        const jsonMatch = stdout.match(/--- Results ---\s*([\s\S]*)/);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[1].trim());
          resolve({ success: true, data: json });
        } else {
          resolve({ success: false, error: 'No JSON output found', raw: stdout });
        }
      } catch (e) {
        resolve({ success: false, error: `Parse error: ${e.message}`, raw: stdout });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      log(`${scraperName} error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

function formatMessagesForPrompt(slackData, gchatData) {
  let prompt = `You are summarizing chat messages from the past day. Create a concise, actionable summary highlighting:
- Key discussions and decisions
- Action items mentioned
- Questions that need attention
- Important announcements

Be brief but comprehensive. Group by topic where possible. Use bullet points.

## RAW MESSAGES

`;

  // Slack messages
  if (slackData?.workspace) {
    prompt += `### Slack - ${slackData.workspace}\n\n`;

    if (slackData.channels?.length > 0) {
      for (const channel of slackData.channels) {
        prompt += `#### #${channel.name}\n`;
        for (const msg of channel.messages.slice(-20)) {
          prompt += `- **${msg.sender}**: ${msg.text.substring(0, 300)}\n`;
        }
        prompt += '\n';
      }
    }

    if (slackData.dms?.length > 0) {
      prompt += `#### Direct Messages\n`;
      for (const dm of slackData.dms) {
        prompt += `##### From: ${dm.name}\n`;
        for (const msg of dm.messages.slice(-10)) {
          prompt += `- **${msg.sender}**: ${msg.text.substring(0, 300)}\n`;
        }
        prompt += '\n';
      }
    }

    if (slackData.errors?.length > 0) {
      prompt += `*Note: Slack errors: ${slackData.errors.join(', ')}*\n\n`;
    }
  }

  // Google Chat messages
  if (gchatData?.account) {
    prompt += `### Google Chat - ${gchatData.account}\n\n`;

    if (gchatData.conversations?.length > 0) {
      prompt += `#### Conversations\n`;
      for (const conv of gchatData.conversations) {
        prompt += `##### ${conv.name}\n`;
        for (const msg of conv.messages.slice(-20)) {
          prompt += `- **${msg.sender}**: ${msg.text.substring(0, 300)}\n`;
        }
        prompt += '\n';
      }
    }

    if (gchatData.spaces?.length > 0) {
      prompt += `#### Spaces\n`;
      for (const space of gchatData.spaces) {
        prompt += `##### ${space.name}\n`;
        for (const msg of space.messages.slice(-20)) {
          prompt += `- **${msg.sender}**: ${msg.text.substring(0, 300)}\n`;
        }
        prompt += '\n';
      }
    }

    if (gchatData.errors?.length > 0) {
      prompt += `*Note: Google Chat errors: ${gchatData.errors.join(', ')}*\n\n`;
    }
  }

  prompt += `
---

Now provide a summary in this format:

# Daily Chat Summary - ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

## Key Highlights
[2-3 most important items]

## Slack - [Workspace Name]
### [Channel/DM Name]
- [Key point 1]
- [Key point 2]

## Google Chat - [Account]
### [Conversation/Space Name]
- [Key point 1]
- [Key point 2]

## Action Items
- [ ] [Item 1]
- [ ] [Item 2]

## Questions Needing Attention
- [Question 1]

---
Generated at ${new Date().toLocaleTimeString('en-US')} ${Intl.DateTimeFormat().resolvedOptions().timeZone}
`;

  return prompt;
}

async function runClaude(prompt) {
  log('Running Claude for summarization...');

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 10 minute timeout for Claude
    const timeout = setTimeout(() => {
      notifyKill('Claude timeout, killing process');
      child.kill('SIGTERM');
    }, 10 * 60 * 1000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      log(`Claude finished with code ${code}`);

      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error(stderr || 'Claude produced no output'));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function saveSummary(content) {
  const outputFile = path.join(SUMMARIES_DIR, `${TODAY}.md`);
  fs.writeFileSync(outputFile, content);
  log(`Summary saved to ${outputFile}`);
  return outputFile;
}

async function main() {
  ensureDirs();
  log('=== Chat Summarizer Starting ===');

  // Check if already ran today (unless --force flag)
  const force = process.argv.includes('--force');
  const state = loadState();

  if (!force && alreadyRanToday(state)) {
    log('Already ran today, skipping. Use --force to override.');
    return;
  }

  // Start browser
  const browserStarted = await startBrowser();
  if (!browserStarted) {
    log('Failed to start browser, aborting');
    return;
  }

  // Give browser time to settle
  await new Promise(r => setTimeout(r, 2000));

  // Run scrapers
  const slackResult = await runScraper('slack-scraper');
  const gchatResult = await runScraper('gchat-scraper');

  // Check if we have any data
  const slackData = slackResult.success ? slackResult.data : { errors: [slackResult.error] };
  const gchatData = gchatResult.success ? gchatResult.data : { errors: [gchatResult.error] };

  const hasSlackMessages = (slackData.channels?.length > 0 || slackData.dms?.length > 0);
  const hasGchatMessages = (gchatData.conversations?.length > 0 || gchatData.spaces?.length > 0);

  if (!hasSlackMessages && !hasGchatMessages) {
    log('No messages found from either service');

    // Still save a note about the run
    const noMessagesSummary = `# Daily Chat Summary - ${TODAY}

## Status
No unread messages found in Slack or Google Chat.

### Slack
${slackResult.success ? `Connected to ${slackData.workspace}, but no unread channels.` : `Error: ${slackResult.error}`}

### Google Chat
${gchatResult.success ? `Connected to ${gchatData.account}, but no unread conversations.` : `Error: ${gchatResult.error}`}

---
Generated at ${new Date().toLocaleTimeString('en-US')}
`;

    saveSummary(noMessagesSummary);
    saveState({ last_run: new Date().toISOString(), channels_processed: [] });
    log('=== Chat Summarizer Complete (no messages) ===');
    return;
  }

  // Generate prompt and run Claude
  const prompt = formatMessagesForPrompt(slackData, gchatData);

  try {
    const summary = await runClaude(prompt);
    saveSummary(summary);

    // Update state
    const processedChannels = [
      ...(slackData.channels?.map(c => `#${c.name}`) || []),
      ...(slackData.dms?.map(d => `DM:${d.name}`) || []),
      ...(gchatData.conversations?.map(c => `GChat:${c.name}`) || []),
      ...(gchatData.spaces?.map(s => `Space:${s.name}`) || []),
    ];

    saveState({
      last_run: new Date().toISOString(),
      channels_processed: processedChannels
    });

    log('=== Chat Summarizer Complete ===');
  } catch (err) {
    log(`Error running Claude: ${err.message}`);

    // Save raw data as fallback
    const fallbackSummary = `# Daily Chat Summary - ${TODAY} (Raw Data)

*Claude summarization failed: ${err.message}*

## Slack - ${slackData.workspace || 'Unknown'}
${JSON.stringify(slackData, null, 2)}

## Google Chat - ${gchatData.account || 'Unknown'}
${JSON.stringify(gchatData, null, 2)}

---
Generated at ${new Date().toLocaleTimeString('en-US')} (fallback mode)
`;

    saveSummary(fallbackSummary);
    saveState({ last_run: new Date().toISOString(), channels_processed: [], error: err.message });
    log('=== Chat Summarizer Complete (with errors) ===');
  }
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
