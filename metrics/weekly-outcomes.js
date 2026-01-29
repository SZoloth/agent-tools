#!/usr/bin/env node
/**
 * Weekly Outcomes Analyzer
 *
 * Analyzes Things 3 completed tasks to measure outcomes vs busywork.
 * Uses tags: Shipped, Needle-mover, Admin, P1, P2, P3
 *
 * Usage:
 *   weekly-outcomes.js              # This week's summary
 *   weekly-outcomes.js --weeks 4    # Last 4 weeks
 *   weekly-outcomes.js --export     # Export to metrics store
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const METRICS_STORE = path.join(__dirname, 'data/metrics-store.json');

const args = process.argv.slice(2);
const weeks = args.includes('--weeks') ? parseInt(args[args.indexOf('--weeks') + 1]) : 1;
const exportData = args.includes('--export');

// Task categorization rules (inferred from task titles when tags missing)
const CATEGORY_PATTERNS = {
  shipped: /deploy|ship|release|publish|submit|launch|complete|finish|deliver/i,
  needle_mover: /outreach|apply|interview|ship|deliver|strategic|decision/i,
  admin: /hours|pay|money|transfer|clean|review|organize|update|check/i,
  health: /gym|lift|run|walk|workout|exercise|sleep/i,
  personal: /dishes|shave|laundry|groceries|chores/i,
  work: /dwa|client|meeting|prep|sync|call|email/i,
  job_search: /outreach|apply|application|interview|resume|cover letter|networking/i
};

function getThingsLogbook(periodWeeks) {
  try {
    const daysBack = periodWeeks * 7;
    const script = `
tell application "Things3"
  set cutoffDate to (current date) - ${daysBack} * days
  set logbookItems to to dos of list "Logbook" whose completion date > cutoffDate
  set output to ""
  repeat with t in logbookItems
    set taskName to name of t
    set compDate to completion date of t
    set taskTags to ""
    try
      set tagList to tags of t
      repeat with tg in tagList
        set taskTags to taskTags & (name of tg) & ","
      end repeat
    end try
    set taskNotes to ""
    try
      set taskNotes to notes of t
    end try
    set output to output & taskName & "|" & (compDate as string) & "|" & taskTags & "|" & taskNotes & "
"
  end repeat
  return output
end tell
`;

    const result = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });

    return result.trim().split('\n').filter(l => l).map(line => {
      const parts = line.split('|');
      const [name, dateStr, tags, notes] = parts;
      return {
        name: name || '',
        date: dateStr || '',
        tags: tags?.split(',').filter(t => t) || [],
        notes: notes || ''
      };
    });
  } catch (error) {
    console.error('Error querying Things 3:', error.message);
    return [];
  }
}

function categorizeTask(task) {
  const categories = [];

  // Check explicit tags first
  const tagLower = task.tags.map(t => t.toLowerCase());
  if (tagLower.includes('shipped')) categories.push('shipped');
  if (tagLower.includes('needle-mover')) categories.push('needle_mover');
  if (tagLower.includes('admin')) categories.push('admin');
  if (tagLower.includes('p1')) categories.push('priority_high');
  if (tagLower.includes('p2')) categories.push('priority_med');
  if (tagLower.includes('p3')) categories.push('priority_low');

  // Infer from title if no explicit tags
  if (categories.length === 0) {
    const titleLower = task.name.toLowerCase();
    for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
      if (pattern.test(titleLower)) {
        categories.push(category);
      }
    }
  }

  // Default to 'uncategorized' if nothing matched
  if (categories.length === 0) {
    categories.push('uncategorized');
  }

  return categories;
}

function analyzeOutcomes(tasks) {
  const analysis = {
    total: tasks.length,
    byCategory: {},
    byDate: {},
    shippedItems: [],
    needleMovers: [],
    outcomeRatio: 0,
    adminRatio: 0
  };

  for (const task of tasks) {
    const categories = categorizeTask(task);

    for (const cat of categories) {
      analysis.byCategory[cat] = (analysis.byCategory[cat] || 0) + 1;
    }

    // Extract date
    const dateMatch = task.date?.match(/(\w+ \d+, \d+)/);
    if (dateMatch) {
      const dateKey = dateMatch[1];
      analysis.byDate[dateKey] = (analysis.byDate[dateKey] || 0) + 1;
    }

    // Track specific high-value items
    if (categories.includes('shipped')) {
      analysis.shippedItems.push(task.name);
    }
    if (categories.includes('needle_mover') || categories.includes('job_search')) {
      analysis.needleMovers.push(task.name);
    }
  }

  // Calculate ratios
  const shipped = analysis.byCategory.shipped || 0;
  const needleMover = analysis.byCategory.needle_mover || 0;
  const jobSearch = analysis.byCategory.job_search || 0;
  const admin = analysis.byCategory.admin || 0;
  const personal = analysis.byCategory.personal || 0;

  analysis.outcomeRatio = tasks.length > 0
    ? ((shipped + needleMover + jobSearch) / tasks.length * 100).toFixed(0)
    : 0;

  analysis.adminRatio = tasks.length > 0
    ? ((admin + personal) / tasks.length * 100).toFixed(0)
    : 0;

  return analysis;
}

function formatReport(analysis, weeksCount) {
  let report = `
# Weekly Outcomes Report
**Period**: Last ${weeksCount} week(s)
**Total Tasks Completed**: ${analysis.total}

## Outcome vs Busywork

Outcome work (shipped/needle-mover/job-search): ${analysis.outcomeRatio}%
Maintenance work (admin/personal):              ${analysis.adminRatio}%

**Target**: 60%+ outcome work, <40% maintenance

## Category Breakdown
`;

  const sortedCategories = Object.entries(analysis.byCategory)
    .sort((a, b) => b[1] - a[1]);

  for (const [category, count] of sortedCategories) {
    const pct = ((count / analysis.total) * 100).toFixed(0);
    const bar = '#'.repeat(Math.ceil(pct / 5));
    const icon = {
      shipped: '[SHIP]',
      needle_mover: '[GOAL]',
      job_search: '[JOB]',
      work: '[WORK]',
      health: '[FIT]',
      admin: '[ADM]',
      personal: '[HOME]',
      uncategorized: '[?]'
    }[category] || '[?]';

    report += `${icon} ${category.padEnd(16)} ${bar.padEnd(20)} ${count} (${pct}%)\n`;
  }

  if (analysis.shippedItems.length > 0) {
    report += `\n## Shipped Items\n`;
    for (const item of analysis.shippedItems.slice(0, 10)) {
      report += `- ${item}\n`;
    }
  }

  if (analysis.needleMovers.length > 0) {
    report += `\n## Needle Movers\n`;
    for (const item of analysis.needleMovers.slice(0, 10)) {
      report += `- ${item}\n`;
    }
  }

  report += `\n## Insights\n`;

  if (parseInt(analysis.outcomeRatio) < 30) {
    report += `- WARNING: Low outcome ratio (${analysis.outcomeRatio}%): Heavy on maintenance, light on shipping.\n`;
  } else if (parseInt(analysis.outcomeRatio) >= 60) {
    report += `- GOOD: Strong outcome ratio (${analysis.outcomeRatio}%): Good balance of shipping work.\n`;
  }

  if ((analysis.byCategory.job_search || 0) === 0 && weeksCount >= 1) {
    report += `- WARNING: No job search activity tagged this period. If actively searching, track outreach.\n`;
  }

  if ((analysis.byCategory.shipped || 0) === 0) {
    report += `- WARNING: Nothing explicitly shipped. Consider tagging completed deliverables with 'Shipped'.\n`;
  }

  return report;
}

function main() {
  console.log(`Analyzing Things 3 outcomes for last ${weeks} week(s)...\n`);

  const tasks = getThingsLogbook(weeks);
  console.log(`Found ${tasks.length} completed tasks\n`);

  if (tasks.length === 0) {
    console.log('No tasks found. Make sure Things 3 is running.');
    return;
  }

  const analysis = analyzeOutcomes(tasks);
  const report = formatReport(analysis, weeks);

  console.log(report);

  if (exportData) {
    const store = JSON.parse(fs.readFileSync(METRICS_STORE, 'utf8'));
    store.things = {
      last_analyzed: new Date().toISOString(),
      period_weeks: weeks,
      total_completed: analysis.total,
      category_breakdown: analysis.byCategory,
      outcome_ratio: parseFloat(analysis.outcomeRatio),
      admin_ratio: parseFloat(analysis.adminRatio)
    };
    store.last_updated = new Date().toISOString();
    fs.writeFileSync(METRICS_STORE, JSON.stringify(store, null, 2));
    console.log('\nExported to metrics store.');
  }
}

main();
