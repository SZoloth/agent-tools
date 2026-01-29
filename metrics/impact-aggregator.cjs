#!/usr/bin/env node
/**
 * Impact Aggregator
 *
 * Weekly rollup of impact events to markdown and Roam.
 * Runs Fridays at 5pm via launchd, or manually.
 *
 * Usage:
 *   impact-aggregator.cjs              # Full aggregation + Roam sync
 *   impact-aggregator.cjs --dry-run    # Preview without changes
 *   impact-aggregator.cjs --no-roam    # Skip Roam sync
 *   impact-aggregator.cjs --no-archive # Keep events after aggregation
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EVENTS_DIR = path.join(process.env.HOME, '.claude', 'impact-events');
const ARCHIVE_DIR = path.join(EVENTS_DIR, 'archive');
const IMPACT_LOG = path.join(process.env.HOME, 'Documents', 'LLM CONTEXT', '1 - personal', 'weekly-impact-log.md');
const METRICS_STORE = path.join(__dirname, 'data', 'metrics-store.json');
const ROAM_PAGE = 'DWA Impact';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipRoam = args.includes('--no-roam');
const skipArchive = args.includes('--no-archive');

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil((((d - yearStart) / 86400000) + 1) / 7).toString().padStart(2, '0')}`;
}

function getWeekDateRange(weekStr) {
  // Parse 2026-W05 format
  const [year, weekPart] = weekStr.split('-W');
  const weekNum = parseInt(weekPart);

  // Calculate Monday of that week
  const jan4 = new Date(Date.UTC(parseInt(year), 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);

  const monday = new Date(firstMonday);
  monday.setUTCDate(firstMonday.getUTCDate() + (weekNum - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const formatDate = (d) => d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  return `${formatDate(monday)} - ${formatDate(sunday)}`;
}

function loadEvents() {
  if (!fs.existsSync(EVENTS_DIR)) {
    return [];
  }

  const events = [];
  const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.event.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(EVENTS_DIR, file), 'utf8');
      const event = JSON.parse(content);
      event._filename = file;
      events.push(event);
    } catch (err) {
      console.error(`Error reading ${file}: ${err.message}`);
    }
  }

  return events;
}

function groupByWeek(events) {
  const byWeek = {};
  for (const event of events) {
    const week = event.week || getWeekNumber(new Date(event.timestamp));
    byWeek[week] = byWeek[week] || [];
    byWeek[week].push(event);
  }
  return byWeek;
}

function formatMarkdownSection(events, week) {
  const dateRange = getWeekDateRange(week);
  const byType = {};

  for (const event of events) {
    byType[event.type] = byType[event.type] || [];
    byType[event.type].push(event);
  }

  const typeOrder = ['decision', 'quote', 'coaching', 'metric', 'artifact', 'quick'];
  const typeLabels = {
    decision: 'Decisions Influenced',
    quote: 'Stakeholder Quotes',
    coaching: 'Coaching Milestones',
    metric: 'Metrics & Improvements',
    artifact: 'Artifacts Delivered',
    quick: 'Other Impact'
  };

  let markdown = `\n## Week ${week} (${dateRange})\n\n`;
  markdown += `**Total impact moments captured: ${events.length}**\n\n`;

  for (const type of typeOrder) {
    const typeEvents = byType[type];
    if (!typeEvents || typeEvents.length === 0) continue;

    markdown += `### ${typeLabels[type]}\n\n`;

    for (const event of typeEvents) {
      const data = event.data;
      markdown += `- **${data.summary}**\n`;

      // Add structured details based on type
      if (type === 'decision') {
        if (data.before && data.after) {
          markdown += `  - Before: ${data.before}\n`;
          markdown += `  - After: ${data.after}\n`;
        }
        if (data.basis) {
          markdown += `  - Basis: ${data.basis}\n`;
        }
      } else if (type === 'quote') {
        markdown += `  - ${data.person}`;
        if (data.context) markdown += ` (${data.context})`;
        markdown += `\n`;
      } else if (type === 'coaching') {
        if (data.skill) markdown += `  - Skill: ${data.skill}\n`;
        if (data.evidence) markdown += `  - Evidence: ${data.evidence}\n`;
      } else if (type === 'metric') {
        if (data.baseline && data.result) {
          markdown += `  - ${data.baseline} -> ${data.result}\n`;
        }
      } else if (type === 'artifact') {
        markdown += `  - Type: ${data.type || 'deliverable'}`;
        if (data.for) markdown += `, For: ${data.for}`;
        markdown += `\n`;
      }
    }
    markdown += '\n';
  }

  // Summary stats
  markdown += `---\n*Captured: ${events.length} impact moments | Aggregated: ${new Date().toISOString().split('T')[0]}*\n`;

  return markdown;
}

function formatRoamOutline(events, week) {
  const dateRange = getWeekDateRange(week);
  const outline = [];
  const byType = {};

  for (const event of events) {
    byType[event.type] = byType[event.type] || [];
    byType[event.type].push(event);
  }

  // Week header
  outline.push({
    text: `**Week ${week}** (${dateRange}) - ${events.length} impact moments`,
    level: 1,
    heading: 2
  });

  const typeOrder = ['decision', 'quote', 'coaching', 'metric', 'artifact', 'quick'];
  const typeLabels = {
    decision: 'Decisions',
    quote: 'Quotes',
    coaching: 'Coaching',
    metric: 'Metrics',
    artifact: 'Artifacts',
    quick: 'Quick Captures'
  };

  for (const type of typeOrder) {
    const typeEvents = byType[type];
    if (!typeEvents || typeEvents.length === 0) continue;

    outline.push({
      text: `**${typeLabels[type]}** (${typeEvents.length})`,
      level: 2
    });

    for (const event of typeEvents) {
      const data = event.data;
      let text = data.summary;

      // Add context inline for Roam
      if (type === 'quote' && data.person) {
        text = `"${data.summary}" - ${data.person}`;
      } else if (type === 'decision' && data.before && data.after) {
        text = `${data.summary} (${data.before} -> ${data.after})`;
      }

      outline.push({ text, level: 3 });
    }
  }

  return outline;
}

async function syncToRoam(outline) {
  if (skipRoam || dryRun) {
    console.log('\n[Roam sync skipped]\n');
    return false;
  }

  try {
    // Use Claude to call the MCP tool via a subprocess
    // This is a workaround since we can't call MCP directly from Node
    const outlineJson = JSON.stringify(outline);
    const claudeScript = `
Tell me you've synced to Roam by calling mcp__roam-research__roam_create_outline with:
- page_title_uid: "${ROAM_PAGE}"
- outline: ${outlineJson}
`;
    console.log('\n[Roam sync requires Claude MCP - run manually or via launchd with claude -p]\n');
    console.log('To sync manually, run this in Claude Code:');
    console.log(`  mcp__roam-research__roam_create_outline with page "${ROAM_PAGE}"`);

    // Write outline to temp file for easy copy
    const tempFile = path.join(EVENTS_DIR, 'roam-outline-pending.json');
    fs.writeFileSync(tempFile, JSON.stringify({ page: ROAM_PAGE, outline }, null, 2));
    console.log(`  Outline saved to: ${tempFile}`);

    return true;
  } catch (err) {
    console.error(`Roam sync error: ${err.message}`);
    return false;
  }
}

function updateMetricsStore(events) {
  if (dryRun) return;

  let store = {};
  if (fs.existsSync(METRICS_STORE)) {
    try {
      store = JSON.parse(fs.readFileSync(METRICS_STORE, 'utf8'));
    } catch {}
  }

  const byType = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
  }

  store.impact = store.impact || { total: 0, byType: {} };
  store.impact.total += events.length;
  store.impact.lastAggregated = new Date().toISOString();
  store.impact.lastWeekCount = events.length;

  for (const [type, count] of Object.entries(byType)) {
    store.impact.byType[type] = (store.impact.byType[type] || 0) + count;
  }

  store.last_updated = new Date().toISOString();

  fs.writeFileSync(METRICS_STORE, JSON.stringify(store, null, 2));
}

function archiveEvents(events) {
  if (dryRun || skipArchive) {
    console.log('\n[Archive skipped]\n');
    return;
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const weekDir = path.join(ARCHIVE_DIR, getWeekNumber(new Date()));
  if (!fs.existsSync(weekDir)) {
    fs.mkdirSync(weekDir, { recursive: true });
  }

  for (const event of events) {
    const src = path.join(EVENTS_DIR, event._filename);
    const dest = path.join(weekDir, event._filename);
    if (fs.existsSync(src)) {
      fs.renameSync(src, dest);
    }
  }

  console.log(`Archived ${events.length} events to ${weekDir}`);
}

function appendToMarkdownLog(content) {
  if (dryRun) {
    console.log('\n[DRY RUN - would append to weekly-impact-log.md]');
    console.log(content);
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(IMPACT_LOG);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create or append to log
  let existing = '';
  if (fs.existsSync(IMPACT_LOG)) {
    existing = fs.readFileSync(IMPACT_LOG, 'utf8');
  } else {
    existing = `# Weekly Impact Log

Automated capture of impact moments, aggregated weekly.

---
`;
  }

  fs.writeFileSync(IMPACT_LOG, existing + content);
  console.log(`Appended to: ${IMPACT_LOG}`);
}

// Main
async function main() {
  console.log('\nImpact Aggregator');
  console.log('═'.repeat(50));

  if (dryRun) {
    console.log('[DRY RUN MODE - no changes will be made]\n');
  }

  const events = loadEvents();

  if (events.length === 0) {
    console.log('\nNo impact events to aggregate.');
    console.log('Capture impacts with: impact quick "Your impact here"\n');
    return;
  }

  console.log(`\nFound ${events.length} events to process\n`);

  // Group by week
  const byWeek = groupByWeek(events);
  const weeks = Object.keys(byWeek).sort();

  for (const week of weeks) {
    const weekEvents = byWeek[week];
    console.log(`\nProcessing week ${week} (${weekEvents.length} events)...`);

    // Generate markdown
    const markdown = formatMarkdownSection(weekEvents, week);
    appendToMarkdownLog(markdown);

    // Generate Roam outline
    const outline = formatRoamOutline(weekEvents, week);
    await syncToRoam(outline);

    // Archive events
    archiveEvents(weekEvents);
  }

  // Update metrics store
  updateMetricsStore(events);

  console.log('\n═'.repeat(50));
  console.log('Aggregation complete!\n');

  // Show resume bullet bank preview
  console.log('Resume bullet bank preview:');
  const decisions = events.filter(e => e.type === 'decision');
  const metrics = events.filter(e => e.type === 'metric');

  if (decisions.length > 0) {
    console.log('\n  Decisions:');
    for (const d of decisions.slice(0, 3)) {
      console.log(`    - ${d.data.summary}`);
    }
  }

  if (metrics.length > 0) {
    console.log('\n  Metrics:');
    for (const m of metrics.slice(0, 3)) {
      console.log(`    - ${m.data.summary}`);
    }
  }

  console.log('');
}

main().catch(console.error);
