#!/usr/bin/env node

/**
 * bd-automate - Claude automation processor for Beads issues
 *
 * Scans all registered Beads workspaces for issues labeled 'automate',
 * uses bv priority analysis to pick the highest-impact one, processes
 * it with headless Claude, and updates the issue with results.
 *
 * Designed to run via launchd every 30 minutes.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const REGISTRY_PATH = path.join(process.env.HOME, '.beads', 'registry.json');
const PROJECTS_DIR = path.join(process.env.HOME, 'ideas', 'projects');
const LOGS_DIR = path.join(process.env.HOME, 'ideas', 'logs');
const LOCK_FILE = path.join(process.env.HOME, '.beads', 'automate.lock');
const AUTOMATE_LABEL = 'automate';
const NOTIFY_TITLE = 'Claude cleanup';
const NOTIFY_APP = path.join(process.env.HOME, 'Applications', 'Snitch.app');

// Ensure directories exist
[PROJECTS_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const LOG_FILE = path.join(LOGS_DIR, `bd-automate-${new Date().toISOString().split('T')[0]}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
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

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    const lockAge = Date.now() - new Date(lockData.acquired).getTime();
    // Stale lock after 45 minutes
    if (lockAge < 45 * 60 * 1000) {
      log(`Lock held by PID ${lockData.pid} since ${lockData.acquired}`);
      return false;
    }
    log(`Stale lock detected, overriding`);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid,
    acquired: new Date().toISOString()
  }));
  return true;
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
  }
}

function getWorkspaces() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    log('No beads registry found');
    return [];
  }
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    return registry.filter(w => fs.existsSync(w.database_path));
  } catch (err) {
    log(`Error reading registry: ${err.message}`);
    return [];
  }
}

function getAutomateIssues(dbPath) {
  try {
    const result = execSync(
      `bd list -l ${AUTOMATE_LABEL} -s open --json --db "${dbPath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    // No issues or error - return empty
    return [];
  }
}

function getPriorityInsights(workspacePath) {
  try {
    const result = execSync(
      `bv -robot-priority`,
      { encoding: 'utf-8', cwd: workspacePath, timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    return null;
  }
}

function selectBestIssue(allIssues, priorityData) {
  if (allIssues.length === 0) return null;
  if (allIssues.length === 1) return allIssues[0];

  // If we have priority data, use it to rank
  if (priorityData?.recommendations) {
    const priorityMap = new Map();
    priorityData.recommendations.forEach((rec, idx) => {
      priorityMap.set(rec.id, idx);
    });

    // Sort by priority ranking (lower index = higher priority)
    allIssues.sort((a, b) => {
      const aRank = priorityMap.get(a.issue.id) ?? 999;
      const bRank = priorityMap.get(b.issue.id) ?? 999;
      return aRank - bRank;
    });
  }

  // Fall back to explicit priority field
  allIssues.sort((a, b) => (a.issue.priority || 2) - (b.issue.priority || 2));

  return allIssues[0];
}

function generateProjectName(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

// Detect if issue is research/exploration vs implementation
const RESEARCH_PATTERNS = [
  /^explore\b/i,
  /^research\b/i,
  /^evaluate\b/i,
  /^investigate\b/i,
  /^analyze\b/i,
  /^compare\b/i,
  /^assess\b/i,
  /^review\b/i,
  /^study\b/i,
  /^understand\b/i,
  /^learn about\b/i,
  /^look into\b/i,
  /^check out\b/i,
  /\bfeasibility\b/i,
  /\bpros and cons\b/i,
  /\bshould (we|i) use\b/i,
];

function isResearchIssue(title, description = '') {
  const text = `${title} ${description}`;
  return RESEARCH_PATTERNS.some(pattern => pattern.test(text));
}

async function processIssue(issue, workspace) {
  const { id, title, description, design, notes, acceptance } = issue.issue;
  const dbPath = workspace.database_path;
  const workspacePath = workspace.workspace_path;

  log(`Processing: ${id} - ${title}`);
  log(`Workspace: ${workspacePath}`);

  // Mark as in_progress
  try {
    execSync(`bd update ${id} -s in_progress --db "${dbPath}"`, { encoding: 'utf-8' });
    execSync(`bd comment ${id} "Claude automation started processing" --author "bd-automate" --db "${dbPath}"`, { encoding: 'utf-8' });
  } catch (err) {
    log(`Warning: Could not update status: ${err.message}`);
  }

  // Create project directory
  const projectName = generateProjectName(title);
  const projectDir = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Save issue info
  fs.writeFileSync(path.join(projectDir, 'ISSUE.md'), `# ${title}

## Beads Issue
- ID: ${id}
- Workspace: ${workspacePath}

## Description
${description || '(none)'}

## Notes
${design || notes || '(none)'}

## Acceptance Criteria
${acceptance || '(none)'}
`);

  // Build Claude prompt based on issue type
  const isResearch = isResearchIssue(title, description);
  let prompt;

  if (isResearch) {
    // Research/exploration prompt - DO NOT install or run anything
    prompt = `You are researching a topic for a Beads issue tracker. Your job is to gather information and provide a recommendation - NOT to implement or install anything.

## Issue: ${id}
${title}

## Description
${description || 'No description provided - research the topic based on the title.'}

## Notes
${design || notes || ''}

## CRITICAL INSTRUCTIONS
1. DO NOT install any software, packages, or dependencies
2. DO NOT launch any servers or applications
3. DO NOT create working implementations
4. DO NOT run any code that modifies the system

## What You Should Do
1. Use web search to research the topic thoroughly
2. Read documentation, reviews, and comparisons online
3. Analyze pros/cons, tradeoffs, and use cases
4. Create a RECOMMENDATION.md in ${projectDir} with:
   - Summary of what the tool/approach is
   - Key features and capabilities
   - Pros and cons
   - How it compares to alternatives (if relevant)
   - Your recommendation: should the user adopt this? Why or why not?
   - Next steps if they decide to proceed
5. Be thorough but concise - this is decision-support, not a book report

Focus on gathering actionable insights. DO NOT implement anything.`;
  } else {
    // Implementation prompt - build something
    prompt = `You are implementing an issue from a Beads issue tracker. Work autonomously to create a working implementation.

## Issue: ${id}
${title}

## Description
${description || 'No description provided - interpret the title and build something useful.'}

## Notes
${design || notes || ''}

## Acceptance Criteria
${acceptance || 'Create a working implementation that satisfies the title.'}

## Instructions
1. Create a complete, working implementation in the current directory (${projectDir})
2. Keep it simple and functional - this is a prototype/experiment
3. Include a README.md explaining what was built and how to use it
4. If it's a web app, make it self-contained (single HTML file or simple structure)
5. If it's a CLI tool, make it executable with clear usage instructions
6. Test that it works before finishing

Focus on getting something working quickly. Start implementing now.`;
  }

  log(`Issue type: ${isResearch ? 'RESEARCH' : 'IMPLEMENTATION'}`);

  const claudeLogFile = path.join(LOGS_DIR, `claude-${projectName}-${Date.now()}.log`);
  log(`Running Claude... (log: ${claudeLogFile})`);

  return new Promise((resolve) => {
    const startTime = Date.now();

    const claude = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    let output = '';
    let errorOutput = '';

    claude.stdout.on('data', (data) => { output += data.toString(); });
    claude.stderr.on('data', (data) => { errorOutput += data.toString(); });

    // Timeout after 30 minutes
    const timeout = setTimeout(() => {
      notifyKill(`Timeout reached, killing Claude process group (pid=${claude.pid})`);
      try {
        process.kill(-claude.pid, 'SIGTERM');
      } catch (e) {
        claude.kill('SIGTERM');
      }
    }, 30 * 60 * 1000);

    claude.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Math.round((Date.now() - startTime) / 1000);
      log(`Claude finished with code ${code} in ${duration}s`);

      // Save output
      fs.writeFileSync(claudeLogFile, `STDOUT:\n${output}\n\nSTDERR:\n${errorOutput}`);

      // Update beads issue
      const success = code === 0;
      const summary = success ? 'completed successfully' : 'completed with issues';

      try {
        const comment = `Claude automation ${summary} in ${duration}s.

**Project:** ~/ideas/projects/${projectName}/
**Log:** ${claudeLogFile}

${output.substring(0, 1000)}${output.length > 1000 ? '\n... (truncated)' : ''}`;

        // Write comment to temp file to handle special characters
        const commentFile = path.join(LOGS_DIR, `comment-${Date.now()}.txt`);
        fs.writeFileSync(commentFile, comment);
        execSync(`bd comment ${id} -f "${commentFile}" --author "bd-automate" --db "${dbPath}"`, { encoding: 'utf-8' });
        fs.unlinkSync(commentFile);

        if (success) {
          execSync(`bd close ${id} --db "${dbPath}"`, { encoding: 'utf-8' });
          log(`Closed issue ${id}`);
        } else {
          execSync(`bd update ${id} -s open --db "${dbPath}"`, { encoding: 'utf-8' });
          log(`Returned issue ${id} to open status`);
        }
      } catch (err) {
        log(`Warning: Could not update issue after processing: ${err.message}`);
      }

      log(`Completed: ${id} - ${title}`);
      log(`Project: ~/ideas/projects/${projectName}/`);

      resolve(success);
    });

    claude.on('error', (err) => {
      clearTimeout(timeout);
      log(`Error running Claude: ${err.message}`);

      try {
        execSync(`bd comment ${id} "Claude automation failed: ${err.message}" --author "bd-automate" --db "${dbPath}"`, { encoding: 'utf-8' });
        execSync(`bd update ${id} -s open --db "${dbPath}"`, { encoding: 'utf-8' });
      } catch (e) {
        // Ignore update errors
      }

      resolve(false);
    });
  });
}

async function main() {
  log('=== BD Automate Starting ===');

  if (!acquireLock()) {
    log('Could not acquire lock, exiting');
    return;
  }

  try {
    const workspaces = getWorkspaces();
    if (workspaces.length === 0) {
      log('No workspaces found');
      return;
    }

    log(`Found ${workspaces.length} workspace(s)`);

    // Collect all automate-labeled issues from all workspaces
    const allIssues = [];
    let priorityData = null;

    for (const workspace of workspaces) {
      log(`Scanning: ${workspace.workspace_path}`);
      const issues = getAutomateIssues(workspace.database_path);

      if (issues.length > 0) {
        log(`  Found ${issues.length} automate issue(s)`);
        issues.forEach(issue => {
          allIssues.push({ issue, workspace });
        });

        // Get priority insights from this workspace
        if (!priorityData) {
          priorityData = getPriorityInsights(workspace.workspace_path);
        }
      }
    }

    if (allIssues.length === 0) {
      log('No issues labeled with "automate" found');
      return;
    }

    log(`Total automate issues: ${allIssues.length}`);

    // Select highest priority issue
    const selected = selectBestIssue(allIssues, priorityData);
    if (!selected) {
      log('No suitable issue selected');
      return;
    }

    log(`Selected: ${selected.issue.id} - ${selected.issue.title}`);

    // Process it
    await processIssue(selected, selected.workspace);

  } finally {
    releaseLock();
    log('=== BD Automate Complete ===');
  }
}

// Handle CLI arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
bd-automate - Claude automation processor for Beads issues

Usage:
  bd-automate              Process one automate-labeled issue
  bd-automate --status     Show pending automate issues
  bd-automate --help       Show this help

The processor:
1. Scans all registered Beads workspaces
2. Finds issues labeled 'automate'
3. Uses bv priority analysis to pick the best one
4. Runs headless Claude to implement it
5. Updates the issue with results and closes it

To queue an issue for automation:
  bd create "Build a CLI tool" -l automate
  # or use: bd-idea "Build a CLI tool"
`);
  process.exit(0);
}

if (args.includes('--status') || args.includes('-s')) {
  const workspaces = getWorkspaces();
  console.log('\nAutomate-labeled issues across all workspaces:\n');

  let total = 0;
  for (const workspace of workspaces) {
    const issues = getAutomateIssues(workspace.database_path);
    if (issues.length > 0) {
      const name = path.basename(workspace.workspace_path);
      console.log(`${name}:`);
      issues.forEach(issue => {
        console.log(`  ${issue.id} [P${issue.priority || 2}] ${issue.title}`);
        total++;
      });
      console.log('');
    }
  }

  if (total === 0) {
    console.log('  (none)\n');
  } else {
    console.log(`Total: ${total} issue(s) queued for automation\n`);
  }

  // Check lock status
  if (fs.existsSync(LOCK_FILE)) {
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    console.log(`Currently processing (PID ${lockData.pid}, started ${lockData.acquired})\n`);
  }

  process.exit(0);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  releaseLock();
  process.exit(1);
});
