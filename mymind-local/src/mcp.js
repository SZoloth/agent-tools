#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { parse } from 'csv-parse/sync';
import Fuse from 'fuse.js';
import { join } from 'path';

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

function findFile(exportPath, id) {
  const filesDir = join(exportPath, 'mymind');
  if (!existsSync(filesDir)) return null;
  const files = readdirSync(filesDir).filter(f => f.startsWith(id));
  if (files.length === 0) return null;
  return join(filesDir, files[0]);
}

const server = new Server(
  {
    name: 'mymind-local',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'mymind_search',
        description: 'Search your MyMind using fuzzy search. Returns cards with titles, URLs, tags, and indicates if there is an associated image/PDF file.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Number of results (default 10)', default: 10 },
            path: { type: 'string', description: 'Path to MyMind export (optional)' }
          },
          required: ['query']
        }
      },
      {
        name: 'mymind_recent',
        description: 'Get recent items from your MyMind',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of results (default 10)', default: 10 },
            path: { type: 'string', description: 'Path to MyMind export (optional)' }
          }
        }
      },
      {
        name: 'mymind_stats',
        description: 'Get statistics about your MyMind (total cards, types, top tags)',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to MyMind export (optional)' }
          }
        }
      },
      {
        name: 'mymind_tags',
        description: 'List all tags in your MyMind with counts',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to MyMind export (optional)' }
          }
        }
      },
      {
        name: 'mymind_open',
        description: 'Get details about a specific card by ID (or partial ID)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Card ID (or partial ID)' },
            path: { type: 'string', description: 'Path to MyMind export (optional)' }
          },
          required: ['id']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  const exportPath = args.path || getExportPath();
  const csvPath = join(exportPath, 'cards.csv');
  
  if (name === 'mymind_search') {
    const cards = loadCards(csvPath);
    const fuse = buildFuse(cards);
    const results = fuse.search(args.query, { limit: args.limit || 10 });
    
    const formatted = results.map((result, idx) => {
      const card = result.item;
      const file = findFile(exportPath, card.id);
      const fileMark = file ? ' [HAS_FILE]' : '';
      const title = card.title || card.url || '(no title)';
      return `${idx + 1}. [${card.type}] ${title} | Tags: ${card.tags || '-'} | ${card.created?.split('T')[0]}${fileMark}`;
    });
    
    return {
      content: [
        {
          type: 'text',
          text: formatted.join('\n') || 'No results found.'
        }
      ]
    };
  }
  
  if (name === 'mymind_recent') {
    const cards = loadCards(csvPath);
    const sorted = [...cards].sort((a, b) => 
      new Date(b.created) - new Date(a.created)
    ).slice(0, args.limit || 10);
    
    const formatted = sorted.map((card, idx) => {
      const file = findFile(exportPath, card.id);
      const fileMark = file ? ' [HAS_FILE]' : '';
      const title = card.title || card.url || '(no title)';
      return `${idx + 1}. [${card.type}] ${title} | Tags: ${card.tags || '-'} | ${card.created?.split('T')[0]}${fileMark}`;
    });
    
    return {
      content: [
        {
          type: 'text',
          text: formatted.join('\n')
        }
      ]
    };
  }
  
  if (name === 'mymind_stats') {
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
    
    let output = `Total cards: ${cards.length}\n\nBy type:\n`;
    Object.entries(typeCount).forEach(([type, count]) => {
      output += `  ${type}: ${count}\n`;
    });
    output += '\nTop tags:\n';
    topTags.forEach(([tag, count]) => {
      output += `  #${tag}: ${count}\n`;
    });
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
  
  if (name === 'mymind_tags') {
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
    
    const output = Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => `${count}\t#${tag}`)
      .join('\n');
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
  
  if (name === 'mymind_open') {
    const cards = loadCards(csvPath);
    const card = cards.find(c => c.id.startsWith(args.id));
    
    if (!card) {
      return {
        content: [{ type: 'text', text: 'Card not found' }]
      };
    }
    
    const file = findFile(exportPath, card.id);
    let output = `Type: ${card.type}\n`;
    output += `Title: ${card.title || '(none)'}\n`;
    output += `URL: ${card.url || '(none)'}\n`;
    output += `Content: ${card.content || '(none)'}\n`;
    output += `Note: ${card.note || '(none)'}\n`;
    output += `Tags: ${card.tags || '(none)'}\n`;
    output += `Created: ${card.created}\n`;
    output += `File: ${file || 'none'}`;
    
    return {
      content: [{ type: 'text', text: output }]
    };
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
