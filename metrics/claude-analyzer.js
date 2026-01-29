#!/usr/bin/env node
/**
 * Claude Code Usage Analyzer
 *
 * Analyzes diary entries for quantitative and qualitative insights about
 * how you use Claude Code.
 *
 * Usage:
 *   claude-analyzer.js              # Analyze last 30 days
 *   claude-analyzer.js --days 7     # Analyze last 7 days
 *   claude-analyzer.js --export     # Export to metrics store
 *   claude-analyzer.js --verbose    # Show detailed breakdown
 */

const fs = require('fs');
const path = require('path');

const DIARY_DIR = path.join(process.env.HOME, '.claude/memory/diary');
const METRICS_STORE = path.join(__dirname, 'data/metrics-store.json');

// Parse command line args
const args = process.argv.slice(2);
const days = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 30;
const exportData = args.includes('--export');
const verbose = args.includes('--verbose');

// Task type patterns to detect
const TASK_PATTERNS = {
  'coding': /code|script|function|bug|fix|implement|refactor|test/i,
  'writing': /cover letter|email|draft|write|document|content/i,
  'research': /research|search|find|explore|investigate|understand/i,
  'planning': /plan|design|architect|strategy|todo|task/i,
  'automation': /automate|script|hook|cron|launchd|schedule/i,
  'debugging': /debug|error|issue|problem|troubleshoot/i,
  'data_analysis': /data|analyze|metric|dashboard|report/i,
  'job_search': /job|application|outreach|interview|cover letter|resume/i,
  'personal': /personal|health|finance|relationship/i
};

// Quality indicators
const QUALITY_INDICATORS = {
  'strategic_thinking': /insight|decision|tradeoff|approach|strategy/gi,
  'user_preferences': /User Preferences Observed|preference/gi,
  'challenges_solved': /Challenges Encountered|challenge|problem solved/gi,
  'files_modified': /Files Modified/gi,
  'learnings': /learned|observed|pattern|note/gi
};

function getRecentDiaries(daysBack) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const files = fs.readdirSync(DIARY_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const match = f.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!match) return null;
      const date = new Date(match[1]);
      return { file: f, date };
    })
    .filter(f => f && f.date >= cutoff)
    .sort((a, b) => b.date - a.date);

  return files;
}

function parseDiaryEntry(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');

  // Extract structured data
  const entry = {
    date: null,
    time: null,
    project: null,
    taskSummary: '',
    workSummary: '',
    filesModified: [],
    technologies: [],
    taskTypes: [],
    qualityScore: 0,
    rawContent: content
  };

  // Parse date/time
  const dateMatch = content.match(/\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) entry.date = dateMatch[1];

  const timeMatch = content.match(/\*\*Time\*\*:\s*([^\n]+)/);
  if (timeMatch) entry.time = timeMatch[1];

  const projectMatch = content.match(/\*\*Project\*\*:\s*([^\n]+)/);
  if (projectMatch) entry.project = projectMatch[1];

  // Extract task summary
  const taskMatch = content.match(/## Task Summary\n([\s\S]*?)(?=\n## |$)/);
  if (taskMatch) entry.taskSummary = taskMatch[1].trim();

  // Extract work summary
  const workMatch = content.match(/## Work Summary\n([\s\S]*?)(?=\n## |$)/);
  if (workMatch) entry.workSummary = workMatch[1].trim();

  // Extract files modified
  const filesMatch = content.match(/## Files Modified\n([\s\S]*?)(?=\n## |$)/);
  if (filesMatch) {
    entry.filesModified = filesMatch[1]
      .split('\n')
      .filter(l => l.startsWith('-'))
      .map(l => l.replace(/^-\s*`?([^`]+)`?.*/, '$1').trim());
  }

  // Detect task types
  for (const [type, pattern] of Object.entries(TASK_PATTERNS)) {
    if (pattern.test(content)) {
      entry.taskTypes.push(type);
    }
  }

  // Calculate quality score based on depth of entry
  for (const [indicator, pattern] of Object.entries(QUALITY_INDICATORS)) {
    const matches = content.match(pattern);
    if (matches) {
      entry.qualityScore += matches.length;
    }
  }

  // Extract technologies
  const techMatch = content.match(/## Context and Technologies\n([\s\S]*?)(?=\n## |$)/);
  if (techMatch) {
    entry.technologies = techMatch[1]
      .split('\n')
      .filter(l => l.startsWith('-'))
      .map(l => l.replace(/^-\s*/, '').trim());
  }

  return entry;
}

function analyzeUsage(entries) {
  const analysis = {
    totalSessions: entries.length,
    dateRange: {
      start: entries[entries.length - 1]?.date || 'N/A',
      end: entries[0]?.date || 'N/A'
    },
    sessionsByDate: {},
    taskTypeBreakdown: {},
    projectBreakdown: {},
    filesModifiedCount: 0,
    uniqueFilesModified: new Set(),
    technologiesUsed: {},
    avgQualityScore: 0,
    highValueSessions: [],
    topPatterns: []
  };

  let totalQuality = 0;

  for (const entry of entries) {
    // Sessions by date
    if (entry.date) {
      analysis.sessionsByDate[entry.date] = (analysis.sessionsByDate[entry.date] || 0) + 1;
    }

    // Task types
    for (const type of entry.taskTypes) {
      analysis.taskTypeBreakdown[type] = (analysis.taskTypeBreakdown[type] || 0) + 1;
    }

    // Projects
    if (entry.project) {
      const projectName = entry.project.split('/').pop() || entry.project;
      analysis.projectBreakdown[projectName] = (analysis.projectBreakdown[projectName] || 0) + 1;
    }

    // Files
    analysis.filesModifiedCount += entry.filesModified.length;
    entry.filesModified.forEach(f => analysis.uniqueFilesModified.add(f));

    // Technologies
    for (const tech of entry.technologies) {
      analysis.technologiesUsed[tech] = (analysis.technologiesUsed[tech] || 0) + 1;
    }

    // Quality
    totalQuality += entry.qualityScore;

    // High value sessions (quality score > 10)
    if (entry.qualityScore > 10) {
      analysis.highValueSessions.push({
        date: entry.date,
        project: entry.project,
        summary: entry.taskSummary.substring(0, 100) + '...',
        score: entry.qualityScore
      });
    }
  }

  analysis.avgQualityScore = entries.length > 0
    ? (totalQuality / entries.length).toFixed(1)
    : 0;
  analysis.uniqueFilesModified = analysis.uniqueFilesModified.size;

  // Sort task types
  analysis.taskTypeBreakdown = Object.fromEntries(
    Object.entries(analysis.taskTypeBreakdown)
      .sort((a, b) => b[1] - a[1])
  );

  return analysis;
}

function formatReport(analysis, verbose) {
  let report = `
# Claude Code Usage Analysis
**Period**: ${analysis.dateRange.start} to ${analysis.dateRange.end}
**Total Sessions**: ${analysis.totalSessions}

## Quantitative Metrics

### Session Volume
- Sessions analyzed: ${analysis.totalSessions}
- Unique days with sessions: ${Object.keys(analysis.sessionsByDate).length}
- Avg sessions/day: ${(analysis.totalSessions / Object.keys(analysis.sessionsByDate).length).toFixed(1)}

### Files & Output
- Total files modified: ${analysis.filesModifiedCount}
- Unique files: ${analysis.uniqueFilesModified}

### Quality Score
- Average session quality: ${analysis.avgQualityScore}/15
- High-value sessions (score >10): ${analysis.highValueSessions.length}

## Qualitative Analysis

### What You Use Claude For (by frequency)
`;

  const taskTypes = Object.entries(analysis.taskTypeBreakdown);
  const totalTasks = taskTypes.reduce((sum, [, count]) => sum + count, 0);

  for (const [type, count] of taskTypes.slice(0, 8)) {
    const pct = ((count / totalTasks) * 100).toFixed(0);
    const bar = '█'.repeat(Math.ceil(pct / 5));
    report += `${type.padEnd(15)} ${bar} ${count} (${pct}%)\n`;
  }

  report += `
### Projects Breakdown
`;

  const projects = Object.entries(analysis.projectBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [project, count] of projects) {
    report += `- ${project}: ${count} sessions\n`;
  }

  if (verbose && analysis.highValueSessions.length > 0) {
    report += `
### High-Value Sessions
`;
    for (const session of analysis.highValueSessions.slice(0, 5)) {
      report += `- ${session.date} (${session.project}): ${session.summary}\n`;
    }
  }

  report += `
## Insights

`;

  // Generate insights
  const topTaskType = taskTypes[0]?.[0];
  const secondTaskType = taskTypes[1]?.[0];

  if (topTaskType === 'job_search' || topTaskType === 'writing') {
    report += `- **Heavy job search/writing focus**: ${taskTypes[0][1]} sessions. Good if actively searching, concerning if avoiding shipping.\n`;
  }

  if (topTaskType === 'planning' && (!taskTypes.find(t => t[0] === 'coding') || taskTypes.find(t => t[0] === 'coding')?.[1] < taskTypes[0][1] * 0.3)) {
    report += `- **Planning > Shipping pattern detected**: More planning sessions than coding. Watch for avoidance.\n`;
  }

  const sessionsPerDay = analysis.totalSessions / Object.keys(analysis.sessionsByDate).length;
  if (sessionsPerDay > 8) {
    report += `- **High session volume** (${sessionsPerDay.toFixed(1)}/day): Could indicate productive collaboration or context thrashing.\n`;
  }

  if (analysis.avgQualityScore < 5) {
    report += `- **Low depth sessions**: Most sessions are quick queries, not deep work. Consider batching.\n`;
  } else if (analysis.avgQualityScore > 10) {
    report += `- **High depth sessions**: Good signal of substantive work with Claude.\n`;
  }

  return report;
}

// Main execution
function main() {
  console.log(`Analyzing Claude Code usage for last ${days} days...`);

  const diaryFiles = getRecentDiaries(days);
  console.log(`Found ${diaryFiles.length} diary entries\n`);

  if (diaryFiles.length === 0) {
    console.log('No diary entries found for the specified period.');
    return;
  }

  const entries = diaryFiles.map(f =>
    parseDiaryEntry(path.join(DIARY_DIR, f.file))
  );

  const analysis = analyzeUsage(entries);
  const report = formatReport(analysis, verbose);

  console.log(report);

  if (exportData) {
    // Update metrics store
    const store = JSON.parse(fs.readFileSync(METRICS_STORE, 'utf8'));
    store.claude_usage = {
      last_analyzed: new Date().toISOString(),
      sessions_by_date: analysis.sessionsByDate,
      task_types: analysis.taskTypeBreakdown,
      total_sessions: analysis.totalSessions,
      avg_quality_score: parseFloat(analysis.avgQualityScore),
      files_modified_count: analysis.filesModifiedCount
    };
    store.last_updated = new Date().toISOString();
    fs.writeFileSync(METRICS_STORE, JSON.stringify(store, null, 2));
    console.log('\nExported to metrics store.');
  }
}

main();
