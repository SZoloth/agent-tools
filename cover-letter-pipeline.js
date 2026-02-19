#!/usr/bin/env node

/**
 * cover-letter-pipeline.js - Multi-model cover letter generation pipeline
 *
 * Three models draft independently in parallel, then Claude merges the best elements.
 *
 * Pipeline:
 *   Phase 1 (parallel):
 *     A. Claude  — VALUE-FIRST strategic brief
 *     B. Gemini  — Independent draft (different voice/framing)
 *     C. GPT-5.2 — Independent draft via Codex CLI (different reasoning style)
 *   Phase 2:
 *     Claude — Editorial merge + fact-check (cherry-pick best from all drafts)
 *
 * Usage:
 *   cover-letter-pipeline.js <company> [options]
 *     --research-dir <dir>    Path to company research folder
 *     --job-posting <file>    Path to job posting markdown
 *     --type <type>           Content type: cover-letter (default) or outreach
 *     --draft <file>          Use existing draft as Claude's input (skip Claude draft)
 *     --output <file>         Output path (default: ./cover-letter-final.md)
 *     --skip-gemini           Skip Gemini draft
 *     --skip-codex            Skip Codex/GPT draft
 *     --compare               Show all 3 drafts side-by-side, don't auto-merge
 *     --json                  Output JSON with all intermediate artifacts
 *     --verbose               Show progress for each step
 *
 * Examples:
 *   cover-letter-pipeline.js "Stripe" \
 *     --research-dir ~/Documents/LLM\ CONTEXT/1\ -\ personal/job_search/companies/stripe \
 *     --job-posting ./Job_Posting.md
 *
 *   cover-letter-pipeline.js "Linear" --type outreach \
 *     --research-dir ./companies/linear \
 *     --job-posting ./posting.md --compare
 *
 *   cover-letter-pipeline.js "Figma" \
 *     --research-dir ./companies/figma \
 *     --job-posting ./posting.md --skip-codex
 */

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ============================================================================
// CLI PARSING
// ============================================================================

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: cover-letter-pipeline.js <company> [options]

Options:
  --research-dir <dir>    Path to company research folder
  --job-posting <file>    Path to job posting markdown
  --type <type>           Content type: cover-letter (default) or outreach
  --draft <file>          Use existing draft as Claude's (skip Claude draft step)
  --output <file>         Output path (default: ./cover-letter-final.md)
  --skip-gemini           Skip Gemini draft
  --skip-codex            Skip Codex/GPT-5.2 draft
  --compare               Show all drafts side-by-side, don't auto-merge
  --json                  Output JSON with all intermediate artifacts
  --verbose               Show progress for each step

Pipeline (Phase 1 runs in parallel):
  A. Claude   — VALUE-FIRST strategic brief
  B. Gemini   — Independent draft (different voice)
  C. GPT-5.2  — Independent draft via Codex CLI (different reasoning)
  → Claude    — Editorial merge + fact-check (best of all drafts)

Examples:
  cover-letter-pipeline.js "Stripe" \\
    --research-dir ~/companies/stripe \\
    --job-posting ./Job_Posting.md

  cover-letter-pipeline.js "Linear" --type outreach \\
    --research-dir ./companies/linear \\
    --job-posting ./posting.md --compare`);
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const opts = {
  company: null,
  researchDir: null,
  jobPosting: null,
  type: 'cover-letter',
  draft: null,
  output: './cover-letter-final.md',
  skipGemini: false,
  skipCodex: false,
  compare: false,
  json: false,
  verbose: false,
};

const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--research-dir' && i + 1 < args.length) {
    opts.researchDir = args[++i];
  } else if (arg === '--job-posting' && i + 1 < args.length) {
    opts.jobPosting = args[++i];
  } else if (arg === '--type' && i + 1 < args.length) {
    opts.type = args[++i];
  } else if (arg === '--draft' && i + 1 < args.length) {
    opts.draft = args[++i];
  } else if (arg === '--output' && i + 1 < args.length) {
    opts.output = args[++i];
  } else if (arg === '--skip-gemini') {
    opts.skipGemini = true;
  } else if (arg === '--skip-codex') {
    opts.skipCodex = true;
  } else if (arg === '--compare') {
    opts.compare = true;
  } else if (arg === '--json') {
    opts.json = true;
  } else if (arg === '--verbose') {
    opts.verbose = true;
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  }
}

opts.company = positional[0] || null;

// ============================================================================
// VALIDATION
// ============================================================================

if (!opts.company) {
  console.error('Error: company name is required');
  process.exit(1);
}

if (!opts.researchDir) {
  console.error('Error: --research-dir is required');
  process.exit(1);
}

if (!fs.existsSync(opts.researchDir)) {
  console.error(`Error: research directory not found: ${opts.researchDir}`);
  process.exit(1);
}

if (!opts.draft && !opts.jobPosting) {
  console.error('Error: --job-posting is required (unless using --draft)');
  process.exit(1);
}

if (opts.jobPosting && !fs.existsSync(opts.jobPosting)) {
  console.error(`Error: job posting file not found: ${opts.jobPosting}`);
  process.exit(1);
}

if (opts.draft && !fs.existsSync(opts.draft)) {
  console.error(`Error: draft file not found: ${opts.draft}`);
  process.exit(1);
}

// ============================================================================
// HELPERS
// ============================================================================

function log(msg) {
  if (opts.verbose) console.error(msg);
}

function logStep(label, name) {
  console.error(`\n[${label}] ${name}`);
}

function gatherResearch() {
  const dir = opts.researchDir;
  let research = '';

  const insightsPath = path.join(dir, 'insights.md');
  if (fs.existsSync(insightsPath)) {
    research += `## Research Insights\n\n${fs.readFileSync(insightsPath, 'utf8')}\n\n`;
    log('  Read insights.md');
  }

  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.md') && f !== 'insights.md' && !f.startsWith('.')
  );

  for (const file of files.slice(0, 10)) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    if (content.length > 0) {
      research += `## ${file}\n\n${content.slice(0, 5000)}\n\n`;
      log(`  Read ${file}`);
    }
  }

  if (!research) console.error('Warning: no research files found');
  return research;
}

function ensurePipelineDir() {
  const pipelineDir = path.join(opts.researchDir, 'pipeline');
  if (!fs.existsSync(pipelineDir)) {
    fs.mkdirSync(pipelineDir, { recursive: true });
  }
  return pipelineDir;
}

function saveIntermediate(filename, content) {
  const pipelineDir = ensurePipelineDir();
  const filePath = path.join(pipelineDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  log(`  Saved: ${filePath}`);
  return filePath;
}

// Async wrappers for parallel execution
function runClaudeAsync(prompt) {
  return new Promise((resolve, reject) => {
    const proc = execFile('claude', ['-p', prompt], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10,
      timeout: 300000,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Claude failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

function runGeminiAsync(prompt) {
  return new Promise((resolve, reject) => {
    execFile('gemini', ['-p', prompt, '-o', 'text'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10,
      timeout: 300000,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Gemini failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

function runCodexAsync(prompt) {
  return new Promise((resolve, reject) => {
    // Use GPT-5.2 (general purpose) not the codex model
    // Write prompt to temp file to avoid shell escaping issues
    const tmpPrompt = path.join(ensurePipelineDir(), '.codex-prompt.tmp');
    fs.writeFileSync(tmpPrompt, prompt, 'utf8');

    execFile('codex', ['exec', '-m', 'gpt-5.2', '-c', 'model_reasoning_effort="high"', '--full-auto', '-'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10,
      timeout: 300000,
      cwd: opts.researchDir,
    }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpPrompt); } catch {}
      if (err) return reject(new Error(`Codex/GPT-5.2 failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    }).stdin.end(prompt);
  });
}

// ============================================================================
// PROMPTS
// ============================================================================

const CONTENT_TYPE = {
  'cover-letter': {
    label: 'cover letter',
    structure: 'VALUE-FIRST structure: 40% strategic situation analysis, 40% 90-day plan, 20% why you',
    wordLimit: 350,
    tone: 'conversational, hypothesis-driven, specific rather than generic',
  },
  'outreach': {
    label: 'cold outreach email',
    structure: 'BLUF (bottom line up front) → specific insight about their company → concrete ask. 3 short paragraphs max.',
    wordLimit: 150,
    tone: 'casual-professional, direct, sounds like a peer reaching out not an applicant begging',
  },
};

function getContentConfig() {
  return CONTENT_TYPE[opts.type] || CONTENT_TYPE['cover-letter'];
}

function buildDraftPrompt(model) {
  const cfg = getContentConfig();

  const base = `You are writing a ${cfg.label} for Sam Zoloth, a senior product leader with 10+ years in product/growth.

IMPORTANT RULES:
- ${cfg.structure}
- Lead with value, NOT credentials
- Use hypothesis-driven language: "my guess is...", "I'd want to test...", "I suspect..."
- Keep it under ${cfg.wordLimit} words
- Be ${cfg.tone}
- No rule-of-three lists, no em dashes (max 2 total), no "demonstrating/highlighting/leveraging"
- No negative parallelisms ("not just X, but Y")
- Include portfolio link: "You can explore my work at samzoloth.com (password: barnaby for full access)."

COMPANY: ${opts.company}`;

  // Model-specific instructions to maximize diversity
  const modelHints = {
    claude: `\nYour strength: structured strategic thinking. Lead with the sharpest strategic insight you can find.`,
    gemini: `\nYour strength: creative framing. Find an unexpected angle — a contrarian take, a non-obvious connection, or a provocative opening that would make the hiring manager stop scrolling.`,
    codex: `\nYour strength: directness and clarity. Write the most concise, no-BS version possible. Cut any sentence that doesn't earn its place. Favor short sentences and concrete specifics over abstractions.`,
  };

  return base + (modelHints[model] || '');
}

// ============================================================================
// PIPELINE
// ============================================================================

async function main() {
  const startTime = Date.now();
  const cfg = getContentConfig();
  const artifacts = { errors: {} };

  console.error(`\n${cfg.label.toUpperCase()} Pipeline: ${opts.company}`);
  console.error('='.repeat(50));

  log('\nGathering research...');
  const research = gatherResearch();
  const jobPosting = opts.jobPosting ? fs.readFileSync(opts.jobPosting, 'utf8') : '';

  // ── Phase 1: Parallel drafts ──────────────────────────────────────────
  console.error('\nPhase 1: Generating drafts in parallel...');

  const drafters = [];

  // A: Claude
  if (opts.draft) {
    logStep('A', 'Claude [SKIPPED - using existing draft]');
    artifacts.claude = fs.readFileSync(opts.draft, 'utf8');
  } else {
    logStep('A', 'Claude - drafting...');
    const prompt = buildDraftPrompt('claude') + `\n\nJOB POSTING:\n${jobPosting}\n\nRESEARCH:\n${research}\n\nWrite the ${cfg.label} now. Output ONLY the text, no meta-commentary.`;
    drafters.push(
      runClaudeAsync(prompt)
        .then(r => { artifacts.claude = r; saveIntermediate('01-claude-draft.md', r); console.error('  [A] Claude done'); })
        .catch(e => { artifacts.errors.claude = e.message; console.error(`  [A] Claude failed: ${e.message}`); })
    );
  }

  // B: Gemini
  if (!opts.skipGemini) {
    logStep('B', 'Gemini - drafting...');
    const prompt = buildDraftPrompt('gemini') + `\n\nJOB POSTING:\n${jobPosting}\n\nRESEARCH:\n${research.slice(0, 6000)}\n\nWrite the ${cfg.label} now. Output ONLY the text, no meta-commentary.`;
    drafters.push(
      runGeminiAsync(prompt)
        .then(r => { artifacts.gemini = r; saveIntermediate('02-gemini-draft.md', r); console.error('  [B] Gemini done'); })
        .catch(e => { artifacts.errors.gemini = e.message; console.error(`  [B] Gemini failed: ${e.message}`); })
    );
  } else {
    logStep('B', 'Gemini [SKIPPED]');
  }

  // C: Codex/GPT-5.2
  if (!opts.skipCodex) {
    logStep('C', 'GPT-5.2 (via Codex) - drafting...');
    const prompt = buildDraftPrompt('codex') + `\n\nJOB POSTING:\n${jobPosting}\n\nRESEARCH:\n${research.slice(0, 6000)}\n\nWrite the ${cfg.label} now. Output ONLY the text, no meta-commentary. Do not create or modify any files — just output the text to stdout.`;
    drafters.push(
      runCodexAsync(prompt)
        .then(r => { artifacts.codex = r; saveIntermediate('03-codex-draft.md', r); console.error('  [C] GPT-5.2 done'); })
        .catch(e => { artifacts.errors.codex = e.message; console.error(`  [C] GPT-5.2 failed: ${e.message}`); })
    );
  } else {
    logStep('C', 'GPT-5.2 [SKIPPED]');
  }

  await Promise.all(drafters);

  const successfulDrafts = [];
  if (artifacts.claude) successfulDrafts.push({ model: 'Claude', text: artifacts.claude });
  if (artifacts.gemini) successfulDrafts.push({ model: 'Gemini', text: artifacts.gemini });
  if (artifacts.codex) successfulDrafts.push({ model: 'GPT-5.2', text: artifacts.codex });

  if (successfulDrafts.length === 0) {
    console.error('\nAll drafts failed. Cannot continue.');
    process.exit(1);
  }

  console.error(`\n${successfulDrafts.length} draft(s) generated.`);

  // ── Compare mode: show all drafts, no merge ───────────────────────────
  if (opts.compare) {
    const separator = '\n' + '─'.repeat(60) + '\n';
    let comparison = `# Draft Comparison: ${opts.company}\nGenerated: ${new Date().toISOString()}\nType: ${cfg.label}\n`;

    for (const draft of successfulDrafts) {
      comparison += `${separator}## ${draft.model} Draft\n\n${draft.text}\n`;
    }

    comparison += separator;
    saveIntermediate('comparison.md', comparison);
    fs.writeFileSync(opts.output, comparison, 'utf8');

    if (opts.json) {
      console.log(JSON.stringify({
        company: opts.company,
        type: opts.type,
        mode: 'compare',
        drafts: Object.fromEntries(successfulDrafts.map(d => [d.model, d.text])),
        errors: artifacts.errors,
      }, null, 2));
    } else {
      console.error(`\nComparison saved to: ${opts.output}`);
      console.error(`Intermediates: ${path.join(opts.researchDir, 'pipeline/')}`);
      console.log(comparison);
    }
    return;
  }

  // ── Phase 2: Claude merge ─────────────────────────────────────────────
  if (successfulDrafts.length === 1) {
    console.error('\nOnly 1 draft available — using it as final (no merge needed).');
    artifacts.final = successfulDrafts[0].text;
    artifacts.mergeNotes = `Single draft from ${successfulDrafts[0].model} (other models failed or skipped).`;
  } else {
    logStep('Merge', `Claude - merging ${successfulDrafts.length} drafts...`);

    const draftBlocks = successfulDrafts
      .map((d, i) => `DRAFT ${i + 1} (${d.model}):\n${d.text}`)
      .join('\n\n');

    const mergePrompt = `You are an expert editor merging ${successfulDrafts.length} ${cfg.label} drafts into one final version for Sam Zoloth.

Sam's authentic voice: conversational, hypothesis-driven, specific rather than generic, intellectually curious, direct without being aggressive. Sounds like someone you'd want to grab coffee with and talk product strategy.

${draftBlocks}

COMPANY RESEARCH:
${research.slice(0, 3000)}

${jobPosting ? `JOB POSTING:\n${jobPosting.slice(0, 2000)}` : ''}

YOUR TASK:

1. COMPARE: Read all drafts. Note which has the strongest opening, most specific insights, best structure, most natural voice.

2. MERGE: Cherry-pick the best elements:
   - STRONGEST opening hook (whichever draft nails it)
   - MOST SPECIFIC company/product insights
   - BEST ${opts.type === 'outreach' ? 'ask/CTA' : '90-day plan elements'}
   - Unify into Sam's authentic tone throughout
   ${opts.type === 'cover-letter' ? '- Maintain VALUE-FIRST: 40% strategic situation, 40% 90-day plan, 20% why you' : '- Keep BLUF structure, 3 short paragraphs max'}

3. FACT-CHECK (fix silently):
   - Company name, role title, product names correct
   - No hallucinated claims — remove anything not supported by research
   - Dates and statistics accurate

QUALITY GATES:
- Under ${cfg.wordLimit} words
- No rule-of-three, max 2 em dashes, no "demonstrating/highlighting/leveraging"
- No negative parallelisms
- WHOOP test: would you say this at a coffee shop?
- Include: "You can explore my work at samzoloth.com (password: barnaby for full access)."

Output format:
---FINAL---
[The merged ${cfg.label}]
---NOTES---
[Which elements you took from each draft, and why. Note any facts corrected.]`;

    try {
      const mergeResult = await runClaudeAsync(mergePrompt);

      let finalText = mergeResult;
      let notes = '';

      const finalMatch = mergeResult.match(/---FINAL---\s*([\s\S]*?)(?:---NOTES---|$)/);
      const notesMatch = mergeResult.match(/---NOTES---\s*([\s\S]*?)$/);

      if (finalMatch) finalText = finalMatch[1].trim();
      if (notesMatch) notes = notesMatch[1].trim();

      artifacts.final = finalText;
      artifacts.mergeNotes = notes;

      saveIntermediate('04-final-merged.md', finalText);
      if (notes) saveIntermediate('04-merge-notes.md', notes);
      console.error('  Merge complete');
    } catch (err) {
      console.error(`  Merge failed: ${err.message}`);
      console.error('  Falling back to Claude draft...');
      artifacts.final = artifacts.claude || successfulDrafts[0].text;
      artifacts.errors.merge = err.message;
    }
  }

  // ── Output ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  fs.writeFileSync(opts.output, artifacts.final, 'utf8');
  saveIntermediate('final-cover-letter.md', artifacts.final);

  // Report
  const stepsRun = [];
  stepsRun.push(artifacts.claude ? `A. Claude draft: ${artifacts.errors.claude ? 'FAILED' : 'OK'}` : 'A. Claude draft: SKIPPED');
  stepsRun.push(artifacts.gemini ? 'B. Gemini draft: OK' : `B. Gemini draft: ${artifacts.errors.gemini ? 'FAILED' : 'SKIPPED'}`);
  stepsRun.push(artifacts.codex ? 'C. GPT-5.2 draft: OK' : `C. GPT-5.2 draft: ${artifacts.errors.codex ? 'FAILED' : 'SKIPPED'}`);
  stepsRun.push(artifacts.errors.merge ? `Merge: FAILED (${artifacts.errors.merge})` : 'Merge: OK');

  const report = `# Pipeline Report: ${opts.company}
Generated: ${new Date().toISOString()}
Type: ${cfg.label}
Duration: ${elapsed}s
Drafts: ${successfulDrafts.length} of 3

## Steps
${stepsRun.join('\n')}

## Merge Notes
${artifacts.mergeNotes || 'Not available'}

## Output
${opts.output}
`;

  saveIntermediate('pipeline-report.md', report);

  if (opts.json) {
    console.log(JSON.stringify({
      company: opts.company,
      type: opts.type,
      timestamp: new Date().toISOString(),
      durationSeconds: parseFloat(elapsed),
      drafts: {
        claude: artifacts.claude || null,
        gemini: artifacts.gemini || null,
        codex: artifacts.codex || null,
      },
      mergeNotes: artifacts.mergeNotes || null,
      errors: artifacts.errors,
      finalOutput: artifacts.final,
      outputPath: opts.output,
    }, null, 2));
  } else {
    console.error(`\n${'='.repeat(50)}`);
    console.error(`Pipeline complete in ${elapsed}s (${successfulDrafts.length} drafts merged)`);
    console.error(`Output: ${opts.output}`);
    console.error(`Intermediates: ${path.join(opts.researchDir, 'pipeline/')}`);

    if (artifacts.mergeNotes) {
      console.error(`\nMerge notes:`);
      console.error(artifacts.mergeNotes);
    }

    console.log(artifacts.final);
  }
}

main().catch(err => {
  console.error(`Pipeline error: ${err.message}`);
  process.exit(1);
});
