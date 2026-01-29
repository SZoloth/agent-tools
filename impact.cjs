#!/usr/bin/env node
/**
 * impact.js - Frictionless impact capture for real-time documentation
 *
 * Captures impact moments as they happen, storing to event queue for
 * weekly aggregation to markdown and Roam.
 *
 * Usage:
 *   impact decision "Kill native Courier tracking" --before "12-week build" --after "6-week ShotGrid"
 *   impact quote "Sam's discovery showed us..." --person "Jeff" --context "Courier planning"
 *   impact coaching "Jeff ran discovery independently" --skill "discovery" --evidence "Crowds session"
 *   impact quick "Charles pivoted Previz approach based on research"
 *   impact artifact "Story department research deck" --type "deliverable" --for "Charles"
 *   impact metric "Reduced search time from 10min to 2min" --baseline "10min" --result "2min"
 *
 *   impact list                    # Show pending events
 *   impact list --week             # Show this week's events
 *   impact stats                   # Show running totals
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS_DIR = path.join(process.env.HOME, '.claude', 'impact-events');
const ARCHIVE_DIR = path.join(EVENTS_DIR, 'archive');

// Ensure directories exist
[EVENTS_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Event types and their required/optional fields
const EVENT_TYPES = {
  decision: {
    description: 'A decision you influenced or changed',
    required: ['summary'],
    optional: ['before', 'after', 'basis', 'stakeholders', 'expected_impact']
  },
  quote: {
    description: 'A stakeholder quote that demonstrates impact',
    required: ['summary', 'person'],
    optional: ['context', 'date']
  },
  coaching: {
    description: 'A coaching milestone achieved',
    required: ['summary'],
    optional: ['skill', 'evidence', 'person']
  },
  metric: {
    description: 'A measurable improvement',
    required: ['summary'],
    optional: ['baseline', 'result', 'improvement']
  },
  artifact: {
    description: 'A deliverable produced',
    required: ['summary'],
    optional: ['type', 'for', 'url']
  },
  quick: {
    description: 'Quick capture with minimal structure',
    required: ['summary'],
    optional: ['tags']
  }
};

function generateId(type) {
  const date = new Date().toISOString().split('T')[0];
  const hash = crypto.randomBytes(3).toString('hex');
  return `${date}-${type}-${hash}`;
}

function createEvent(type, data) {
  const event = {
    id: generateId(type),
    type,
    timestamp: new Date().toISOString(),
    source: 'cli',
    week: getWeekNumber(new Date()),
    data
  };

  const filename = `${event.id}.event.json`;
  const filepath = path.join(EVENTS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(event, null, 2));

  return { event, filepath };
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${Math.ceil((((d - yearStart) / 86400000) + 1) / 7).toString().padStart(2, '0')}`;
}

function getEvents(options = {}) {
  const events = [];
  const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.event.json'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(EVENTS_DIR, file), 'utf8');
    const event = JSON.parse(content);
    events.push(event);
  }

  // Filter by week if specified
  if (options.week) {
    const currentWeek = getWeekNumber(new Date());
    return events.filter(e => e.week === currentWeek);
  }

  // Sort by timestamp, newest first
  return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function listEvents(options = {}) {
  const events = getEvents(options);

  if (events.length === 0) {
    console.log(options.week ? '\n  No impact events captured this week yet.\n' : '\n  No pending impact events.\n');
    console.log('Capture one with: impact quick "Your impact here"');
    return;
  }

  const header = options.week ? 'This Week\'s Impact Events' : 'Pending Impact Events';
  console.log(`\n${header}\n${'─'.repeat(50)}`);

  const byType = {};
  for (const event of events) {
    byType[event.type] = byType[event.type] || [];
    byType[event.type].push(event);
  }

  const icons = {
    decision: '[DEC]',
    quote: '[QUO]',
    coaching: '[COA]',
    metric: '[MET]',
    artifact: '[ART]',
    quick: '[QIK]'
  };

  for (const [type, typeEvents] of Object.entries(byType)) {
    console.log(`\n${icons[type] || '•'} ${type.toUpperCase()} (${typeEvents.length})`);
    for (const event of typeEvents.slice(0, 5)) {
      const date = new Date(event.timestamp).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
      const summary = event.data.summary.length > 60
        ? event.data.summary.slice(0, 57) + '...'
        : event.data.summary;
      console.log(`   ${date}: ${summary}`);
    }
    if (typeEvents.length > 5) {
      console.log(`   ... and ${typeEvents.length - 5} more`);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Total: ${events.length} events\n`);
}

function showStats() {
  const events = getEvents({ week: true });
  const allEvents = getEvents();

  console.log('\nImpact Capture Stats');
  console.log('═'.repeat(50));

  // This week
  console.log('\nThis Week:');
  const byType = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
  }

  const icons = { decision: '[DEC]', quote: '[QUO]', coaching: '[COA]', metric: '[MET]', artifact: '[ART]', quick: '[QIK]' };
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${icons[type] || '•'} ${type}: ${count}`);
  }
  console.log(`  Total: ${events.length}`);
  console.log(`  Target: 5+ impact moments per week`);

  // Status indicator
  if (events.length >= 5) {
    console.log('\n  [OK] On track!');
  } else if (events.length >= 3) {
    console.log(`\n  [!] ${5 - events.length} more to hit target`);
  } else {
    console.log(`\n  [!] Need ${5 - events.length} more captures`);
  }

  // All time
  console.log('\nAll Time (pending):');
  console.log(`  ${allEvents.length} events awaiting aggregation`);

  console.log('');
}

function parseArgs(args) {
  const result = { positional: [], options: {} };
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      result.options[key] = value;
    } else if (!arg.startsWith('-')) {
      result.positional.push(arg);
    }
    i++;
  }

  return result;
}

function handleDecision(summary, options) {
  const data = {
    summary,
    before: options.before || null,
    after: options.after || null,
    basis: options.basis || null,
    stakeholders: options.stakeholders?.split(',').map(s => s.trim()) || [],
    expected_impact: options['expected-impact'] || options.impact || null
  };

  const { event, filepath } = createEvent('decision', data);

  console.log('\n[DEC] Decision captured!');
  console.log(`   "${summary}"`);
  if (data.before && data.after) {
    console.log(`   Before: ${data.before}`);
    console.log(`   After: ${data.after}`);
  }
  if (data.basis) {
    console.log(`   Basis: ${data.basis}`);
  }
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function handleQuote(summary, options) {
  if (!options.person) {
    console.error('Error: --person is required for quote type');
    console.error('Usage: impact quote "The quote here" --person "Jeff"');
    process.exit(1);
  }

  const data = {
    summary,
    person: options.person,
    context: options.context || null,
    date: options.date || new Date().toISOString().split('T')[0]
  };

  const { event, filepath } = createEvent('quote', data);

  console.log('\n[QUO] Quote captured!');
  console.log(`   "${summary}"`);
  console.log(`   - ${data.person}`);
  if (data.context) {
    console.log(`   Context: ${data.context}`);
  }
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function handleCoaching(summary, options) {
  const data = {
    summary,
    skill: options.skill || null,
    evidence: options.evidence || null,
    person: options.person || null
  };

  const { event, filepath } = createEvent('coaching', data);

  console.log('\n[COA] Coaching milestone captured!');
  console.log(`   "${summary}"`);
  if (data.skill) {
    console.log(`   Skill: ${data.skill}`);
  }
  if (data.evidence) {
    console.log(`   Evidence: ${data.evidence}`);
  }
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function handleMetric(summary, options) {
  const data = {
    summary,
    baseline: options.baseline || null,
    result: options.result || null,
    improvement: options.improvement || null
  };

  const { event, filepath } = createEvent('metric', data);

  console.log('\n[MET] Metric captured!');
  console.log(`   "${summary}"`);
  if (data.baseline && data.result) {
    console.log(`   Baseline: ${data.baseline} -> Result: ${data.result}`);
  }
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function handleArtifact(summary, options) {
  const data = {
    summary,
    type: options.type || 'deliverable',
    for: options.for || null,
    url: options.url || null
  };

  const { event, filepath } = createEvent('artifact', data);

  console.log('\n[ART] Artifact captured!');
  console.log(`   "${summary}"`);
  console.log(`   Type: ${data.type}`);
  if (data.for) {
    console.log(`   For: ${data.for}`);
  }
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function handleQuick(summary, options) {
  const data = {
    summary,
    tags: options.tags?.split(',').map(s => s.trim()) || []
  };

  const { event, filepath } = createEvent('quick', data);

  console.log('\n[QIK] Impact captured!');
  console.log(`   "${summary}"`);
  console.log(`\n   Saved: ${path.basename(filepath)}\n`);
}

function showHelp() {
  console.log(`
impact - Frictionless impact capture at the moment it happens

USAGE:
  impact <type> <summary> [options]
  impact list [--week]
  impact stats

TYPES:
  decision    A decision you influenced or changed
  quote       A stakeholder quote demonstrating impact (requires --person)
  coaching    A coaching milestone achieved
  metric      A measurable improvement
  artifact    A deliverable produced
  quick       Quick capture with minimal structure

OPTIONS:
  --before <text>     What the situation was before (decision)
  --after <text>      What changed after (decision)
  --basis <text>      What informed the decision (decision)
  --person <name>     Who said it (quote, coaching) - REQUIRED for quote
  --context <text>    Context for the quote (quote)
  --skill <name>      Skill demonstrated (coaching)
  --evidence <text>   Evidence of milestone (coaching)
  --baseline <text>   Starting point (metric)
  --result <text>     End result (metric)
  --type <text>       Type of artifact (artifact)
  --for <name>        Who the artifact is for (artifact)
  --tags <list>       Comma-separated tags (quick)

EXAMPLES:
  impact decision "Kill native Courier tracking" \\
    --before "12-week custom build" \\
    --after "6-week ShotGrid integration" \\
    --basis "Discovery showed existing entity"

  impact quote "Sam's discovery work showed us we were solving the wrong problem" \\
    --person "Jeff" --context "Courier planning meeting"

  impact coaching "Jeff ran discovery session independently" \\
    --skill "discovery" --evidence "Crowds stakeholder session"

  impact quick "Charles pivoted Previz approach based on my research"

  impact list            # Show pending events
  impact list --week     # Show this week's events
  impact stats           # Show capture stats

The aggregator (Fridays 5pm) rolls up events to weekly-impact-log.md and Roam.
`);
}

// Main
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exit(0);
}

const command = args[0];

if (command === 'list') {
  listEvents({ week: args.includes('--week') });
  process.exit(0);
}

if (command === 'stats') {
  showStats();
  process.exit(0);
}

// Handle event types
if (!EVENT_TYPES[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Valid types: ${Object.keys(EVENT_TYPES).join(', ')}`);
  console.error('Run "impact --help" for usage');
  process.exit(1);
}

const { positional, options } = parseArgs(args.slice(1));
const summary = positional[0];

if (!summary) {
  console.error(`Error: Summary required for ${command}`);
  console.error(`Usage: impact ${command} "Your summary here" [options]`);
  process.exit(1);
}

switch (command) {
  case 'decision':
    handleDecision(summary, options);
    break;
  case 'quote':
    handleQuote(summary, options);
    break;
  case 'coaching':
    handleCoaching(summary, options);
    break;
  case 'metric':
    handleMetric(summary, options);
    break;
  case 'artifact':
    handleArtifact(summary, options);
    break;
  case 'quick':
    handleQuick(summary, options);
    break;
}
