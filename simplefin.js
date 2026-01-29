#!/usr/bin/env node

/**
 * SimpleFIN Direct CLI
 * Query bank accounts and transactions directly from SimpleFIN Bridge
 *
 * Usage:
 *   simplefin.js                      # All accounts with balances
 *   simplefin.js --transactions       # Include recent transactions (30 days)
 *   simplefin.js --transactions 7d    # Transactions from last 7 days
 *   simplefin.js --account chase      # Filter by account name (case-insensitive)
 *   simplefin.js --json               # Output raw JSON
 */

const https = require('https');
const url = require('url');

// Access URL from Firefly III importer config
const ACCESS_URL = process.env.SIMPLEFIN_ACCESS_URL ||
  'https://862E7B9C0463779AB712E90904F205144A2084CB98509A38FA9E945F6D7915ED:B1B2FC7839FF87BCEA3BCB6CB49B4BDAAAB8A34C24E625B296538E56FAF2B071@beta-bridge.simplefin.org/simplefin';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    showTransactions: false,
    days: 30,
    accountFilter: null,
    jsonOutput: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--transactions' || arg === '-t') {
      opts.showTransactions = true;
      // Check if next arg is a duration like "7d"
      const next = args[i + 1];
      if (next && /^\d+d$/.test(next)) {
        opts.days = parseInt(next);
        i++;
      }
    } else if (arg === '--account' || arg === '-a') {
      opts.accountFilter = args[++i]?.toLowerCase();
    } else if (arg === '--json' || arg === '-j') {
      opts.jsonOutput = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`SimpleFIN Direct CLI

Usage:
  simplefin.js                      # All accounts with balances
  simplefin.js --transactions       # Include recent transactions (30 days)
  simplefin.js --transactions 7d    # Transactions from last 7 days
  simplefin.js --account chase      # Filter by account name
  simplefin.js --json               # Output raw JSON

Options:
  -t, --transactions [Nd]   Show transactions (default: 30 days)
  -a, --account NAME        Filter accounts by name (case-insensitive)
  -j, --json                Output raw JSON
  -h, --help                Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

async function fetchAccounts(opts) {
  const parsed = new URL(ACCESS_URL);
  const accountsUrl = `${parsed.origin}${parsed.pathname}/accounts`;

  // Build query params
  const params = new URLSearchParams();
  if (opts.showTransactions) {
    const startDate = Math.floor(Date.now() / 1000) - (opts.days * 24 * 60 * 60);
    params.set('start-date', startDate.toString());
  }

  const fullUrl = `${accountsUrl}?${params.toString()}`;
  const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');

  return new Promise((resolve, reject) => {
    const reqUrl = new URL(fullUrl);
    const options = {
      hostname: reqUrl.hostname,
      path: reqUrl.pathname + reqUrl.search,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  }).format(amount);
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function displayResults(data, opts) {
  if (opts.jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const accounts = data.accounts || [];
  let filtered = accounts;

  if (opts.accountFilter) {
    filtered = accounts.filter(a =>
      a.name?.toLowerCase().includes(opts.accountFilter) ||
      a.org?.name?.toLowerCase().includes(opts.accountFilter)
    );
  }

  if (filtered.length === 0) {
    console.log('No accounts found' + (opts.accountFilter ? ` matching "${opts.accountFilter}"` : ''));
    return;
  }

  // Group by organization
  const byOrg = {};
  for (const acct of filtered) {
    const org = acct.org?.name || 'Unknown';
    if (!byOrg[org]) byOrg[org] = [];
    byOrg[org].push(acct);
  }

  let totalBalance = 0;

  for (const [org, accts] of Object.entries(byOrg)) {
    console.log(`\n═══ ${org} ═══`);

    for (const acct of accts) {
      const balance = parseFloat(acct.balance);
      totalBalance += balance;
      const balanceStr = formatCurrency(balance, acct.currency);
      const available = acct['available-balance'] ? ` (avail: ${formatCurrency(acct['available-balance'], acct.currency)})` : '';

      console.log(`\n  ${acct.name}`);
      console.log(`  Balance: ${balanceStr}${available}`);

      if (opts.showTransactions && acct.transactions?.length > 0) {
        console.log(`  ─── Recent Transactions ───`);
        const txns = acct.transactions.slice(0, 10); // Limit to 10 most recent
        for (const txn of txns) {
          const date = formatDate(txn.posted || txn.transacted_at);
          const amount = formatCurrency(parseFloat(txn.amount), acct.currency);
          const desc = (txn.description || txn.payee || 'Unknown').substring(0, 40);
          const sign = txn.amount >= 0 ? '+' : '';
          console.log(`    ${date}  ${sign}${amount.padStart(12)}  ${desc}`);
        }
        if (acct.transactions.length > 10) {
          console.log(`    ... and ${acct.transactions.length - 10} more`);
        }
      }
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Total: ${formatCurrency(totalBalance)}`);
}

async function main() {
  const opts = parseArgs();

  try {
    const data = await fetchAccounts(opts);
    displayResults(data, opts);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
