#!/usr/bin/env node
/**
 * Work Deliverables Tracker
 *
 * Tracks shipped deliverables for portfolio/impact evidence.
 * Designed for DWA work but works for any project.
 *
 * Usage:
 *   work-deliverables.js log "Title" "Project" "Stakeholder" ["Type"]
 *   work-deliverables.js list                    # List all deliverables
 *   work-deliverables.js list --project "DWA"   # Filter by project
 *   work-deliverables.js export                  # Export to markdown
 */

const fs = require('fs');
const path = require('path');

const DELIVERABLES_FILE = path.join(__dirname, 'data/deliverables.json');
const EXPORT_FILE = path.join(process.env.HOME, 'Documents/LLM CONTEXT/1 - personal/job_search/work-deliverables-log.md');

// Deliverable types
const TYPES = {
  'research': 'Research & Analysis',
  'strategy': 'Strategy Document',
  'design': 'Design Artifact',
  'prototype': 'Prototype/POC',
  'presentation': 'Presentation',
  'spec': 'Product Spec',
  'process': 'Process/Framework',
  'workshop': 'Workshop/Facilitation',
  'other': 'Other'
};

function initDeliverables() {
  if (!fs.existsSync(DELIVERABLES_FILE)) {
    fs.writeFileSync(DELIVERABLES_FILE, JSON.stringify({ deliverables: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DELIVERABLES_FILE, 'utf8'));
}

function saveDeliverables(data) {
  fs.writeFileSync(DELIVERABLES_FILE, JSON.stringify(data, null, 2));
}

function logDeliverable(title, project, stakeholder, type = 'other') {
  const data = initDeliverables();

  const entry = {
    id: Date.now(),
    title,
    project,
    stakeholder,
    type,
    typeName: TYPES[type] || 'Other',
    date: new Date().toISOString().split('T')[0],
    quarter: getQuarter()
  };

  data.deliverables.push(entry);
  saveDeliverables(data);

  console.log(`
Logged deliverable:
  Title: ${title}
  Project: ${project}
  Stakeholder: ${stakeholder}
  Type: ${entry.typeName}
  Date: ${entry.date}
`);
}

function getQuarter() {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `Q${q} ${now.getFullYear()}`;
}

function listDeliverables(projectFilter) {
  const data = initDeliverables();
  let deliverables = data.deliverables;

  if (projectFilter) {
    deliverables = deliverables.filter(d =>
      d.project.toLowerCase().includes(projectFilter.toLowerCase())
    );
  }

  console.log(`\n# Work Deliverables (${deliverables.length} total)\n`);

  // Group by quarter
  const byQuarter = {};
  for (const d of deliverables) {
    if (!byQuarter[d.quarter]) byQuarter[d.quarter] = [];
    byQuarter[d.quarter].push(d);
  }

  const quarters = Object.keys(byQuarter).sort().reverse();
  for (const quarter of quarters) {
    const items = byQuarter[quarter];
    console.log(`## ${quarter} (${items.length} deliverables)`);
    for (const d of items) {
      console.log(`  - [${d.typeName}] ${d.title}`);
      console.log(`    ${d.project} | ${d.stakeholder} | ${d.date}`);
    }
    console.log('');
  }

  // Summary stats
  const byType = {};
  const byProject = {};
  for (const d of deliverables) {
    byType[d.typeName] = (byType[d.typeName] || 0) + 1;
    byProject[d.project] = (byProject[d.project] || 0) + 1;
  }

  console.log('## Summary');
  console.log('\nBy Type:');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nBy Project:');
  for (const [project, count] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${project}: ${count}`);
  }
}

function exportToMarkdown() {
  const data = initDeliverables();
  const deliverables = data.deliverables;

  // Group by quarter
  const byQuarter = {};
  for (const d of deliverables) {
    if (!byQuarter[d.quarter]) byQuarter[d.quarter] = [];
    byQuarter[d.quarter].push(d);
  }

  let md = `# Work Deliverables Log

**Total Deliverables**: ${deliverables.length}
**Last Updated**: ${new Date().toISOString().split('T')[0]}

This log tracks shipped work products for portfolio evidence and impact documentation.

`;

  const quarters = Object.keys(byQuarter).sort().reverse();
  for (const quarter of quarters) {
    const items = byQuarter[quarter];
    md += `## ${quarter}\n\n`;
    md += `| Date | Title | Type | Project | Stakeholder |\n`;
    md += `|------|-------|------|---------|-------------|\n`;
    for (const d of items.sort((a, b) => b.date.localeCompare(a.date))) {
      md += `| ${d.date} | ${d.title} | ${d.typeName} | ${d.project} | ${d.stakeholder} |\n`;
    }
    md += '\n';
  }

  // Stats section
  const byType = {};
  const byProject = {};
  for (const d of deliverables) {
    byType[d.typeName] = (byType[d.typeName] || 0) + 1;
    byProject[d.project] = (byProject[d.project] || 0) + 1;
  }

  md += `## Statistics

### By Type
${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, c]) => `- ${t}: ${c}`).join('\n')}

### By Project
${Object.entries(byProject).sort((a, b) => b[1] - a[1]).map(([p, c]) => `- ${p}: ${c}`).join('\n')}
`;

  // Ensure directory exists
  const dir = path.dirname(EXPORT_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(EXPORT_FILE, md);
  console.log(`\nExported ${deliverables.length} deliverables to:\n${EXPORT_FILE}`);
}

// CLI handling
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'log':
    if (args.length < 4) {
      console.log('Usage: work-deliverables.js log "Title" "Project" "Stakeholder" ["Type"]');
      console.log('\nTypes: research, strategy, design, prototype, presentation, spec, process, workshop, other');
      console.log('\nExample:');
      console.log('  work-deliverables.js log "Cart Selection UX Research" "DWA-Lasso" "Charles/Scott" "research"');
    } else {
      logDeliverable(args[1], args[2], args[3], args[4]);
    }
    break;

  case 'list':
    const projectIdx = args.indexOf('--project');
    const projectFilter = projectIdx > -1 ? args[projectIdx + 1] : null;
    listDeliverables(projectFilter);
    break;

  case 'export':
    exportToMarkdown();
    break;

  default:
    console.log(`
Work Deliverables Tracker - Track shipped work for impact evidence

Commands:
  log "Title" "Project" "Stakeholder" ["Type"]  - Log a deliverable
  list [--project "Name"]                       - List all deliverables
  export                                        - Export to markdown

Types: research, strategy, design, prototype, presentation, spec, process, workshop, other

Examples:
  work-deliverables.js log "Cart Selection UX Research" "DWA-Lasso" "Charles/Scott" "research"
  work-deliverables.js log "Release Notes Template" "DWA-Process" "Rich/Team" "process"
  work-deliverables.js list --project "DWA"
  work-deliverables.js export
`);
}
