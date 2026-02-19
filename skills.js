#!/usr/bin/env node
/**
 * Wrapper for `npx skills` that ensures skills are properly linked to Claude Code
 *
 * Usage:
 *   skills.js find <query>                    - Search for skills
 *   skills.js add owner/repo/path/to/skill    - Install (shorthand)
 *   skills.js add <url> --skill <name>        - Install (full format)
 *   skills.js sync                            - Fix all symlinks
 *   skills.js help                            - Show this help
 *
 * Examples:
 *   skills.js find react
 *   skills.js add vercel-labs/agent-skills/skills/react-best-practices -y
 *   skills.js add https://github.com/remotion-dev/skills --skill remotion-best-practices -y
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const AGENTS_SKILLS = path.join(os.homedir(), '.agents', 'skills');
const CLAUDE_SKILLS = path.join(os.homedir(), '.claude', 'skills');

function syncSkillsToClaudeCode() {
  // Ensure directories exist
  if (!fs.existsSync(AGENTS_SKILLS)) {
    console.log('No ~/.agents/skills/ directory found');
    return 0;
  }

  if (!fs.existsSync(CLAUDE_SKILLS)) {
    fs.mkdirSync(CLAUDE_SKILLS, { recursive: true });
  }

  // Get all skills from ~/.agents/skills/
  const agentSkills = fs.readdirSync(AGENTS_SKILLS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let fixed = 0;
  let created = 0;

  for (const skill of agentSkills) {
    const sourcePath = path.join(AGENTS_SKILLS, skill);
    const targetPath = path.join(CLAUDE_SKILLS, skill);

    // Check if SKILL.md exists (valid skill)
    if (!fs.existsSync(path.join(sourcePath, 'SKILL.md'))) {
      continue;
    }

    // Check current state
    let needsLink = false;
    let action = '';

    if (fs.existsSync(targetPath) || fs.lstatSync(targetPath).isSymbolicLink()) {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        // Check if broken or relative
        try {
          fs.realpathSync(targetPath);
          // Link works, but check if it's absolute
          const linkTarget = fs.readlinkSync(targetPath);
          if (!path.isAbsolute(linkTarget)) {
            needsLink = true;
            action = 'fix';
          }
        } catch {
          // Broken link
          needsLink = true;
          action = 'fix';
        }
      }
      // If it's a real directory, leave it alone
    } else {
      needsLink = true;
      action = 'create';
    }

    if (needsLink) {
      // Remove existing broken/relative link
      if (action === 'fix') {
        fs.unlinkSync(targetPath);
        fixed++;
      } else {
        created++;
      }
      // Create absolute symlink
      fs.symlinkSync(sourcePath, targetPath);
      console.log(`  ${action === 'fix' ? '🔧' : '✓'} ${skill}`);
    }
  }

  return fixed + created;
}

function showHelp() {
  console.log(`
skills.js - Install agent skills with auto-sync to Claude Code

Usage:
  skills.js find <query>                    Search for skills
  skills.js add owner/repo/path/to/skill    Install (shorthand format)
  skills.js add <url> --skill <name>        Install (full format)
  skills.js sync                            Fix all symlinks to Claude Code
  skills.js check                           Check for updates
  skills.js help                            Show this help

Examples:
  skills.js find react
  skills.js add vercel-labs/agent-skills/skills/react-best-practices -y
  skills.js add https://github.com/remotion-dev/skills --skill remotion-best-practices -y

Note: If shorthand format fails, try the full URL + --skill format.
Skills are synced to ~/.claude/skills/ automatically after install.
`);
}

function main() {
  const args = process.argv.slice(2);

  // Handle help
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    showHelp();
    return;
  }

  // Handle our custom 'sync' command
  if (args[0] === 'sync') {
    console.log('Syncing skills to Claude Code...');
    const count = syncSkillsToClaudeCode();
    if (count === 0) {
      console.log('All skills already synced.');
    } else {
      console.log(`\nSynced ${count} skill(s). Restart Claude Code to load them.`);
    }
    return;
  }

  // Pass through to npx skills
  const result = spawnSync('npx', ['skills', ...args], {
    stdio: 'inherit',
    shell: true
  });

  // After 'add' command, sync to Claude Code
  if (args[0] === 'add' && result.status === 0) {
    console.log('\n📦 Syncing to Claude Code...');
    const count = syncSkillsToClaudeCode();
    if (count > 0) {
      console.log(`\n✓ Restart Claude Code to load new skills.`);
    }
  }

  process.exit(result.status || 0);
}

main();
