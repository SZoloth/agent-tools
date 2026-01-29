#!/usr/bin/env node

/**
 * idea - Quick capture for the AI idea inbox
 *
 * Usage:
 *   idea "Build a CLI tool that converts markdown to slides"
 *   idea "Create a habit tracker with streaks" --complexity high
 *   idea --list              # Show queued ideas
 *   idea --status            # Show processing status
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const IDEAS_DIR = path.join(process.env.HOME, 'ideas');
const INBOX_DIR = path.join(IDEAS_DIR, 'inbox');
const PROCESSING_DIR = path.join(IDEAS_DIR, 'processing');
const COMPLETED_DIR = path.join(IDEAS_DIR, 'completed');
const PROJECTS_DIR = path.join(IDEAS_DIR, 'projects');

// Ensure directories exist
[INBOX_DIR, PROCESSING_DIR, COMPLETED_DIR, PROJECTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

function listIdeas(dir, label) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log(`  (none)`);
    return;
  }
  files.forEach(f => {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1] : f.replace('.md', '');
    const stat = fs.statSync(path.join(dir, f));
    const age = Math.round((Date.now() - stat.mtimeMs) / 1000 / 60);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age/60)}h ago`;
    console.log(`  • ${title} (${ageStr})`);
  });
}

function showStatus() {
  console.log('\n📥 Inbox (queued):');
  listIdeas(INBOX_DIR, 'inbox');

  console.log('\n⚙️  Processing:');
  listIdeas(PROCESSING_DIR, 'processing');

  console.log('\n✅ Completed (last 5):');
  const completed = fs.readdirSync(COMPLETED_DIR)
    .filter(f => fs.statSync(path.join(COMPLETED_DIR, f)).isDirectory())
    .sort((a, b) => {
      const statA = fs.statSync(path.join(COMPLETED_DIR, a));
      const statB = fs.statSync(path.join(COMPLETED_DIR, b));
      return statB.mtimeMs - statA.mtimeMs;
    })
    .slice(0, 5);

  if (completed.length === 0) {
    console.log('  (none)');
  } else {
    completed.forEach(dir => {
      const summaryPath = path.join(COMPLETED_DIR, dir, 'SUMMARY.md');
      let title = dir;
      if (fs.existsSync(summaryPath)) {
        const content = fs.readFileSync(summaryPath, 'utf-8');
        const titleMatch = content.match(/^# (.+)$/m);
        if (titleMatch) title = titleMatch[1];
      }
      console.log(`  • ${title}`);
      console.log(`    → ~/ideas/completed/${dir}/`);
    });
  }

  console.log('\n');
}

function createIdea(description, options = {}) {
  const id = generateId();
  const slug = generateSlug(description.substring(0, 50));
  const filename = `${id}-${slug}.md`;
  const filepath = path.join(INBOX_DIR, filename);

  const complexity = options.complexity || 'medium';
  const now = new Date().toISOString();

  const content = `# ${description}

## Metadata
- Created: ${now}
- Complexity: ${complexity}
- Status: queued

## Description
${description}

## Notes
${options.notes || '(Add any additional context here)'}

## Constraints
${options.constraints || '- Keep it simple and functional\n- Use existing patterns from the codebase where applicable'}
`;

  fs.writeFileSync(filepath, content);

  console.log(`\n✨ Idea captured!`);
  console.log(`   File: ~/ideas/inbox/${filename}`);
  console.log(`   Next processing run will pick it up.\n`);
  console.log(`   Run 'idea --status' to check the queue.\n`);
}

// Parse arguments
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
idea - Quick capture for the AI idea inbox

Usage:
  idea "Your idea description here"
  idea "Build X" --complexity high
  idea --status              Show queue status
  idea --list                Alias for --status

Options:
  --complexity <low|medium|high>   Hint for how complex the idea is
  --notes "extra context"          Additional notes for Claude
  --constraints "requirements"     Specific requirements/constraints

Examples:
  idea "Build a CLI tool that converts markdown to presentation slides"
  idea "Create a habit tracker with streak counting" --complexity medium
  idea "Add dark mode to the training app" --notes "Use CSS variables"
`);
  process.exit(0);
}

if (args.includes('--status') || args.includes('--list') || args.includes('-l')) {
  showStatus();
  process.exit(0);
}

// Parse options
const options = {};
let description = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--complexity' && args[i + 1]) {
    options.complexity = args[++i];
  } else if (args[i] === '--notes' && args[i + 1]) {
    options.notes = args[++i];
  } else if (args[i] === '--constraints' && args[i + 1]) {
    options.constraints = args[++i];
  } else if (!args[i].startsWith('--')) {
    description = args[i];
  }
}

if (!description) {
  console.error('Error: Please provide an idea description');
  console.error('Usage: idea "Your idea here"');
  process.exit(1);
}

createIdea(description, options);
