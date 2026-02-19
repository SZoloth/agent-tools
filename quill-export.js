#!/usr/bin/env node

/**
 * quill-export - Export Quill document data for piping to AI agents
 *
 * Usage:
 *   quill-export                    # Output prompt text (default)
 *   quill-export --json             # Output full JSON data
 *   quill-export --content          # Output document content only
 *   quill-export --annotations      # Output annotations as JSON
 *   quill-export --path             # Print the expected export file path
 *   quill-export --help             # Show help
 *
 * Workflow examples:
 *   quill-export | claude -p "revise based on feedback"
 *   quill-export --json | jq .annotations
 *   quill-export --content > draft.txt
 */

import fs from 'fs';
import path from 'path';

const QUILL_DATA_DIR = path.join(process.env.HOME, '.quill');
const QUILL_DATA_PATH = path.join(QUILL_DATA_DIR, 'document.json');

const HELP_TEXT = `
quill-export - Export Quill document data for piping to AI agents

USAGE
  quill-export [options]

OPTIONS
  --json         Output full document data as JSON
  --content      Output document content (plain text) only
  --annotations  Output annotations as JSON array
  --prompt       Output generated prompt text (default)
  --path         Print the expected export file path
  --help, -h     Show this help message

SETUP
  1. Open your document in Quill (writing-assistant)
  2. Click "Export for CLI" button in the prompt panel
  3. Save to: ~/.quill/document.json
  4. Now use this CLI to access the data

EXAMPLES
  # Pipe prompt to Claude for revision
  quill-export | claude -p "revise based on the feedback"

  # Extract annotations with jq
  quill-export --json | jq '.annotations[] | {text, comment}'

  # Get word count
  quill-export --json | jq .wordCount

  # Check annotation count
  quill-export --annotations | jq length
`;

function printHelp() {
  console.log(HELP_TEXT.trim());
}

function printPath() {
  console.log(QUILL_DATA_PATH);
}

function loadDocument() {
  if (!fs.existsSync(QUILL_DATA_PATH)) {
    console.error(`Error: No Quill document found at ${QUILL_DATA_PATH}`);
    console.error('');
    console.error('To export from Quill:');
    console.error('  1. Open your document in the Writing Assistant');
    console.error('  2. Click "Export for CLI" in the prompt panel');
    console.error(`  3. Save to: ${QUILL_DATA_PATH}`);
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(QUILL_DATA_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading document: ${error.message}`);
    process.exit(1);
  }
}

function outputJSON(data) {
  console.log(JSON.stringify(data, null, 2));
}

function outputContent(data) {
  console.log(data.content || '');
}

function outputAnnotations(data) {
  console.log(JSON.stringify(data.annotations || [], null, 2));
}

function outputPrompt(data) {
  console.log(data.prompt || '');
}

function main() {
  const args = process.argv.slice(2);

  // Handle help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Handle path query
  if (args.includes('--path')) {
    printPath();
    process.exit(0);
  }

  // Load document
  const data = loadDocument();

  // Determine output mode
  if (args.includes('--json')) {
    outputJSON(data);
  } else if (args.includes('--content')) {
    outputContent(data);
  } else if (args.includes('--annotations')) {
    outputAnnotations(data);
  } else {
    // Default: output prompt
    outputPrompt(data);
  }
}

main();
