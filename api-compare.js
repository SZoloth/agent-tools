#!/usr/bin/env node

const EXA_KEY = process.env.EXA_API_KEY;
const PARALLEL_KEY = process.env.PARALLEL_API_KEY; // Optional, for comparison tests only

const query = process.argv.slice(2).join(' ') || 'AI startups in Denver with Series A funding';

async function searchExa(query) {
  const start = Date.now();
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': EXA_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      numResults: 10,
      contents: {
        text: { maxCharacters: 500 },
        highlights: true
      }
    })
  });
  const data = await res.json();
  const elapsed = Date.now() - start;
  return { data, elapsed, cost: data.costDollars?.total || 0.005 };
}

async function searchParallel(query) {
  const start = Date.now();
  const res = await fetch('https://api.parallel.ai/v1beta/search', {
    method: 'POST',
    headers: {
      'x-api-key': PARALLEL_KEY,
      'Content-Type': 'application/json',
      'parallel-beta': 'search-extract-2025-10-10'
    },
    body: JSON.stringify({
      objective: query,
      search_queries: [query],
      max_results: 10,
      excerpts: {
        max_chars_per_result: 500
      }
    })
  });
  const data = await res.json();
  const elapsed = Date.now() - start;
  // Parallel pricing varies, estimate based on their docs
  return { data, elapsed, cost: data.cost || 0.08 };
}

async function main() {
  console.log(`\n🔍 Query: "${query}"\n`);
  console.log('─'.repeat(60));

  const [exa, parallel] = await Promise.all([
    searchExa(query).catch(e => ({ error: e.message, elapsed: 0 })),
    searchParallel(query).catch(e => ({ error: e.message, elapsed: 0 }))
  ]);

  // Exa results
  console.log('\n📘 EXA');
  console.log(`   Time: ${exa.elapsed}ms`);
  console.log(`   Cost: $${exa.cost?.toFixed(4) || 'N/A'}`);
  if (exa.error) {
    console.log(`   Error: ${exa.error}`);
  } else if (exa.data?.results) {
    console.log(`   Results: ${exa.data.results.length}`);
    exa.data.results.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i+1}. ${r.title || r.url}`);
      if (r.text) console.log(`      ${r.text.slice(0, 100)}...`);
    });
  } else {
    console.log('   Response:', JSON.stringify(exa.data, null, 2).slice(0, 500));
  }

  // Parallel results
  console.log('\n📗 PARALLEL');
  console.log(`   Time: ${parallel.elapsed}ms`);
  console.log(`   Cost: $${parallel.cost?.toFixed(4) || 'N/A'}`);
  if (parallel.error) {
    console.log(`   Error: ${parallel.error}`);
  } else if (parallel.data?.results) {
    console.log(`   Results: ${parallel.data.results.length}`);
    parallel.data.results.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i+1}. ${r.title || r.url}`);
      if (r.excerpt || r.text) console.log(`      ${(r.excerpt || r.text).slice(0, 100)}...`);
    });
  } else {
    console.log('   Response:', JSON.stringify(parallel.data, null, 2).slice(0, 500));
  }

  console.log('\n' + '─'.repeat(60));
  console.log('Summary:');
  console.log(`  Exa:      ${exa.elapsed}ms, $${exa.cost?.toFixed(4) || '?'}, ${exa.data?.results?.length || 0} results`);
  console.log(`  Parallel: ${parallel.elapsed}ms, $${parallel.cost?.toFixed(4) || '?'}, ${parallel.data?.results?.length || 0} results`);
}

main().catch(console.error);
