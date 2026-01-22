#!/usr/bin/env node

/**
 * bd-dashboard - Cross-workspace Beads dashboard
 *
 * Aggregates insights across all registered beads workspaces:
 * - Open issues by priority and workspace
 * - Automation queue status
 * - Drift alerts
 * - Daemon health
 * - Critical path and blocking chains
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const REGISTRY_PATH = path.join(process.env.HOME, '.beads', 'registry.json');
const HEALTH_STATE = path.join(process.env.HOME, '.beads', 'daemon-health-state.json');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function c(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function getWorkspaces() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (err) {
    return [];
  }
}

function getIssues(dbPath, status = 'open') {
  try {
    const result = execSync(
      `bd list -s ${status} --json --db "${dbPath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    return [];
  }
}

function getAutomateIssues(dbPath) {
  try {
    const result = execSync(
      `bd list -l automate -s open --json --db "${dbPath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    return [];
  }
}

function getRobotInsights(workspacePath) {
  try {
    const result = execSync(
      `bv -robot-insights`,
      { encoding: 'utf-8', cwd: workspacePath, timeout: 30000 }
    );
    return JSON.parse(result);
  } catch (err) {
    return null;
  }
}

function getDriftStatus(workspacePath) {
  try {
    // Use spawnSync because bv returns non-zero exit codes for drift detected
    const result = spawnSync('bv', ['-check-drift', '--robot-drift'], {
      encoding: 'utf-8',
      cwd: workspacePath,
      timeout: 30000
    });
    // Output goes to stderr for non-zero exits
    const output = result.stdout || result.stderr;
    if (output) {
      return JSON.parse(output);
    }
    return null;
  } catch (err) {
    return null;
  }
}

function getDaemonHealth() {
  if (!fs.existsSync(HEALTH_STATE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(HEALTH_STATE, 'utf-8'));
  } catch (err) {
    return null;
  }
}

function priorityLabel(p) {
  const labels = ['P0 🔴', 'P1 🟠', 'P2 🟡', 'P3 🔵', 'P4 ⚪'];
  return labels[p] || 'P?';
}

function printSection(title) {
  console.log(`\n${c('bold', c('cyan', `━━━ ${title} ━━━`))}`);
}

function printSummary(workspaces) {
  printSection('Workspace Summary');

  let totalOpen = 0;
  let totalInProgress = 0;
  let totalAutomate = 0;

  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const openIssues = getIssues(workspace.database_path, 'open');
    const inProgressIssues = getIssues(workspace.database_path, 'in_progress');
    const automateIssues = getAutomateIssues(workspace.database_path);

    totalOpen += openIssues.length;
    totalInProgress += inProgressIssues.length;
    totalAutomate += automateIssues.length;

    const openStr = openIssues.length > 0 ? c('yellow', openIssues.length) : c('dim', '0');
    const progressStr = inProgressIssues.length > 0 ? c('blue', inProgressIssues.length) : c('dim', '0');
    const autoStr = automateIssues.length > 0 ? c('magenta', automateIssues.length) : c('dim', '0');

    console.log(`  ${c('bold', name.padEnd(20))} open: ${openStr}  in_progress: ${progressStr}  automate: ${autoStr}`);
  }

  console.log(`\n  ${c('bold', 'Total'.padEnd(20))} open: ${c('yellow', totalOpen)}  in_progress: ${c('blue', totalInProgress)}  automate: ${c('magenta', totalAutomate)}`);
}

function printAutomationQueue(workspaces) {
  printSection('Automation Queue');

  const allAutomate = [];
  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const issues = getAutomateIssues(workspace.database_path);
    issues.forEach(issue => {
      allAutomate.push({ ...issue, workspace: name });
    });
  }

  if (allAutomate.length === 0) {
    console.log(c('dim', '  (empty queue)'));
    return;
  }

  // Sort by priority
  allAutomate.sort((a, b) => (a.priority || 2) - (b.priority || 2));

  allAutomate.forEach(issue => {
    const prio = priorityLabel(issue.priority || 2);
    console.log(`  ${prio} ${c('white', issue.id.padEnd(12))} ${issue.title.substring(0, 50)}${issue.title.length > 50 ? '...' : ''}`);
    console.log(`       ${c('dim', issue.workspace)}`);
  });
}

function printDriftAlerts(workspaces) {
  printSection('Drift Status');

  let hasDrift = false;

  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const drift = getDriftStatus(workspace.workspace_path);

    if (!drift) {
      console.log(`  ${name.padEnd(20)} ${c('dim', 'no baseline')}`);
      continue;
    }

    if (drift.has_drift || drift.exit_code === 1 || drift.exit_code === 2) {
      hasDrift = true;
      const severity = drift.exit_code === 1 ? c('red', '⚠ CRITICAL DRIFT') : c('yellow', '⚠ DRIFT');
      console.log(`  ${name.padEnd(20)} ${severity}`);

      // Show alerts if present
      if (drift.alerts && drift.alerts.length > 0) {
        drift.alerts.forEach(alert => {
          const color = alert.severity === 'critical' ? 'red' : alert.severity === 'warning' ? 'yellow' : 'dim';
          console.log(`       ${c(color, alert.message)}`);
        });
      }

      // Also show changes if present (older format)
      if (drift.changes) {
        if (drift.changes.new_issues > 0) {
          console.log(`       ${c('yellow', `+${drift.changes.new_issues} new issues`)}`);
        }
        if (drift.changes.closed_issues > 0) {
          console.log(`       ${c('green', `${drift.changes.closed_issues} closed`)}`);
        }
        if (drift.changes.priority_changes > 0) {
          console.log(`       ${c('blue', `${drift.changes.priority_changes} priority changes`)}`);
        }
      }
    } else {
      console.log(`  ${name.padEnd(20)} ${c('green', '✓ stable')}`);
    }
  }

  if (!hasDrift) {
    console.log(c('dim', '\n  All workspaces stable from baseline'));
  }
}

function printDaemonStatus() {
  printSection('Daemon Health');

  const health = getDaemonHealth();

  if (!health || !health.lastCheck) {
    console.log(c('dim', '  No health check has run yet'));
    console.log(c('dim', '  Run: bd-daemon-health'));
    return;
  }

  const lastCheck = new Date(health.lastCheck);
  const ageMin = Math.round((Date.now() - lastCheck.getTime()) / 60000);
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;

  console.log(`  Last check: ${c('dim', ageStr)} (CLI v${health.cliVersion || '?'})`);

  const issues = Object.entries(health.issues || {});
  if (issues.length === 0) {
    console.log(`  ${c('green', '✓ All daemons healthy')}`);
  } else {
    issues.forEach(([name, status]) => {
      const statusStr = status === 'restarted' ? c('yellow', 'restarted') : c('red', status);
      console.log(`  ${name}: ${statusStr}`);
    });
  }
}

function printInsights(workspaces) {
  printSection('Graph Insights');

  for (const workspace of workspaces) {
    const name = path.basename(workspace.workspace_path);
    const insights = getRobotInsights(workspace.workspace_path);

    if (!insights) {
      continue;
    }

    console.log(`\n  ${c('bold', name)}`);

    // Critical path
    if (insights.critical_path && insights.critical_path.length > 0) {
      console.log(`    ${c('cyan', 'Critical path:')} ${insights.critical_path.slice(0, 3).map(i => i.id).join(' → ')}`);
    }

    // High betweenness (bottlenecks)
    if (insights.bottlenecks && insights.bottlenecks.length > 0) {
      console.log(`    ${c('yellow', 'Bottlenecks:')} ${insights.bottlenecks.slice(0, 3).map(i => i.id).join(', ')}`);
    }

    // Blocked chains
    if (insights.blocked_chains && insights.blocked_chains.length > 0) {
      console.log(`    ${c('red', 'Blocked:')} ${insights.blocked_chains.length} chain(s)`);
    }

    // Cycles
    if (insights.has_cycles) {
      console.log(`    ${c('red', '⚠ Dependency cycles detected!')}`);
    }
  }
}

function printQuickActions() {
  printSection('Quick Actions');

  console.log(`  ${c('cyan', 'bd-idea "..."')}        Add idea to automation queue`);
  console.log(`  ${c('cyan', 'bd-automate')}         Process next automation item`);
  console.log(`  ${c('cyan', 'bv')}                  Open TUI viewer`);
  console.log(`  ${c('cyan', 'bd-daemon-health')}    Check daemon health`);
}

// Main
function main() {
  console.log(c('bold', '\n🔮 Beads Cross-Workspace Dashboard'));
  console.log(c('dim', `   ${new Date().toLocaleString()}`));

  const workspaces = getWorkspaces();

  if (workspaces.length === 0) {
    console.log(c('red', '\nNo workspaces found. Register with: bd init'));
    process.exit(1);
  }

  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
bd-dashboard - Cross-workspace Beads dashboard

Usage:
  bd-dashboard              Full dashboard
  bd-dashboard --summary    Workspace summary only
  bd-dashboard --queue      Automation queue only
  bd-dashboard --drift      Drift status only
  bd-dashboard --json       Output as JSON
  bd-dashboard --help       Show this help

Views:
  • Workspace summary (open/in_progress/automate counts)
  • Automation queue (sorted by priority)
  • Drift alerts (changes from baseline)
  • Daemon health status
  • Graph insights (critical path, bottlenecks)
`);
    process.exit(0);
  }

  if (args.includes('--json')) {
    const data = {
      timestamp: new Date().toISOString(),
      workspaces: workspaces.map(w => {
        const name = path.basename(w.workspace_path);
        return {
          name,
          path: w.workspace_path,
          open: getIssues(w.database_path, 'open').length,
          in_progress: getIssues(w.database_path, 'in_progress').length,
          automate: getAutomateIssues(w.database_path).length,
          drift: getDriftStatus(w.workspace_path),
          insights: getRobotInsights(w.workspace_path)
        };
      }),
      daemon_health: getDaemonHealth()
    };
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }

  if (args.includes('--summary')) {
    printSummary(workspaces);
    process.exit(0);
  }

  if (args.includes('--queue')) {
    printAutomationQueue(workspaces);
    process.exit(0);
  }

  if (args.includes('--drift')) {
    printDriftAlerts(workspaces);
    process.exit(0);
  }

  // Full dashboard
  printSummary(workspaces);
  printAutomationQueue(workspaces);
  printDriftAlerts(workspaces);
  printDaemonStatus();
  printInsights(workspaces);
  printQuickActions();

  console.log('');
}

main();
