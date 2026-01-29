#!/usr/bin/env node
/**
 * Outreach Tracker
 *
 * Tracks job search outreach activity and syncs to pipeline.md
 *
 * Usage:
 *   outreach-tracker.js log "Company" "Contact" "Method"  # Log an outreach
 *   outreach-tracker.js log "Stripe" "Matt Z" "linkedin"  # Example
 *   outreach-tracker.js status                            # Show current week
 *   outreach-tracker.js history                           # Show all outreach
 *   outreach-tracker.js response "Company" "Status"       # Log a response
 */

const fs = require('fs');
const path = require('path');

const METRICS_STORE = path.join(__dirname, 'data/metrics-store.json');
const PIPELINE_FILE = path.join(process.env.HOME, 'clawd/outreach/pipeline.md');
const OUTREACH_LOG = path.join(__dirname, 'data/outreach-log.json');

const WEEKLY_TARGET = 10;

// Initialize outreach log if doesn't exist
function initOutreachLog() {
  if (!fs.existsSync(OUTREACH_LOG)) {
    fs.writeFileSync(OUTREACH_LOG, JSON.stringify({
      outreaches: [],
      responses: [],
      interviews: []
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(OUTREACH_LOG, 'utf8'));
}

function saveOutreachLog(data) {
  fs.writeFileSync(OUTREACH_LOG, JSON.stringify(data, null, 2));
}

function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  return new Date(now.setDate(diff)).toISOString().split('T')[0];
}

function logOutreach(company, contact, method) {
  const log = initOutreachLog();
  const entry = {
    id: Date.now(),
    company,
    contact,
    method: method || 'email',
    date: new Date().toISOString(),
    weekStart: getWeekStart(),
    status: 'sent',
    followUpDue: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  };

  log.outreaches.push(entry);
  saveOutreachLog(log);
  syncToPipeline(log);

  console.log(`\nLogged outreach to ${company} (${contact}) via ${method}`);
  showStatus(log);
}

function logResponse(company, status) {
  const log = initOutreachLog();
  const outreach = log.outreaches.find(o =>
    o.company.toLowerCase() === company.toLowerCase() && o.status === 'sent'
  );

  if (outreach) {
    outreach.status = status; // 'replied', 'interview', 'rejected', 'ghosted'
    outreach.responseDate = new Date().toISOString();

    if (status === 'interview') {
      log.interviews.push({
        company: outreach.company,
        contact: outreach.contact,
        outreachDate: outreach.date,
        interviewDate: new Date().toISOString()
      });
    }

    log.responses.push({
      company: outreach.company,
      status,
      date: new Date().toISOString()
    });

    saveOutreachLog(log);
    syncToPipeline(log);
    console.log(`\nUpdated ${company} status to: ${status}`);
  } else {
    console.log(`\nNo pending outreach found for ${company}`);
  }
}

function showStatus(log) {
  if (!log) log = initOutreachLog();

  const weekStart = getWeekStart();
  const thisWeek = log.outreaches.filter(o => o.weekStart === weekStart);
  const pending = log.outreaches.filter(o => o.status === 'sent');
  const needsFollowUp = pending.filter(o => new Date(o.followUpDue) <= new Date());

  console.log(`
# Outreach Status
**Week of ${weekStart}**

## This Week
- Sent: ${thisWeek.length}/${WEEKLY_TARGET}
- Progress: ${'#'.repeat(thisWeek.length)}${'_'.repeat(Math.max(0, WEEKLY_TARGET - thisWeek.length))}
- ${thisWeek.length >= WEEKLY_TARGET ? 'TARGET HIT!' : `${WEEKLY_TARGET - thisWeek.length} more to hit target`}

## Pipeline
- Awaiting response: ${pending.length}
- Needs follow-up: ${needsFollowUp.length}
- Total interviews: ${log.interviews.length}

## Response Rate
- Total sent: ${log.outreaches.length}
- Responses: ${log.responses.length}
- Rate: ${log.outreaches.length > 0 ? ((log.responses.length / log.outreaches.length) * 100).toFixed(0) : 0}%
`);

  if (needsFollowUp.length > 0) {
    console.log('## Needs Follow-Up');
    for (const o of needsFollowUp.slice(0, 5)) {
      console.log(`- ${o.company} (${o.contact}) - sent ${o.date.split('T')[0]}`);
    }
  }
}

function showHistory() {
  const log = initOutreachLog();

  console.log('\n# Outreach History\n');

  // Group by week
  const byWeek = {};
  for (const o of log.outreaches) {
    const week = o.weekStart;
    if (!byWeek[week]) byWeek[week] = [];
    byWeek[week].push(o);
  }

  const weeks = Object.keys(byWeek).sort().reverse();
  for (const week of weeks.slice(0, 8)) {
    const outreaches = byWeek[week];
    console.log(`## Week of ${week} (${outreaches.length}/${WEEKLY_TARGET})`);
    for (const o of outreaches) {
      const status = o.status === 'sent' ? 'PENDING' : o.status.toUpperCase();
      console.log(`  - ${o.company} (${o.contact}) [${status}]`);
    }
    console.log('');
  }
}

function syncToPipeline(log) {
  const pending = log.outreaches.filter(o => o.status === 'sent');
  const responded = log.outreaches.filter(o => ['replied', 'interview'].includes(o.status));
  const weekStart = getWeekStart();
  const thisWeek = log.outreaches.filter(o => o.weekStart === weekStart);

  const pipelineContent = `# Outreach Pipeline

## This Week's Batch
<!-- Auto-updated by outreach-tracker.js -->

### Sent - Awaiting Response
| Contact | Company | Sent Date | Follow-up Due | Status |
|---------|---------|-----------|---------------|--------|
${pending.map(o => `| ${o.contact} | ${o.company} | ${o.date.split('T')[0]} | ${o.followUpDue} | ${o.status} |`).join('\n') || '| - | - | - | - | - |'}

### Responses
| Contact | Company | Response Date | Next Action |
|---------|---------|---------------|-------------|
${responded.map(o => `| ${o.contact} | ${o.company} | ${o.responseDate?.split('T')[0] || '-'} | ${o.status} |`).join('\n') || '| - | - | - | - |'}

## Metrics
- **This week**: ${thisWeek.length} sent, ${log.responses.filter(r => new Date(r.date) >= new Date(weekStart)).length} responses
- **Total**: ${log.outreaches.length} sent, ${log.responses.length} responses, ${log.interviews.length} interviews
- **Response rate**: ${log.outreaches.length > 0 ? ((log.responses.length / log.outreaches.length) * 100).toFixed(0) : 0}%

## Last Updated
${new Date().toISOString()}
`;

  fs.writeFileSync(PIPELINE_FILE, pipelineContent);
}

// CLI handling
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'log':
    if (args.length < 3) {
      console.log('Usage: outreach-tracker.js log "Company" "Contact" ["Method"]');
      console.log('Methods: email, linkedin, twitter, phone, other');
    } else {
      logOutreach(args[1], args[2], args[3]);
    }
    break;

  case 'response':
    if (args.length < 3) {
      console.log('Usage: outreach-tracker.js response "Company" "Status"');
      console.log('Statuses: replied, interview, rejected, ghosted');
    } else {
      logResponse(args[1], args[2]);
    }
    break;

  case 'status':
    showStatus();
    break;

  case 'history':
    showHistory();
    break;

  default:
    console.log(`
Outreach Tracker - Track job search outreach

Commands:
  log "Company" "Contact" ["Method"]  - Log an outreach
  response "Company" "Status"         - Log a response
  status                              - Show current week status
  history                             - Show all outreach history

Examples:
  outreach-tracker.js log "Stripe" "Matt Ziegler" "linkedin"
  outreach-tracker.js response "Stripe" "replied"
  outreach-tracker.js status
`);
}
