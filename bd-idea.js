#!/usr/bin/env node

/**
 * bd-idea - Quick capture for Claude-automated Beads issues
 *
 * Convenience wrapper around `bd create -l automate` that creates
 * issues in the personal workspace by default.
 *
 * Usage:
 *   bd-idea "Build a CLI tool that converts markdown to slides"
 *   bd-idea "Create a habit tracker" --priority high
 *   bd-idea --status            # Show queued automation issues
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_PATH = path.join(process.env.HOME, '.beads', 'registry.json');
const PERSONAL_WORKSPACE_PATTERN = /personal/i;

function getWorkspaces() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('Error: No beads registry found at ~/.beads/registry.json');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error reading registry: ${err.message}`);
    process.exit(1);
  }
}

function getDefaultWorkspace(workspaces) {
  // Prefer personal workspace
  const personal = workspaces.find(w =>
    PERSONAL_WORKSPACE_PATTERN.test(w.workspace_path)
  );
  if (personal) return personal;

  // Fall back to first available
  return workspaces[0];
}

function priorityToNumber(priority) {
  const map = {
    'critical': 0, 'p0': 0, '0': 0,
    'high': 1, 'p1': 1, '1': 1,
    'medium': 2, 'p2': 2, '2': 2,
    'low': 3, 'p3': 3, '3': 3,
    'backlog': 4, 'p4': 4, '4': 4
  };
  return map[priority?.toLowerCase()] ?? 2;
}

function createIssue(title, options = {}) {
  const workspaces = getWorkspaces();
  let workspace;

  if (options.workspace) {
    workspace = workspaces.find(w =>
      w.workspace_path.toLowerCase().includes(options.workspace.toLowerCase())
    );
    if (!workspace) {
      console.error(`Error: No workspace matching "${options.workspace}"`);
      console.error('Available workspaces:');
      workspaces.forEach(w => console.error(`  - ${path.basename(w.workspace_path)}`));
      process.exit(1);
    }
  } else {
    workspace = getDefaultWorkspace(workspaces);
  }

  const dbPath = workspace.database_path;
  const priority = priorityToNumber(options.priority);

  // Build bd create command
  let cmd = `bd create "${title}" -l automate -p ${priority} --db "${dbPath}"`;

  if (options.description) {
    cmd += ` -d "${options.description}"`;
  }

  if (options.notes) {
    // bd uses --design for additional notes
    cmd += ` --design "${options.notes}"`;
  }

  try {
    const result = execSync(cmd, { encoding: 'utf-8' });
    const idMatch = result.match(/([a-z]+-[a-z0-9]+)/i);
    const issueId = idMatch ? idMatch[1] : 'created';

    console.log(`\n✨ Idea captured as Beads issue!`);
    console.log(`   Issue: ${issueId}`);
    console.log(`   Workspace: ${path.basename(workspace.workspace_path)}`);
    console.log(`   Priority: P${priority}`);
    console.log(`\n   Claude will process it automatically.`);
    console.log(`   Run 'bd-automate --status' to check the queue.\n`);
  } catch (err) {
    console.error(`Error creating issue: ${err.message}`);
    process.exit(1);
  }
}

function showStatus() {
  try {
    execSync('bd-automate --status', { stdio: 'inherit' });
  } catch (err) {
    console.error('Error running bd-automate --status');
    process.exit(1);
  }
}

function showWorkspaces() {
  const workspaces = getWorkspaces();
  const defaultWs = getDefaultWorkspace(workspaces);

  console.log('\nAvailable workspaces:\n');
  workspaces.forEach(w => {
    const name = path.basename(w.workspace_path);
    const isDefault = w === defaultWs ? ' (default)' : '';
    console.log(`  ${name}${isDefault}`);
  });
  console.log('');
}

// Parse arguments
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
bd-idea - Quick capture for Claude-automated Beads issues

Usage:
  bd-idea "Your idea description here"
  bd-idea "Build X" --priority high
  bd-idea --status              Show automation queue
  bd-idea --workspaces          List available workspaces

Options:
  --priority <level>      P0=critical, P1=high, P2=medium (default), P3=low, P4=backlog
  --workspace <name>      Target workspace (default: personal)
  --description, -d       Additional description
  --notes                 Extra notes for context

Examples:
  bd-idea "Build a CLI tool that converts markdown to slides"
  bd-idea "Create a habit tracker with streak counting" --priority high
  bd-idea "Add dark mode to the training app" --notes "Use CSS variables" --workspace work

The idea is created as a Beads issue with the 'automate' label.
bd-automate (running every 30 min) will process it with Claude.
`);
  process.exit(0);
}

if (args.includes('--status') || args.includes('-s')) {
  showStatus();
  process.exit(0);
}

if (args.includes('--workspaces') || args.includes('-w')) {
  showWorkspaces();
  process.exit(0);
}

// Parse options
const options = {};
let title = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--priority' || arg === '-p') {
    options.priority = args[++i];
  } else if (arg === '--workspace') {
    options.workspace = args[++i];
  } else if (arg === '--description' || arg === '-d') {
    options.description = args[++i];
  } else if (arg === '--notes') {
    options.notes = args[++i];
  } else if (!arg.startsWith('-')) {
    title = arg;
  }
}

if (!title) {
  console.error('Error: Please provide an idea description');
  console.error('Usage: bd-idea "Your idea here"');
  process.exit(1);
}

createIssue(title, options);
