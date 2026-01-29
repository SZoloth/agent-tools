#!/usr/bin/env node
/**
 * Impact Dashboard
 *
 * Combines all metrics into a single dashboard view.
 * Pull data from: Things, Strava, Claude sessions, Outreach, Deliverables
 *
 * Usage:
 *   impact-dashboard.js           # Full dashboard
 *   impact-dashboard.js --quick   # Just the key numbers
 *   impact-dashboard.js --export  # Export snapshot to file
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const METRICS_DIR = __dirname;
const METRICS_STORE = path.join(METRICS_DIR, 'data/metrics-store.json');
const OUTREACH_LOG = path.join(METRICS_DIR, 'data/outreach-log.json');
const DELIVERABLES_FILE = path.join(METRICS_DIR, 'data/deliverables.json');
const DIARY_DIR = path.join(process.env.HOME, '.claude/memory/diary');
const SNAPSHOT_DIR = path.join(process.env.HOME, 'Documents/LLM CONTEXT/1 - personal/metrics-snapshots');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const exportSnapshot = args.includes('--export');

function loadJson(filepath, defaultValue = {}) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  return new Date(now.setDate(diff)).toISOString().split('T')[0];
}

function getThingsData() {
  try {
    const script = `
tell application "Things3"
  set cutoffDate to (current date) - 7 * days
  set logbookItems to to dos of list "Logbook" whose completion date > cutoffDate
  return (count of logbookItems) as string
end tell
`;
    const count = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
    return { completedThisWeek: parseInt(count) || 0 };
  } catch {
    return { completedThisWeek: 0 };
  }
}

function getClaudeData() {
  try {
    const files = fs.readdirSync(DIARY_DIR).filter(f => f.endsWith('.md'));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const recentFiles = files.filter(f => {
      const match = f.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!match) return false;
      return new Date(match[1]) >= cutoff;
    });

    return {
      sessionsThisWeek: recentFiles.length,
      totalSessions: files.length
    };
  } catch {
    return { sessionsThisWeek: 0, totalSessions: 0 };
  }
}

function getOutreachData() {
  const log = loadJson(OUTREACH_LOG, { outreaches: [], responses: [], interviews: [] });
  const weekStart = getWeekStart();

  const thisWeek = log.outreaches.filter(o => o.weekStart === weekStart);
  const pending = log.outreaches.filter(o => o.status === 'sent');
  const total = log.outreaches.length;
  const responses = log.responses.length;

  return {
    thisWeek: thisWeek.length,
    target: 10,
    pending: pending.length,
    total,
    responses,
    interviews: log.interviews.length,
    responseRate: total > 0 ? ((responses / total) * 100).toFixed(0) : 0
  };
}

function getDeliverablesData() {
  const data = loadJson(DELIVERABLES_FILE, { deliverables: [] });
  const thisMonth = new Date().toISOString().slice(0, 7);

  const monthDeliverables = data.deliverables.filter(d => d.date?.startsWith(thisMonth));

  return {
    thisMonth: monthDeliverables.length,
    total: data.deliverables.length
  };
}

function getStravaData() {
  // This would need MCP or API call - return placeholder
  return {
    activitiesThisWeek: '?',
    note: 'Run `impact-dashboard.js --with-strava` with MCP active'
  };
}

function calculateHealthScore(data) {
  let score = 0;
  let maxScore = 0;

  // Outreach: 30 points max (3 points per outreach, target 10)
  maxScore += 30;
  score += Math.min(30, data.outreach.thisWeek * 3);

  // Tasks completed: 20 points max (1 point per task, cap at 20)
  maxScore += 20;
  score += Math.min(20, data.things.completedThisWeek);

  // Claude sessions: 10 points max (productive usage indicator)
  maxScore += 10;
  score += Math.min(10, data.claude.sessionsThisWeek);

  // Deliverables: 20 points max (5 points per deliverable this month)
  maxScore += 20;
  score += Math.min(20, data.deliverables.thisMonth * 5);

  // Interview pipeline: 20 points max
  maxScore += 20;
  score += Math.min(20, data.outreach.interviews * 10 + data.outreach.pending * 2);

  return {
    score,
    maxScore,
    percentage: ((score / maxScore) * 100).toFixed(0)
  };
}

function formatQuickDashboard(data) {
  const health = calculateHealthScore(data);

  return `
IMPACT DASHBOARD | Week of ${getWeekStart()}
${'='.repeat(50)}

HEALTH SCORE: ${health.score}/${health.maxScore} (${health.percentage}%)

KEY METRICS
  Outreach:     ${data.outreach.thisWeek}/10 this week
  Tasks:        ${data.things.completedThisWeek} completed
  Deliverables: ${data.deliverables.thisMonth} this month
  Pipeline:     ${data.outreach.pending} pending, ${data.outreach.interviews} interviews

${'='.repeat(50)}
`;
}

function formatFullDashboard(data) {
  const health = calculateHealthScore(data);

  let dashboard = `
================================================================================
                         IMPACT DASHBOARD
                      Week of ${getWeekStart()}
================================================================================

OVERALL HEALTH SCORE: ${health.score}/${health.maxScore} (${health.percentage}%)
${'#'.repeat(Math.ceil(parseInt(health.percentage) / 5))}${'_'.repeat(20 - Math.ceil(parseInt(health.percentage) / 5))}

--------------------------------------------------------------------------------
                           JOB SEARCH
--------------------------------------------------------------------------------

OUTREACH THIS WEEK: ${data.outreach.thisWeek}/10
Progress: ${'#'.repeat(data.outreach.thisWeek)}${'_'.repeat(Math.max(0, 10 - data.outreach.thisWeek))}
${data.outreach.thisWeek >= 10 ? 'TARGET HIT!' : `${10 - data.outreach.thisWeek} more to hit target`}

PIPELINE STATUS
  Awaiting response: ${data.outreach.pending}
  Total interviews:  ${data.outreach.interviews}

FUNNEL METRICS
  Total sent:    ${data.outreach.total}
  Responses:     ${data.outreach.responses}
  Response rate: ${data.outreach.responseRate}%

--------------------------------------------------------------------------------
                           PRODUCTIVITY
--------------------------------------------------------------------------------

TASKS COMPLETED (7 days): ${data.things.completedThisWeek}

CLAUDE CODE USAGE
  Sessions this week: ${data.claude.sessionsThisWeek}
  Total sessions:     ${data.claude.totalSessions}

--------------------------------------------------------------------------------
                           IMPACT EVIDENCE
--------------------------------------------------------------------------------

DELIVERABLES
  This month: ${data.deliverables.thisMonth}
  All time:   ${data.deliverables.total}

--------------------------------------------------------------------------------
                           RECOMMENDATIONS
--------------------------------------------------------------------------------
`;

  // Add recommendations based on data
  if (data.outreach.thisWeek < 5) {
    dashboard += `- PRIORITY: Outreach is ${data.outreach.thisWeek}/10. Send ${10 - data.outreach.thisWeek} more this week.\n`;
  }

  if (data.deliverables.thisMonth === 0) {
    dashboard += `- Consider logging recent work deliverables for portfolio evidence.\n`;
  }

  if (data.outreach.pending > 5 && data.outreach.responses === 0) {
    dashboard += `- ${data.outreach.pending} outreaches pending with no responses. Consider follow-ups.\n`;
  }

  if (parseInt(health.percentage) < 50) {
    dashboard += `- Overall health score is low. Focus on needle-mover activities.\n`;
  }

  dashboard += `
================================================================================
Run individual reports:
  ~/agent-tools/metrics/claude-analyzer.js      - Claude Code usage details
  ~/agent-tools/metrics/weekly-outcomes.js      - Things task breakdown
  ~/agent-tools/metrics/outreach-tracker.js     - Outreach pipeline
  ~/agent-tools/metrics/work-deliverables.js    - Deliverables log
================================================================================
`;

  return dashboard;
}

function exportSnapshotFile(data, dashboard) {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const filename = `metrics-snapshot-${date}.md`;
  const filepath = path.join(SNAPSHOT_DIR, filename);

  const content = `# Metrics Snapshot - ${date}

${dashboard}

## Raw Data

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
`;

  fs.writeFileSync(filepath, content);
  console.log(`\nSnapshot exported to: ${filepath}`);
}

// Main
function main() {
  const data = {
    things: getThingsData(),
    claude: getClaudeData(),
    outreach: getOutreachData(),
    deliverables: getDeliverablesData(),
    strava: getStravaData()
  };

  let dashboard;
  if (quick) {
    dashboard = formatQuickDashboard(data);
  } else {
    dashboard = formatFullDashboard(data);
  }

  console.log(dashboard);

  if (exportSnapshot) {
    exportSnapshotFile(data, dashboard);
  }
}

main();
