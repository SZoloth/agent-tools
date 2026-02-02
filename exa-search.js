#!/usr/bin/env node

const EXA_KEY = process.env.EXA_API_KEY || '1282442a-8ff1-4ac6-8fd9-ea7b74ad4f1d';

const args = process.argv.slice(2);
const flags = {
  numResults: 10,
  text: true,
  highlights: true,
  json: false
};

// Parse flags
const query = args.filter(a => {
  if (a === '--json') { flags.json = true; return false; }
  if (a.startsWith('-n')) { flags.numResults = parseInt(a.slice(2)) || 10; return false; }
  if (a.startsWith('--num=')) { flags.numResults = parseInt(a.slice(6)) || 10; return false; }
  return true;
}).join(' ');

if (!query) {
  console.log('Usage: exa-search.js <query> [--json] [-n<num>]');
  console.log('  --json     Output raw JSON response');
  console.log('  -n10       Number of results (default: 10)');
  process.exit(1);
}

async function search() {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': EXA_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      numResults: flags.numResults,
      contents: {
        text: { maxCharacters: 1000 },
        highlights: true
      }
    })
  });

  const data = await res.json();

  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.error) {
    console.error('Error:', data.error);
    process.exit(1);
  }

  console.log(`\n🔍 "${query}" (${data.results?.length || 0} results, $${data.costDollars?.total?.toFixed(4) || '?'})\n`);

  data.results?.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title || 'No title'}`);
    console.log(`   ${r.url}`);
    if (r.text) {
      console.log(`   ${r.text.slice(0, 200).replace(/\n/g, ' ')}...`);
    }
    console.log();
  });
}

search().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
