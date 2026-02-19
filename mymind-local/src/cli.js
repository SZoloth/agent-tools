#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { parse } from 'csv-parse/sync';
import Fuse from 'fuse.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPORT_PATH = join(process.env.HOME, 'Documents', 'mymind', 'mymind');
let currentExportPath = DEFAULT_EXPORT_PATH;

function setExportPath(path) {
  currentExportPath = path;
}

function getExportPath() {
  return currentExportPath;
}

function loadCards(csvPath) {
  let csv = readFileSync(csvPath, 'utf-8');
  if (csv.charCodeAt(0) === 0xFEFF) {
    csv = csv.slice(1);
  }
  const records = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true
  });
  return records;
}

function buildFuse(cards) {
  return new Fuse(cards, {
    keys: ['title', 'content', 'note', 'tags', 'url', 'type'],
    threshold: 0.3,
    includeScore: true,
    ignoreLocation: true
  });
}

async function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', ['-s', 'http://localhost:11434/api/embeddings', '-d', JSON.stringify({
      model: 'nomic-embed-text',
      prompt: text
    })], { shell: true });

    let data = '';
    proc.stdout.on('data', (chunk) => data += chunk);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Ollama returned ${code}`));
        return;
      }
      try {
        const json = JSON.parse(data);
        resolve(json.embedding);
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
  });
}

function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magA * magB);
}

async function semanticSearch(cards, query, limit = 10) {
  const queryEmbedding = await getEmbedding(query);
  
  const scored = cards.map(card => {
    const text = [card.title, card.content, card.note, card.tags, card.url].filter(Boolean).join(' ');
    const emb = card._embedding;
    if (!emb) return { card, score: 0 };
    return { card, score: cosineSimilarity(queryEmbedding, emb) };
  });
  
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.card);
}

function findFile(exportPath, id) {
  const filesDir = join(exportPath, 'mymind');
  if (!existsSync(filesDir)) return null;
  
  const files = readdirSync(filesDir).filter(f => f.startsWith(id));
  if (files.length === 0) return null;
  return join(filesDir, files[0]);
}

function formatCard(card, idx) {
  const { id, type, title, url, tags, created } = card;
  const shortId = id ? id.substring(0, 8) : '?';
  const titleStr = title || url || '(no title)';
  const tagsStr = tags ? `#${tags.split(',').slice(0, 3).join(' #')}` : '';
  const date = created ? created.split('T')[0] : '';
  return `${idx + 1}. [${type || '?'}] ${titleStr} ${tagsStr} (${date})`;
}

function formatCardWithFile(card, idx, exportPath) {
  const file = findFile(exportPath, card.id);
  const fileMark = file ? ' 📎' : '';
  return formatCard(card, idx) + fileMark;
}

const program = new Command();

program
  .name('mymind')
  .description('Search your MyMind export')
  .option('-p, --path <path>', 'Path to MyMind export', DEFAULT_EXPORT_PATH)
  .hook('preAction', (thisCommand) => {
    const pathOpt = thisCommand.opts().path;
    if (pathOpt) {
      setExportPath(pathOpt);
    }
  });

program
  .command('search <query>')
  .description('Search your mind (fuzzy)')
  .option('-l, --limit <number>', 'Number of results', '10')
  .action(async (query, options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    const fuse = buildFuse(cards);
    const results = fuse.search(query, { limit: parseInt(options.limit) });
    
    if (results.length === 0) {
      console.log('No results found.');
      return;
    }
    
    results.forEach((result, idx) => {
      console.log(formatCardWithFile(result.item, idx, exportPath));
    });
    console.log(`\n${results.length} results`);
  });

program
  .command('semantic <query>')
  .description('Semantic search using embeddings')
  .option('-l, --limit <number>', 'Number of results', '10')
  .action(async (query, options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    
    console.log('Generating embedding...');
    const results = await semanticSearch(cards, query, parseInt(options.limit));
    
    if (results.length === 0) {
      console.log('No results found. Make sure Ollama is running with nomic-embed-text.');
      return;
    }
    
    results.forEach((card, idx) => {
      console.log(formatCardWithFile(card, idx, exportPath));
    });
    console.log(`\n${results.length} results`);
  });

program
  .command('recent')
  .description('Show recent items')
  .option('-l, --limit <number>', 'Number of results', '10')
  .action(async (options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    
    const sorted = [...cards].sort((a, b) => 
      new Date(b.created) - new Date(a.created)
    ).slice(0, parseInt(options.limit));
    
    sorted.forEach((card, idx) => {
      console.log(formatCardWithFile(card, idx, exportPath));
    });
  });

program
  .command('stats')
  .description('Show statistics')
  .action(async (options) => {
    const csvPath = join(getExportPath(), 'cards.csv');
    const cards = loadCards(csvPath);
    
    const typeCount = {};
    const tagCount = {};
    
    cards.forEach(card => {
      const type = card.type || 'Unknown';
      typeCount[type] = (typeCount[type] || 0) + 1;
      
      if (card.tags) {
        card.tags.split(',').forEach(tag => {
          const t = tag.trim();
          if (t) tagCount[t] = (tagCount[t] || 0) + 1;
        });
      }
    });
    
    const topTags = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    console.log(`Total cards: ${cards.length}\n`);
    console.log('By type:');
    Object.entries(typeCount).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });
    console.log('\nTop tags:');
    topTags.forEach(([tag, count]) => {
      console.log(`  #${tag}: ${count}`);
    });
  });

program
  .command('tags')
  .description('List all tags')
  .action(async (options) => {
    const csvPath = join(getExportPath(), 'cards.csv');
    const cards = loadCards(csvPath);
    
    const tagCount = {};
    cards.forEach(card => {
      if (card.tags) {
        card.tags.split(',').forEach(tag => {
          const t = tag.trim();
          if (t) tagCount[t] = (tagCount[t] || 0) + 1;
        });
      }
    });
    
    Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tag, count]) => {
        console.log(`${count}\t#${tag}`);
      });
  });

program
  .command('open <id>')
  .description('Open a card by ID (or partial ID)')
  .option('-o, --open', 'Open associated file in Preview')
  .action(async (id, options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    
    const card = cards.find(c => c.id.startsWith(id));
    if (!card) {
      console.log('Card not found');
      return;
    }
    
    console.log(`Type: ${card.type}`);
    console.log(`Title: ${card.title || '(none)'}`);
    console.log(`URL: ${card.url || '(none)'}`);
    console.log(`Content: ${card.content || '(none)'}`);
    console.log(`Note: ${card.note || '(none)'}`);
    console.log(`Tags: ${card.tags || '(none)'}`);
    console.log(`Created: ${card.created}`);
    
    const file = findFile(exportPath, card.id);
    if (file) {
      console.log(`\nFile: ${file}`);
      if (options.open) {
        console.log('Opening...');
        spawn('open', [file], { detached: true, stdio: 'ignore' });
      }
    } else {
      console.log(`\nNo associated file`);
    }
  });

program
  .command('index')
  .description('Build embeddings index (requires Ollama)')
  .action(async (options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    
    console.log(`Building embeddings for ${cards.length} cards...`);
    
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const text = [card.title, card.content, card.note, card.tags].filter(Boolean).join(' ');
      
      process.stdout.write(`\r${i + 1}/${cards.length}`);
      
      try {
        const emb = await getEmbedding(text);
        card._embedding = emb;
      } catch (e) {
        console.error(`\nError on card ${i}: ${e.message}`);
        break;
      }
    }
    console.log('\nDone! Index stored in memory (not persisted yet).');
    console.log('Use "semantic" command to search.');
  });

program
  .command('export-qmd <outputDir>')
  .description('Export cards as markdown for qmd indexing')
  .action(async (outputDir, options) => {
    const exportPath = getExportPath();
    const csvPath = join(exportPath, 'cards.csv');
    const cards = loadCards(csvPath);
    
    const { mkdirSync, writeFileSync } = await import('fs');
    
    mkdirSync(outputDir, { recursive: true });
    
    let count = 0;
    for (const card of cards) {
      const id = card.id;
      const title = card.title || card.url || 'Untitled';
      const date = card.created?.split('T')[0] || '';
      const tags = card.tags ? card.tags.split(',').map(t => t.trim()).join(', ') : '';
      
      let md = `# ${title}\n\n`;
      md += `**Type:** ${card.type || 'Unknown'}\n`;
      md += `**Date:** ${date}\n`;
      if (tags) md += `**Tags:** ${tags}\n`;
      if (card.url) md += `**URL:** ${card.url}\n`;
      md += `\n`;
      if (card.content) md += `${card.content}\n`;
      if (card.note) md += `**Note:** ${card.note}\n`;
      md += `\n---\n`;
      md += `*MyMind ID: ${id}*\n`;
      
      const safeTitle = title.replace(/[^a-z0-9\s]/gi, '').trim().replace(/\s+/g, '_').substring(0, 40) || 'untitled';
      writeFileSync(join(outputDir, `${safeTitle}_${id.substring(0, 8)}.md`), md);
      count++;
    }
    
    console.log(`Exported ${count} cards to ${outputDir}`);
    console.log(`\nTo index in qmd:`);
    console.log(`  qmd add ${outputDir}`);
    console.log(`  qmd embed -c mymind`);
  });

program.parse();
