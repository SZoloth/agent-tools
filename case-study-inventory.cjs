#!/usr/bin/env node

/**
 * Case Study Material Inventory
 *
 * Searches across exported Roam notes and career-hub for project-related content.
 * Outputs coverage assessment against the 7 interview modules.
 *
 * Usage:
 *   case-study-inventory.js wasabi          # Search for wasabi project
 *   case-study-inventory.js dreamworks      # Search for dreamworks project
 *   case-study-inventory.js --list          # List available project exports
 *
 * Output: [project]-inventory.md in current directory
 */

const fs = require('fs')
const path = require('path')

// ==============================================================
// Configuration
// ==============================================================

const ROAM_EXPORTS_DIR = path.join(
  process.env.HOME,
  'Documents/LLM CONTEXT/career-hub/work_experience/exported-notes-from-roam-research'
)

const CASE_STUDIES_DIR = path.join(
  process.env.HOME,
  'Documents/LLM CONTEXT/career-hub/case-studies'
)

const PERSONAL_SITE_CONTENT = path.join(
  process.env.HOME,
  'personal-site/src/content/work'
)

const PERSONAL_SITE_RESEARCH = path.join(
  process.env.HOME,
  'personal-site/research'
)

// The 7 interview modules and keywords that indicate coverage
const MODULES = {
  'A. Context': {
    keywords: ['role', 'title', 'team', 'company', 'joined', 'started', 'timeline', 'org', 'report to', 'direct reports'],
    questions: ['Company/product state?', 'Your role day-to-day?', 'Team composition?', 'Timeline?']
  },
  'B. Problem': {
    keywords: ['problem', 'challenge', 'pain', 'issue', 'struggle', 'broken', 'failing', 'goal', 'kpi', 'metric', 'target', 'baseline'],
    questions: ['Core problem?', 'Evidence it was a problem?', 'Stakes?', 'KPIs with baseline?']
  },
  'C. Solution': {
    keywords: ['approach', 'solution', 'built', 'shipped', 'designed', 'research', 'user interview', 'prototype', 'decision', 'trade-off', 'alternative', 'prioritize', 'stakeholder'],
    questions: ['Research methods?', 'Alternatives considered?', 'Trade-offs?', 'Key decisions?', 'Iterations?']
  },
  'D. Results': {
    keywords: ['result', 'outcome', 'impact', 'improved', 'increased', 'decreased', 'saved', 'revenue', 'conversion', 'retention', 'nps', 'feedback', 'quote'],
    questions: ['Metrics with before/after?', 'User quotes?', 'Stakeholder reactions?']
  },
  'E. Reflection': {
    keywords: ['learned', 'differently', 'mistake', 'surprise', 'retrospective', 'lesson', 'growth'],
    questions: ['What would you do differently?', 'Biggest mistake?', 'Skills developed?']
  },
  'F. Collaboration': {
    keywords: ['team', 'engineer', 'designer', 'collaborate', 'partner', 'credit', 'together'],
    questions: ['Named collaborators?', 'Their contributions?']
  },
  'G. Artifacts': {
    keywords: ['screenshot', 'wireframe', 'deck', 'dashboard', 'figma', 'prototype', 'prd', 'document'],
    questions: ['Screenshots available?', 'Decks/PRDs?', 'Metrics visualizations?']
  }
}

// ==============================================================
// Helper Functions
// ==============================================================

function getAllMdFiles(dir) {
  const files = []
  if (!fs.existsSync(dir)) return files

  const items = fs.readdirSync(dir, { withFileTypes: true })
  for (const item of items) {
    const fullPath = path.join(dir, item.name)
    if (item.isDirectory()) {
      files.push(...getAllMdFiles(fullPath))
    } else if (item.name.endsWith('.md')) {
      files.push(fullPath)
    }
  }
  return files
}

function searchFileForKeywords(filePath, keywords) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').toLowerCase()
    const matches = keywords.filter(kw => content.includes(kw.toLowerCase()))
    return matches
  } catch {
    return []
  }
}

function getFileSnippet(filePath, keywords) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    // Find first line containing any keyword
    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      for (const kw of keywords) {
        if (lowerLine.includes(kw.toLowerCase()) && line.trim().length > 20) {
          return line.trim().slice(0, 100) + (line.length > 100 ? '...' : '')
        }
      }
    }
    return null
  } catch {
    return null
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

function getProjectDir(projectName) {
  // Find matching export directory
  if (!fs.existsSync(ROAM_EXPORTS_DIR)) return null

  const dirs = fs.readdirSync(ROAM_EXPORTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  // Look for exact match or partial match
  const exactMatch = dirs.find(d => d.toLowerCase() === projectName.toLowerCase())
  if (exactMatch) return path.join(ROAM_EXPORTS_DIR, exactMatch)

  const partialMatch = dirs.find(d => d.toLowerCase().includes(projectName.toLowerCase()))
  if (partialMatch) return path.join(ROAM_EXPORTS_DIR, partialMatch)

  return null
}

function listAvailableProjects() {
  if (!fs.existsSync(ROAM_EXPORTS_DIR)) {
    console.log('Roam exports directory not found:', ROAM_EXPORTS_DIR)
    return
  }

  const dirs = fs.readdirSync(ROAM_EXPORTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  console.log('\nAvailable project exports:\n')
  for (const dir of dirs) {
    const projectPath = path.join(ROAM_EXPORTS_DIR, dir)
    const files = getAllMdFiles(projectPath)
    const totalSize = files.reduce((sum, f) => {
      try { return sum + fs.statSync(f).size } catch { return sum }
    }, 0)
    console.log(`  ${dir.padEnd(40)} ${files.length} files, ${formatFileSize(totalSize)}`)
  }
}

// ==============================================================
// Main Inventory Function
// ==============================================================

function generateInventory(projectName) {
  console.log(`\nGenerating inventory for: ${projectName}\n`)

  const projectDir = getProjectDir(projectName)
  if (!projectDir) {
    console.error(`No export directory found for "${projectName}"`)
    console.log('\nAvailable directories:')
    listAvailableProjects()
    process.exit(1)
  }

  const inventory = {
    projectName,
    exportDir: projectDir,
    journalEntries: [],
    otherFiles: [],
    moduleCoverage: {},
    existingDrafts: [],
    gaps: []
  }

  // ==== 1. Scan journal entries ====
  const journalDir = path.join(projectDir, 'journal')
  if (fs.existsSync(journalDir)) {
    const journalFiles = fs.readdirSync(journalDir)
      .filter(f => f.endsWith('.md'))
      .sort()

    for (const file of journalFiles) {
      const filePath = path.join(journalDir, file)
      const stat = fs.statSync(filePath)
      const allKeywords = Object.values(MODULES).flatMap(m => m.keywords)
      const matches = searchFileForKeywords(filePath, allKeywords)

      if (matches.length > 0 || stat.size > 1000) {
        inventory.journalEntries.push({
          date: file.replace('.md', ''),
          size: formatFileSize(stat.size),
          keywordHits: matches.length,
          sample: matches.slice(0, 3)
        })
      }
    }
  }

  // ==== 2. Scan other files in export ====
  const allFiles = getAllMdFiles(projectDir)
  for (const filePath of allFiles) {
    if (filePath.includes('/journal/')) continue
    const relativePath = path.relative(projectDir, filePath)
    const stat = fs.statSync(filePath)
    inventory.otherFiles.push({
      path: relativePath,
      size: formatFileSize(stat.size)
    })
  }

  // ==== 3. Check module coverage ====
  for (const [moduleName, moduleConfig] of Object.entries(MODULES)) {
    let totalHits = 0
    const fileHits = []

    for (const filePath of allFiles) {
      const matches = searchFileForKeywords(filePath, moduleConfig.keywords)
      if (matches.length > 0) {
        totalHits += matches.length
        fileHits.push({
          file: path.relative(projectDir, filePath),
          matches: matches.slice(0, 3)
        })
      }
    }

    const coverage = totalHits > 10 ? 'strong' : totalHits > 3 ? 'moderate' : totalHits > 0 ? 'weak' : 'none'
    inventory.moduleCoverage[moduleName] = {
      coverage,
      totalHits,
      topFiles: fileHits.slice(0, 3),
      questionsToAsk: coverage === 'none' || coverage === 'weak' ? moduleConfig.questions : []
    }
  }

  // ==== 4. Check for existing drafts ====
  // Check case-studies directory
  if (fs.existsSync(CASE_STUDIES_DIR)) {
    const caseStudyFiles = fs.readdirSync(CASE_STUDIES_DIR)
      .filter(f => f.endsWith('.md') && f.toLowerCase().includes(projectName.toLowerCase()))
    for (const f of caseStudyFiles) {
      inventory.existingDrafts.push(path.join(CASE_STUDIES_DIR, f))
    }
  }

  // Check personal-site content
  if (fs.existsSync(PERSONAL_SITE_CONTENT)) {
    const siteFiles = fs.readdirSync(PERSONAL_SITE_CONTENT)
      .filter(f => f.endsWith('.md') && f.toLowerCase().includes(projectName.toLowerCase()))
    for (const f of siteFiles) {
      inventory.existingDrafts.push(path.join(PERSONAL_SITE_CONTENT, f))
    }
  }

  // Check personal-site research
  if (fs.existsSync(PERSONAL_SITE_RESEARCH)) {
    const researchFiles = fs.readdirSync(PERSONAL_SITE_RESEARCH)
      .filter(f => f.endsWith('.md') && f.toLowerCase().includes(projectName.toLowerCase()))
    for (const f of researchFiles) {
      inventory.existingDrafts.push(path.join(PERSONAL_SITE_RESEARCH, f))
    }
  }

  // ==== 5. Identify gaps ====
  for (const [moduleName, data] of Object.entries(inventory.moduleCoverage)) {
    if (data.coverage === 'none' || data.coverage === 'weak') {
      inventory.gaps.push({
        module: moduleName,
        coverage: data.coverage,
        action: `Self-interview needed for: ${data.questionsToAsk.join(', ')}`
      })
    }
  }

  return inventory
}

function formatInventoryAsMarkdown(inventory) {
  let md = `# ${inventory.projectName} - Material Inventory

**Generated:** ${new Date().toISOString().split('T')[0]}
**Export directory:** ${inventory.exportDir}

---

## Summary

| Metric | Value |
|--------|-------|
| Journal entries with content | ${inventory.journalEntries.length} |
| Other files | ${inventory.otherFiles.length} |
| Existing drafts | ${inventory.existingDrafts.length} |
| Modules with gaps | ${inventory.gaps.length} |

---

## Module Coverage

`

  for (const [moduleName, data] of Object.entries(inventory.moduleCoverage)) {
    const emoji = data.coverage === 'strong' ? '🟢' :
                  data.coverage === 'moderate' ? '🟡' :
                  data.coverage === 'weak' ? '🟠' : '🔴'

    md += `### ${emoji} ${moduleName}

**Coverage:** ${data.coverage} (${data.totalHits} keyword hits)

`

    if (data.topFiles.length > 0) {
      md += `**Top sources:**\n`
      for (const f of data.topFiles) {
        md += `- \`${f.file}\` (${f.matches.join(', ')})\n`
      }
      md += '\n'
    }

    if (data.questionsToAsk.length > 0) {
      md += `**Questions to ask in interview:**\n`
      for (const q of data.questionsToAsk) {
        md += `- ${q}\n`
      }
      md += '\n'
    }
  }

  md += `---

## Journal Entries (${inventory.journalEntries.length} with content)

| Date | Size | Keywords |
|------|------|----------|
`

  for (const entry of inventory.journalEntries.slice(0, 30)) {
    md += `| ${entry.date} | ${entry.size} | ${entry.sample.join(', ') || '-'} |\n`
  }

  if (inventory.journalEntries.length > 30) {
    md += `\n*...and ${inventory.journalEntries.length - 30} more entries*\n`
  }

  md += `
---

## Other Files

`

  for (const f of inventory.otherFiles) {
    md += `- \`${f.path}\` (${f.size})\n`
  }

  md += `
---

## Existing Drafts

`

  if (inventory.existingDrafts.length === 0) {
    md += `*No existing drafts found*\n`
  } else {
    for (const draft of inventory.existingDrafts) {
      md += `- \`${draft}\`\n`
    }
  }

  md += `
---

## Gaps Requiring Self-Interview

`

  if (inventory.gaps.length === 0) {
    md += `*No significant gaps - material coverage is good*\n`
  } else {
    for (const gap of inventory.gaps) {
      md += `### ${gap.module}

**Coverage:** ${gap.coverage}
**Action:** ${gap.action}

`
    }
  }

  md += `---

## Next Steps

1. Review journal entries for quotable moments
2. Conduct self-interview for gap modules
3. Use \`~/.claude/skills/case-study-writer\` to draft

---

*Generated by case-study-inventory.js*
`

  return md
}

// ==============================================================
// CLI Entry Point
// ==============================================================

function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Case Study Material Inventory

Usage:
  case-study-inventory.js <project-name>    Search for project materials
  case-study-inventory.js --list            List available project exports

Examples:
  case-study-inventory.js wasabi
  case-study-inventory.js dreamworks
  case-study-inventory.js gohunt
`)
    process.exit(0)
  }

  if (args.includes('--list')) {
    listAvailableProjects()
    process.exit(0)
  }

  const projectName = args[0]
  const inventory = generateInventory(projectName)
  const markdown = formatInventoryAsMarkdown(inventory)

  // Write output file
  const outputFile = `${projectName}-inventory.md`
  fs.writeFileSync(outputFile, markdown)
  console.log(`✓ Inventory written to ${outputFile}`)

  // Print summary
  console.log('\n--- Summary ---')
  console.log(`Journal entries: ${inventory.journalEntries.length}`)
  console.log(`Other files: ${inventory.otherFiles.length}`)
  console.log(`Existing drafts: ${inventory.existingDrafts.length}`)
  console.log(`Modules with gaps: ${inventory.gaps.length}`)

  if (inventory.gaps.length > 0) {
    console.log('\nGaps requiring interview:')
    for (const gap of inventory.gaps) {
      console.log(`  - ${gap.module}: ${gap.coverage}`)
    }
  }
}

main()
