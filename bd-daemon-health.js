#!/usr/bin/env node

/**
 * bd-daemon-health - Health monitoring for Beads daemons
 *
 * Checks health of all registered beads daemons, auto-restarts
 * unhealthy ones, and sends alerts via ambient context system.
 *
 * Designed to run via launchd every 5 minutes.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_PATH = path.join(process.env.HOME, '.beads', 'registry.json');
const LOGS_DIR = path.join(process.env.HOME, 'ideas', 'logs');
const STATE_FILE = path.join(process.env.HOME, '.beads', 'daemon-health-state.json');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOGS_DIR, `bd-daemon-health-${new Date().toISOString().split('T')[0]}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function getWorkspaces() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (err) {
    log(`Error reading registry: ${err.message}`);
    return [];
  }
}

function getState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastCheck: null, issues: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    return { lastCheck: null, issues: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendAlert(message, priority = 'normal') {
  try {
    execSync(
      `~/.claude/bin/claude-event "${message}" --source beads-daemon --priority ${priority}`,
      { encoding: 'utf-8', shell: '/bin/bash' }
    );
    log(`Alert sent: ${message}`);
  } catch (err) {
    log(`Failed to send alert: ${err.message}`);
  }
}

function getCLIVersion() {
  try {
    const output = execSync('bd version 2>&1', { encoding: 'utf-8' });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

function getDaemonStatus(dbPath) {
  try {
    const output = execSync(`bd daemons status --db "${dbPath}" 2>&1`, { encoding: 'utf-8' });

    // Parse daemon status output
    const status = {
      running: output.includes('running') || output.includes('healthy'),
      version: null,
      pid: null,
      uptime: null
    };

    // Extract version if present
    const versionMatch = output.match(/version[:\s]+(\d+\.\d+\.\d+)/i);
    if (versionMatch) {
      status.version = versionMatch[1];
    }

    // Extract PID if present
    const pidMatch = output.match(/pid[:\s]+(\d+)/i);
    if (pidMatch) {
      status.pid = parseInt(pidMatch[1]);
    }

    return status;
  } catch (err) {
    return { running: false, error: err.message };
  }
}

function restartDaemon(dbPath, workspaceName) {
  log(`Restarting daemon for ${workspaceName}...`);
  try {
    // Kill existing daemon
    execSync(`bd daemons kill --db "${dbPath}" 2>&1`, { encoding: 'utf-8' });

    // Small delay before restart
    execSync('sleep 1');

    // Start new daemon
    execSync(`bd daemons start --db "${dbPath}" 2>&1`, { encoding: 'utf-8' });

    log(`Daemon restarted for ${workspaceName}`);
    return true;
  } catch (err) {
    log(`Failed to restart daemon for ${workspaceName}: ${err.message}`);
    return false;
  }
}

function checkHealth() {
  log('=== Daemon Health Check Starting ===');

  const workspaces = getWorkspaces();
  if (workspaces.length === 0) {
    log('No workspaces found');
    return;
  }

  const cliVersion = getCLIVersion();
  log(`CLI version: ${cliVersion || 'unknown'}`);

  const state = getState();
  const issues = {};
  let hasNewIssues = false;

  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const dbPath = workspace.database_path;

    if (!fs.existsSync(dbPath)) {
      log(`  ${name}: database not found, skipping`);
      continue;
    }

    const status = getDaemonStatus(dbPath);

    if (!status.running) {
      log(`  ${name}: NOT RUNNING`);
      issues[name] = 'not_running';

      // Try to restart
      if (restartDaemon(dbPath, name)) {
        issues[name] = 'restarted';
        if (!state.issues[name] || state.issues[name] !== 'not_running') {
          hasNewIssues = true;
        }
      }
    } else if (cliVersion && status.version && status.version !== cliVersion) {
      log(`  ${name}: VERSION MISMATCH (daemon: ${status.version}, CLI: ${cliVersion})`);
      issues[name] = 'version_mismatch';

      // Restart to update version
      if (restartDaemon(dbPath, name)) {
        issues[name] = 'restarted';
        if (!state.issues[name] || state.issues[name] !== 'version_mismatch') {
          hasNewIssues = true;
        }
      }
    } else {
      log(`  ${name}: healthy (v${status.version || 'unknown'})`);
    }
  }

  // Send alert if there are new issues
  const issueCount = Object.keys(issues).filter(k => issues[k] !== 'restarted').length;
  const restartCount = Object.keys(issues).filter(k => issues[k] === 'restarted').length;

  if (restartCount > 0) {
    const names = Object.keys(issues).filter(k => issues[k] === 'restarted').join(', ');
    sendAlert(`Beads daemons restarted: ${names}`, 'normal');
  }

  if (issueCount > 0 && hasNewIssues) {
    const names = Object.keys(issues).filter(k => issues[k] !== 'restarted').join(', ');
    sendAlert(`Beads daemon issues: ${names}`, 'urgent');
  }

  // Save state
  saveState({
    lastCheck: new Date().toISOString(),
    cliVersion,
    issues
  });

  log('=== Daemon Health Check Complete ===');
}

// CLI interface
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
bd-daemon-health - Health monitoring for Beads daemons

Usage:
  bd-daemon-health              Run health check
  bd-daemon-health --status     Show current health state
  bd-daemon-health --help       Show this help

Checks:
  - Daemon running status
  - Version match between CLI and daemons
  - Auto-restarts unhealthy daemons
  - Sends alerts via ambient context system

Designed to run via launchd every 5 minutes.
`);
  process.exit(0);
}

if (args.includes('--status') || args.includes('-s')) {
  const state = getState();
  console.log('\nDaemon Health Status:\n');

  if (state.lastCheck) {
    console.log(`Last check: ${state.lastCheck}`);
    console.log(`CLI version: ${state.cliVersion || 'unknown'}\n`);

    const issueEntries = Object.entries(state.issues);
    if (issueEntries.length === 0) {
      console.log('All daemons healthy\n');
    } else {
      console.log('Issues:');
      issueEntries.forEach(([name, issue]) => {
        console.log(`  ${name}: ${issue}`);
      });
      console.log('');
    }
  } else {
    console.log('No health check has run yet\n');
  }

  // Also show current status
  console.log('Current daemon status:');
  const workspaces = getWorkspaces();
  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const status = getDaemonStatus(workspace.database_path);
    const indicator = status.running ? '✓' : '✗';
    const version = status.version ? `v${status.version}` : '';
    console.log(`  ${indicator} ${name} ${version}`);
  }
  console.log('');

  process.exit(0);
}

// Run health check
checkHealth();
