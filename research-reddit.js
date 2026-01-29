#!/usr/bin/env node

/**
 * research-reddit.js - Reddit thread synthesis for company research
 *
 * Searches Reddit for company/product mentions, clusters discussions by theme,
 * and outputs a heatmap of topics, pain points, and opportunities.
 *
 * Inspired by goHunt guerrilla research methodology:
 * - Search relevant subreddits for company/product mentions
 * - Extract representative quotes that show real user sentiment
 * - Cluster discussions by theme (pain points, switching costs, etc.)
 * - Look for network effects, lock-in, and competitive insights
 *
 * Usage:
 *   research-reddit.js <company> <subreddit>          # Single subreddit
 *   research-reddit.js <company> -s "r/sub1,r/sub2"   # Multiple subreddits
 *   research-reddit.js <company> --discover           # Auto-discover subreddits
 *   research-reddit.js <company> --output <dir>       # Save to directory
 *   research-reddit.js <company> --json               # Output JSON only
 *
 * Dependencies: Uses search.js from brave-search for web queries
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const SEARCH_CMD = path.join(process.env.HOME, "agent-tools/brave-search/search.js");

// Theme categories for clustering discussions
const THEME_KEYWORDS = {
  painPoints: ["frustrating", "annoying", "hate", "terrible", "broken", "sucks", "disappointed", "useless", "waste", "problem", "issue", "bug"],
  switchingCosts: ["switching", "migrate", "transfer", "export", "import", "stuck", "locked", "trapped", "moving from"],
  networkEffects: ["everyone uses", "my friends use", "team uses", "share with", "collaborate", "together", "group"],
  pricing: ["expensive", "price", "cost", "worth", "value", "pay", "subscription", "tier", "free", "premium"],
  competitors: ["vs", "versus", "compared to", "better than", "worse than", "alternative", "instead of", "switched to", "switched from"],
  features: ["feature", "wish", "want", "need", "missing", "add", "should have", "would love", "please add"],
  praise: ["love", "amazing", "great", "excellent", "best", "recommend", "perfect", "game changer"],
};

function runSearch(query, numResults = 10, fetchContent = false) {
  try {
    const args = [query, "-n", String(numResults)];
    if (fetchContent) args.push("--content");

    const output = execFileSync(SEARCH_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseSearchResults(output);
  } catch (err) {
    console.error(`Search failed for "${query}": ${err.message}`);
    return [];
  }
}

function parseSearchResults(output) {
  const results = [];
  const blocks = output.split(/--- Result \d+ ---/).filter(Boolean);

  for (const block of blocks) {
    const titleMatch = block.match(/Title:\s*(.+)/);
    const linkMatch = block.match(/Link:\s*(.+)/);
    const snippetMatch = block.match(/Snippet:\s*(.+)/);
    const contentMatch = block.match(/Content:\n([\s\S]+?)(?=\n\n|$)/);

    if (titleMatch && linkMatch) {
      results.push({
        title: titleMatch[1].trim(),
        url: linkMatch[1].trim(),
        snippet: snippetMatch ? snippetMatch[1].trim() : "",
        content: contentMatch ? contentMatch[1].trim() : null,
      });
    }
  }

  return results;
}

function classifyTheme(text) {
  const lower = text.toLowerCase();
  const themes = [];

  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        themes.push(theme);
        break;
      }
    }
  }

  return themes.length > 0 ? themes : ["general"];
}

function extractQuotes(content) {
  if (!content) return [];

  const quotes = [];
  // Look for direct quotes or strong opinion statements
  const patterns = [
    /[""]([^""]+)[""]/, // Quoted text
    /\bI think\b[^.!?]+[.!?]/gi, // Opinion statements
    /\bThe (?:only|main|biggest) thing[^.!?]+[.!?]/gi, // Strong statements
    /\bI (?:love|hate|wish|want)[^.!?]+[.!?]/gi, // Sentiment statements
    /\bMy experience[^.!?]+[.!?]/gi, // Experience statements
  ];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      for (const match of matches) {
        const cleaned = match.replace(/[""\n]+/g, " ").trim();
        if (cleaned.length > 20 && cleaned.length < 300) {
          quotes.push(cleaned);
        }
      }
    }
  }

  return [...new Set(quotes)].slice(0, 3);
}

async function discoverSubreddits(company, productType = null) {
  console.error(`  Discovering relevant subreddits for ${company}...`);

  const subreddits = [];
  const queries = [
    `${company} site:reddit.com`,
    `${company} subreddit`,
  ];

  if (productType) {
    queries.push(`${productType} subreddit`);
  }

  for (const query of queries) {
    const results = runSearch(query, 5);
    for (const r of results) {
      // Extract subreddit from URL
      const match = r.url.match(/reddit\.com\/r\/([^\/]+)/);
      if (match && !subreddits.includes(match[1])) {
        subreddits.push(match[1]);
      }
    }
  }

  return subreddits.slice(0, 5);
}

async function searchSubreddit(company, subreddit, competitors = []) {
  console.error(`  Searching r/${subreddit} for ${company}...`);

  const threads = [];
  const queries = [
    `site:reddit.com/r/${subreddit} "${company}"`,
    `site:reddit.com/r/${subreddit} ${company} review`,
    `site:reddit.com/r/${subreddit} ${company} vs`,
  ];

  // Add competitor comparison queries
  for (const competitor of competitors.slice(0, 2)) {
    queries.push(`site:reddit.com/r/${subreddit} ${company} ${competitor}`);
  }

  for (const query of queries) {
    const results = runSearch(query, 5, true);

    for (const r of results) {
      if (!r.url.includes("reddit.com")) continue;

      const themes = classifyTheme(r.snippet + " " + (r.content || ""));
      const quotes = extractQuotes(r.content);

      threads.push({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        themes,
        quotes,
        subreddit,
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return threads.filter((t) => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });
}

function buildHeatmap(threads) {
  const heatmap = {};

  for (const theme of Object.keys(THEME_KEYWORDS)) {
    heatmap[theme] = {
      count: 0,
      threads: [],
      topQuotes: [],
    };
  }
  heatmap.general = { count: 0, threads: [], topQuotes: [] };

  for (const thread of threads) {
    for (const theme of thread.themes) {
      if (!heatmap[theme]) continue;
      heatmap[theme].count++;
      heatmap[theme].threads.push({
        title: thread.title,
        url: thread.url,
        subreddit: thread.subreddit,
      });
      heatmap[theme].topQuotes.push(...thread.quotes);
    }
  }

  // Deduplicate quotes and limit
  for (const theme of Object.keys(heatmap)) {
    heatmap[theme].topQuotes = [...new Set(heatmap[theme].topQuotes)].slice(0, 5);
  }

  return heatmap;
}

function formatHeatmapMarkdown(company, heatmap, threads) {
  let md = `# Reddit Research: ${company}\n\n`;
  md += `**Threads analyzed:** ${threads.length}\n`;
  md += `**Generated:** ${new Date().toISOString().split("T")[0]}\n\n`;

  md += `## Theme Heatmap\n\n`;
  md += `| Theme | Mentions | Signal |\n`;
  md += `|-------|----------|--------|\n`;

  const sortedThemes = Object.entries(heatmap)
    .sort((a, b) => b[1].count - a[1].count)
    .filter(([, data]) => data.count > 0);

  for (const [theme, data] of sortedThemes) {
    const signal = data.count >= 5 ? "🔥 High" : data.count >= 2 ? "⚡ Medium" : "📍 Low";
    md += `| ${theme} | ${data.count} | ${signal} |\n`;
  }

  md += `\n## Key Insights by Theme\n\n`;

  for (const [theme, data] of sortedThemes) {
    if (data.topQuotes.length === 0) continue;

    md += `### ${theme.charAt(0).toUpperCase() + theme.slice(1)}\n\n`;

    for (const quote of data.topQuotes.slice(0, 3)) {
      md += `> "${quote}"\n\n`;
    }

    if (data.threads.length > 0) {
      md += `**Source threads:**\n`;
      for (const t of data.threads.slice(0, 3)) {
        md += `- [${t.title.substring(0, 60)}...](${t.url}) (r/${t.subreddit})\n`;
      }
      md += `\n`;
    }
  }

  md += `## All Threads\n\n`;
  for (const thread of threads.slice(0, 15)) {
    md += `- [${thread.title}](${thread.url}) - r/${thread.subreddit}\n`;
    md += `  - Themes: ${thread.themes.join(", ")}\n`;
  }

  return md;
}

async function main() {
  const args = process.argv.slice(2);

  let company = null;
  let subreddits = [];
  let discover = false;
  let outputDir = null;
  let jsonOnly = false;
  let competitors = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" && args[i + 1]) {
      subreddits = args[++i].split(",").map((s) => s.replace(/^r\//, ""));
    } else if (arg === "--discover") {
      discover = true;
    } else if (arg === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (arg === "--competitors" && args[i + 1]) {
      competitors = args[++i].split(",");
    } else if (!arg.startsWith("-")) {
      if (!company) {
        company = arg;
      } else if (subreddits.length === 0) {
        subreddits.push(arg.replace(/^r\//, ""));
      }
    }
  }

  if (!company) {
    console.log("Usage: research-reddit.js <company> [subreddit] [options]");
    console.log("");
    console.log("Options:");
    console.log("  -s \"r/sub1,r/sub2\"    Search multiple subreddits");
    console.log("  --discover            Auto-discover relevant subreddits");
    console.log("  --competitors \"X,Y\"   Include competitor comparisons");
    console.log("  --json                Output JSON only");
    console.log("  --output <dir>        Save research to directory");
    console.log("");
    console.log("Examples:");
    console.log('  research-reddit.js "Figma" "r/FigmaDesign"');
    console.log('  research-reddit.js "Linear" --discover');
    console.log('  research-reddit.js "Notion" -s "r/Notion,r/productivity" --competitors "Obsidian,Roam"');
    process.exit(1);
  }

  console.error(`\nReddit Research: ${company}`);
  console.error("─".repeat(40));

  // Discover subreddits if needed
  if (discover || subreddits.length === 0) {
    const discovered = await discoverSubreddits(company);
    subreddits = [...new Set([...subreddits, ...discovered])];
    console.error(`  Discovered subreddits: ${subreddits.join(", ")}`);
  }

  if (subreddits.length === 0) {
    console.error("No subreddits found. Try specifying one explicitly.");
    process.exit(1);
  }

  // Search each subreddit
  const allThreads = [];
  for (const subreddit of subreddits) {
    const threads = await searchSubreddit(company, subreddit, competitors);
    allThreads.push(...threads);
  }

  console.error(`  Found ${allThreads.length} relevant threads`);

  // Build heatmap
  const heatmap = buildHeatmap(allThreads);

  console.error("─".repeat(40));
  console.error("Research complete.\n");

  const research = {
    company,
    subreddits,
    threadCount: allThreads.length,
    heatmap,
    threads: allThreads,
    researchedAt: new Date().toISOString(),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(research, null, 2));
  } else {
    console.log("=== RESEARCH JSON ===");
    console.log(JSON.stringify(research, null, 2));
    console.log("\n=== RESEARCH MARKDOWN ===");
    console.log(formatHeatmapMarkdown(company, heatmap, allThreads));
  }

  if (outputDir) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const jsonPath = path.join(outputDir, "reddit-research.json");
    const mdPath = path.join(outputDir, "reddit-heatmap.md");
    fs.writeFileSync(jsonPath, JSON.stringify(research, null, 2));
    fs.writeFileSync(mdPath, formatHeatmapMarkdown(company, heatmap, allThreads));
    console.error(`\nSaved to: ${outputDir}`);
  }
}

export { discoverSubreddits, searchSubreddit, buildHeatmap };

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
