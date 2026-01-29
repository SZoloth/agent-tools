#!/usr/bin/env node

/**
 * idea-processor - Background processor for the AI idea inbox
 *
 * Picks up ideas from ~/ideas/inbox/, runs Claude on them,
 * and stores results in ~/ideas/projects/ and ~/ideas/completed/
 *
 * Designed to be run by launchd every 30 minutes.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const IDEAS_DIR = path.join(process.env.HOME, 'ideas');
const INBOX_DIR = path.join(IDEAS_DIR, 'inbox');
const PROCESSING_DIR = path.join(IDEAS_DIR, 'processing');
const COMPLETED_DIR = path.join(IDEAS_DIR, 'completed');
const PROJECTS_DIR = path.join(IDEAS_DIR, 'projects');
const LOGS_DIR = path.join(IDEAS_DIR, 'logs');
const NOTIFY_TITLE = 'Claude cleanup';
const NOTIFY_APP = path.join(process.env.HOME, 'Applications', 'Snitch.app');

const LOG_FILE = path.join(LOGS_DIR, `processor-${new Date().toISOString().split('T')[0]}.log`);

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

function ensureDirs() {
  [INBOX_DIR, PROCESSING_DIR, COMPLETED_DIR, PROJECTS_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function getNextIdea() {
  const files = fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.md'))
    .sort(); // Process in order
  return files.length > 0 ? files[0] : null;
}

function isProcessing() {
  const files = fs.readdirSync(PROCESSING_DIR).filter(f => f.endsWith('.md'));
  return files.length > 0;
}

function parseIdea(filepath) {
  const content = fs.readFileSync(filepath, 'utf-8');
  const titleMatch = content.match(/^# (.+)$/m);
  const complexityMatch = content.match(/^- Complexity: (.+)$/m);
  const descMatch = content.match(/## Description\n([\s\S]*?)(?=\n## |\n$)/);
  const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n## |\n$)/);
  const constraintsMatch = content.match(/## Constraints\n([\s\S]*?)(?=\n## |\n$)/);

  return {
    title: titleMatch ? titleMatch[1] : 'Untitled Idea',
    complexity: complexityMatch ? complexityMatch[1] : 'medium',
    description: descMatch ? descMatch[1].trim() : content,
    notes: notesMatch ? notesMatch[1].trim() : '',
    constraints: constraintsMatch ? constraintsMatch[1].trim() : '',
    rawContent: content
  };
}

function generateProjectName(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

async function processIdea(ideaFile) {
  const inboxPath = path.join(INBOX_DIR, ideaFile);
  const processingPath = path.join(PROCESSING_DIR, ideaFile);

  // Move to processing
  fs.renameSync(inboxPath, processingPath);
  log(`Moved ${ideaFile} to processing`);

  const idea = parseIdea(processingPath);
  const projectName = generateProjectName(idea.title);
  const projectDir = path.join(PROJECTS_DIR, projectName);

  // Create project directory
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Save the original idea in the project
  fs.copyFileSync(processingPath, path.join(projectDir, 'IDEA.md'));

  log(`Processing: ${idea.title}`);
  log(`Project dir: ${projectDir}`);

  // Build the prompt for Claude
  const prompt = `You are implementing an idea from a user's idea inbox. Work autonomously to create a working implementation.

## The Idea
${idea.title}

## Description
${idea.description}

## Additional Notes
${idea.notes}

## Constraints
${idea.constraints}

## Instructions
1. Create a complete, working implementation in the current directory (${projectDir})
2. Keep it simple and functional - this is a prototype/experiment
3. Include a README.md explaining what was built and how to use it
4. If it's a web app, make it self-contained (single HTML file or simple structure)
5. If it's a CLI tool, make it executable with clear usage instructions
6. Test that it works before finishing

Focus on getting something working quickly. This is from an idea inbox - the user wants to see their idea come to life, not a production system.

Start implementing now. Work in ${projectDir}.`;

  // Run Claude headlessly
  const claudeLogFile = path.join(LOGS_DIR, `claude-${projectName}-${Date.now()}.log`);

  log(`Running Claude... (log: ${claudeLogFile})`);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    // Use claude -p for headless mode with the project directory as cwd
    // detached: true creates a new process group so we can kill all children
    const claude = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    let output = '';
    let errorOutput = '';

    claude.stdout.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Timeout after 30 minutes (in case something goes wrong)
    // Kill entire process group with negative PID
    const timeout = setTimeout(() => {
      notifyKill(`Timeout reached, killing Claude process group (pid=${claude.pid})`);
      try {
        process.kill(-claude.pid, 'SIGTERM');
      } catch (e) {
        // Process may have already exited
        claude.kill('SIGTERM');
      }
    }, 30 * 60 * 1000);

    claude.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Math.round((Date.now() - startTime) / 1000);
      log(`Claude finished with code ${code} in ${duration}s`);

      // Save Claude's output
      fs.writeFileSync(claudeLogFile, `STDOUT:\n${output}\n\nSTDERR:\n${errorOutput}`);

      // Create completion summary
      const completedDir = path.join(COMPLETED_DIR, projectName);
      if (!fs.existsSync(completedDir)) {
        fs.mkdirSync(completedDir, { recursive: true });
      }

      const summary = `# ${idea.title}

## Status
${code === 0 ? '✅ Completed successfully' : '⚠️ Completed with issues'}

## Original Idea
${idea.description}

## Implementation
Project created at: ~/ideas/projects/${projectName}/

## Duration
${duration} seconds

## Claude Output
\`\`\`
${output.substring(0, 5000)}${output.length > 5000 ? '\n... (truncated)' : ''}
\`\`\`

## Processed
${new Date().toISOString()}
`;

      fs.writeFileSync(path.join(completedDir, 'SUMMARY.md'), summary);

      // Copy the idea file to completed
      fs.copyFileSync(processingPath, path.join(completedDir, 'IDEA.md'));

      // Remove from processing
      fs.unlinkSync(processingPath);

      log(`Completed: ${idea.title}`);
      log(`Results: ~/ideas/completed/${projectName}/`);
      log(`Project: ~/ideas/projects/${projectName}/`);

      resolve(code === 0);
    });

    claude.on('error', (err) => {
      clearTimeout(timeout);
      log(`Error running Claude: ${err.message}`);

      // Move back to inbox for retry
      if (fs.existsSync(processingPath)) {
        fs.renameSync(processingPath, inboxPath);
        log(`Moved ${ideaFile} back to inbox for retry`);
      }

      reject(err);
    });
  });
}

async function main() {
  ensureDirs();
  log('=== Idea Processor Starting ===');

  // Check if already processing something
  if (isProcessing()) {
    log('Already processing an idea, skipping this run');
    return;
  }

  // Get next idea from inbox
  const nextIdea = getNextIdea();
  if (!nextIdea) {
    log('No ideas in inbox');
    return;
  }

  try {
    await processIdea(nextIdea);
  } catch (err) {
    log(`Error processing idea: ${err.message}`);
  }

  log('=== Idea Processor Complete ===');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
