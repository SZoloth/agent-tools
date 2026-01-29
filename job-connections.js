#!/usr/bin/env node

/**
 * job-connections.js - LinkedIn connection mapper for job search
 *
 * Cross-references your LinkedIn connections CSV against a target company
 * to find referral opportunities (Never Search Alone methodology).
 *
 * Usage:
 *   job-connections.js "Figma"           # Search for connections at Figma
 *   job-connections.js "Figma" --json    # Output as JSON
 *   job-connections.js --list            # List all unique companies
 *   job-connections.js --stats           # Show connection statistics
 *
 * Data source: ~/Documents/LLM CONTEXT/1 - personal/crm/my-linkedin-connections.csv
 */

import fs from "fs";
import path from "path";

const CSV_PATH = path.join(
  process.env.HOME,
  "Documents/LLM CONTEXT/1 - personal/crm/my-linkedin-connections.csv"
);

// ============================================================================
// CSV PARSING
// ============================================================================

function parseCSV(content) {
  // Skip the notes at the top (first 3 lines)
  const lines = content.split("\n");

  // Find the header row (contains "First Name,Last Name,URL")
  let headerIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("First Name,Last Name,URL")) {
      headerIndex = i;
      break;
    }
  }

  const headers = parseCSVLine(lines[headerIndex]);
  const connections = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    if (values.length < headers.length) continue;

    const connection = {};
    headers.forEach((header, idx) => {
      connection[header.toLowerCase().replace(/ /g, "_")] = values[idx] || "";
    });

    connections.push(connection);
  }

  return connections;
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  return values;
}

// ============================================================================
// COMPANY MATCHING
// ============================================================================

function fuzzyMatch(searchTerm, company) {
  if (!company) return false;

  const search = searchTerm.toLowerCase().trim();
  const comp = company.toLowerCase().trim();

  // Exact match
  if (comp === search) return true;

  // Contains match
  if (comp.includes(search)) return true;

  // Word match (handles "DreamWorks Animation" matching "DreamWorks")
  const searchWords = search.split(/\s+/);
  const compWords = comp.split(/\s+/);

  for (const word of searchWords) {
    if (word.length >= 3 && compWords.some(cw => cw.includes(word))) {
      return true;
    }
  }

  // Handle common variations
  const variations = {
    "dreamworks": ["dreamworks animation", "dwanimation"],
    "meta": ["facebook", "meta platforms"],
    "google": ["alphabet", "google cloud", "google llc"],
    "microsoft": ["msft", "microsoft corporation"],
  };

  if (variations[search]) {
    for (const variant of variations[search]) {
      if (comp.includes(variant)) return true;
    }
  }

  return false;
}

function searchConnections(connections, company) {
  const matches = [];

  for (const conn of connections) {
    if (fuzzyMatch(company, conn.company)) {
      matches.push({
        name: `${conn.first_name} ${conn.last_name}`.trim(),
        position: conn.position || "Unknown",
        company: conn.company,
        linkedInUrl: conn.url,
        email: conn.email_address || null,
        connectedOn: conn.connected_on || null,
      });
    }
  }

  // Sort by connection date (most recent first)
  matches.sort((a, b) => {
    const dateA = parseDate(a.connectedOn);
    const dateB = parseDate(b.connectedOn);
    return dateB - dateA;
  });

  return matches;
}

function parseDate(dateStr) {
  if (!dateStr) return 0;

  // Format: "03 Jul 2025"
  const months = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  const parts = dateStr.split(" ");
  if (parts.length !== 3) return 0;

  const day = parseInt(parts[0]);
  const month = months[parts[1].toLowerCase()];
  const year = parseInt(parts[2]);

  if (isNaN(day) || month === undefined || isNaN(year)) return 0;

  return new Date(year, month, day).getTime();
}

// ============================================================================
// OUTPUT
// ============================================================================

function displayResults(company, matches, jsonOutput) {
  if (jsonOutput) {
    console.log(JSON.stringify({ company, connections: matches }, null, 2));
    return;
  }

  const boxWidth = 62;
  const line = "═".repeat(boxWidth);
  const divider = "─".repeat(45);

  console.log(`╔${line}╗`);
  console.log(`║  CONNECTIONS AT ${company.toUpperCase().padEnd(boxWidth - 18)}║`);
  console.log(`║  ${matches.length} found${" ".repeat(boxWidth - 10)}║`);
  console.log(`╠${line}╣`);

  if (matches.length === 0) {
    console.log(`║${" ".repeat(boxWidth)}║`);
    console.log(`║  No direct connections found.${" ".repeat(boxWidth - 32)}║`);
    console.log(`║${" ".repeat(boxWidth)}║`);
    console.log(`║  SUGGESTED ACTIONS${" ".repeat(boxWidth - 21)}║`);
    console.log(`║  ${divider}${" ".repeat(boxWidth - divider.length - 3)}║`);
    console.log(`║  1. Search LinkedIn for 2nd-degree connections${" ".repeat(boxWidth - 49)}║`);
    console.log(`║  2. Check if any mutual connections work there${" ".repeat(boxWidth - 49)}║`);
    console.log(`║  3. Use cold outreach via job posting${" ".repeat(boxWidth - 41)}║`);
    console.log(`║${" ".repeat(boxWidth)}║`);
  } else {
    console.log(`║${" ".repeat(boxWidth)}║`);
    console.log(`║  1st DEGREE CONNECTIONS${" ".repeat(boxWidth - 26)}║`);
    console.log(`║  ${divider}${" ".repeat(boxWidth - divider.length - 3)}║`);

    for (const conn of matches) {
      const nameLine = `  • ${conn.name} — ${conn.position}`;
      console.log(`║${nameLine.substring(0, boxWidth).padEnd(boxWidth)}║`);

      if (conn.connectedOn) {
        const dateLine = `    Connected: ${conn.connectedOn}`;
        console.log(`║${dateLine.padEnd(boxWidth)}║`);
      }

      if (conn.email) {
        const emailLine = `    Email: ${conn.email}`;
        console.log(`║${emailLine.padEnd(boxWidth)}║`);
      }

      console.log(`║${" ".repeat(boxWidth)}║`);
    }

    console.log(`║  SUGGESTED ACTIONS${" ".repeat(boxWidth - 21)}║`);
    console.log(`║  ${divider}${" ".repeat(boxWidth - divider.length - 3)}║`);

    const primaryConn = matches[0];
    const action1 = `  1. Reach out to ${primaryConn.name} for warm intro`;
    console.log(`║${action1.substring(0, boxWidth).padEnd(boxWidth)}║`);
    console.log(`║  2. Ask about team culture and hiring process${" ".repeat(boxWidth - 48)}║`);
    console.log(`║  3. Request referral if role is a good fit${" ".repeat(boxWidth - 45)}║`);
    console.log(`║${" ".repeat(boxWidth)}║`);
  }

  console.log(`╚${line}╝`);

  // Add NSA methodology note
  console.log(`\n📊 Never Search Alone: Warm intros have 40%+ response rate vs 2-5% cold`);
}

function listCompanies(connections) {
  const companies = new Map();

  for (const conn of connections) {
    if (conn.company) {
      const company = conn.company.trim();
      companies.set(company, (companies.get(company) || 0) + 1);
    }
  }

  const sorted = [...companies.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\nCompanies in your network (${sorted.length} unique):\n`);
  console.log("─".repeat(60));

  for (const [company, count] of sorted.slice(0, 50)) {
    console.log(`${count.toString().padStart(3)} │ ${company}`);
  }

  if (sorted.length > 50) {
    console.log(`\n... and ${sorted.length - 50} more`);
  }

  console.log("─".repeat(60));
  console.log(`Total connections: ${connections.length}`);
}

function showStats(connections) {
  const companies = new Map();
  const months = new Map();

  for (const conn of connections) {
    if (conn.company) {
      companies.set(conn.company, (companies.get(conn.company) || 0) + 1);
    }
    if (conn.connected_on) {
      const parts = conn.connected_on.split(" ");
      if (parts.length === 3) {
        const monthYear = `${parts[1]} ${parts[2]}`;
        months.set(monthYear, (months.get(monthYear) || 0) + 1);
      }
    }
  }

  console.log(`\nLinkedIn Connection Statistics\n`);
  console.log("─".repeat(40));
  console.log(`Total connections: ${connections.length}`);
  console.log(`Unique companies: ${companies.size}`);
  console.log(`With email: ${connections.filter(c => c.email_address).length}`);
  console.log("─".repeat(40));

  const topCompanies = [...companies.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`\nTop 10 Companies:`);
  for (const [company, count] of topCompanies) {
    console.log(`  ${count.toString().padStart(3)} │ ${company}`);
  }

  console.log(`\nRecent connection activity:`);
  const recentMonths = [...months.entries()].slice(0, 6);
  for (const [month, count] of recentMonths) {
    console.log(`  ${month}: ${count} new connections`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: job-connections.js <company> [--json]");
    console.log("       job-connections.js --list");
    console.log("       job-connections.js --stats");
    process.exit(1);
  }

  // Load CSV
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Error: LinkedIn connections CSV not found at:\n${CSV_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_PATH, "utf8");
  const connections = parseCSV(content);

  // Parse arguments
  const jsonOutput = args.includes("--json");
  const listMode = args.includes("--list");
  const statsMode = args.includes("--stats");

  if (listMode) {
    listCompanies(connections);
    return;
  }

  if (statsMode) {
    showStats(connections);
    return;
  }

  // Get company name (first non-flag argument)
  const company = args.find(arg => !arg.startsWith("--"));

  if (!company) {
    console.error("Error: Please provide a company name to search");
    process.exit(1);
  }

  const matches = searchConnections(connections, company);
  displayResults(company, matches, jsonOutput);
}

main();
