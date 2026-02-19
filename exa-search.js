#!/usr/bin/env node

const EXA_KEY = process.env.EXA_API_KEY;
if (!EXA_KEY) {
  console.error('Error: EXA_API_KEY environment variable is required');
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = {
  numResults: 10,
  text: true,
  highlights: true,
  json: false,
  type: null,
  category: null,
  similarUrl: null,
  contentsUrls: [],
  template: null,
  templateArg: null,
};

// Parse flags, collect positional args as query words
const queryParts = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') { flags.json = true; }
  else if (a.startsWith('-n') && a.length > 2) { flags.numResults = parseInt(a.slice(2)) || 10; }
  else if (a === '--num' && args[i + 1]) { flags.numResults = parseInt(args[++i]) || 10; }
  else if (a.startsWith('--num=')) { flags.numResults = parseInt(a.slice(6)) || 10; }
  else if (a === '--type' && args[i + 1]) { flags.type = args[++i]; }
  else if (a === '--category' && args[i + 1]) { flags.category = args[++i]; }
  else if (a === '--similar' && args[i + 1]) { flags.similarUrl = args[++i]; }
  else if (a === '--contents') {
    // Collect all remaining non-flag args as URLs
    while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags.contentsUrls.push(args[++i]);
    }
  }
  else if (a === '--template' && args[i + 1]) {
    flags.template = args[++i];
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      flags.templateArg = args[++i];
    }
  }
  else { queryParts.push(a); }
}

const query = queryParts.join(' ');

// Show usage if no actionable input
if (!query && !flags.similarUrl && flags.contentsUrls.length === 0 && !flags.template) {
  console.log('Usage: exa-search.js <query> [options]');
  console.log('  --json                          Output raw JSON response');
  console.log('  -n<num> or --num=<num>          Number of results (default: 10)');
  console.log('  --type <neural|keyword|auto>    Search type (default: neural)');
  console.log('  --category <type>               Filter by category (blog_post, company, news, etc.)');
  console.log('  --similar <url>                 Find similar pages to URL');
  console.log('  --contents <url> [url2] ...     Get full contents of URLs');
  console.log('  --template <name> <arg>         Use predefined job search template');
  console.log('');
  console.log('Templates:');
  console.log('  --template hm-content <company>         HM writing & thought leadership');
  console.log('  --template product-intel <company>      Product roadmap & strategy');
  console.log('  --template competitor <url>             Find similar companies');
  console.log('  --template engineering-blog <company>   Engineering blog posts');
  process.exit(1);
}

// Resolve templates into search parameters
function resolveTemplate(template, arg) {
  switch (template) {
    case 'hm-content':
      return { query: `hiring manager product strategy ${arg}`, type: 'neural', category: null };
    case 'product-intel':
      return { query: `${arg} product roadmap OR strategy`, type: 'neural', category: 'blog_post' };
    case 'competitor':
      return { similarUrl: arg };
    case 'engineering-blog':
      return { query: `${arg} engineering blog technical`, type: 'neural', category: 'blog_post' };
    default:
      console.error(`Unknown template: ${template}`);
      process.exit(1);
  }
}

async function doSearch(searchQuery, opts = {}) {
  const body = {
    query: searchQuery,
    numResults: opts.numResults || flags.numResults,
    contents: {
      text: { maxCharacters: 3000 },
      highlights: true,
    },
  };
  if (opts.type || flags.type) body.type = opts.type || flags.type;
  if (opts.category || flags.category) body.category = opts.category || flags.category;

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function doFindSimilar(url) {
  const res = await fetch('https://api.exa.ai/findSimilar', {
    method: 'POST',
    headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      numResults: flags.numResults,
      contents: { text: { maxCharacters: 3000 } },
    }),
  });
  return res.json();
}

async function doGetContents(urls) {
  const res = await fetch('https://api.exa.ai/contents', {
    method: 'POST',
    headers: { 'x-api-key': EXA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls,
      text: { maxCharacters: 3000 },
    }),
  });
  return res.json();
}

function printResults(data, label) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.error) {
    console.error('Error:', data.error);
    process.exit(1);
  }

  const results = data.results || [];
  console.log(`\n"${label}" (${results.length} results, $${data.costDollars?.total?.toFixed(4) || '?'})\n`);

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title || 'No title'}`);
    console.log(`   ${r.url}`);
    if (r.text) {
      console.log(`   ${r.text.slice(0, 200).replace(/\n/g, ' ')}...`);
    }
    console.log();
  });
}

async function main() {
  // Handle templates
  if (flags.template) {
    const resolved = resolveTemplate(flags.template, flags.templateArg);
    if (resolved.similarUrl) {
      const data = await doFindSimilar(resolved.similarUrl);
      printResults(data, `similar to ${resolved.similarUrl}`);
    } else {
      const data = await doSearch(resolved.query, {
        type: resolved.type,
        category: resolved.category,
      });
      printResults(data, resolved.query);
    }
    return;
  }

  // Handle findSimilar mode
  if (flags.similarUrl) {
    const data = await doFindSimilar(flags.similarUrl);
    printResults(data, `similar to ${flags.similarUrl}`);
    return;
  }

  // Handle getContents mode
  if (flags.contentsUrls.length > 0) {
    const data = await doGetContents(flags.contentsUrls);
    if (flags.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      if (data.error) {
        console.error('Error:', data.error);
        process.exit(1);
      }
      const results = data.results || data.contents || [];
      console.log(`\nContents for ${flags.contentsUrls.length} URL(s):\n`);
      results.forEach((r, i) => {
        console.log(`--- ${i + 1}. ${r.title || r.url || 'Unknown'} ---`);
        console.log(`URL: ${r.url}`);
        if (r.text) console.log(r.text.slice(0, 3000));
        console.log();
      });
    }
    return;
  }

  // Standard search
  const data = await doSearch(query);
  printResults(data, query);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
