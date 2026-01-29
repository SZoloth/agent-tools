#!/usr/bin/env node

/**
 * research-forum.js - Forum and review scraping for company research
 *
 * Extracts and tags content from:
 * - App store reviews (iOS App Store, Google Play)
 * - G2/Capterra reviews
 * - Company community forums
 * - Support forums and help sites
 *
 * Inspired by goHunt methodology: "scraped and analyzed hundreds of app store
 * reviews for GoHunt and Onix... figured out some of the major pain points."
 *
 * Usage:
 *   research-forum.js <company>                      # Auto-discover sources
 *   research-forum.js <company> --appstore           # Focus on app store reviews
 *   research-forum.js <company> --g2                 # Focus on G2/Capterra
 *   research-forum.js <company> --url <forum-url>    # Specific forum
 *   research-forum.js <company> --output <dir>       # Save to directory
 *   research-forum.js <company> --json               # Output JSON only
 *
 * Dependencies: Uses search.js from brave-search for web queries
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const SEARCH_CMD = path.join(process.env.HOME, "agent-tools/brave-search/search.js");

// Tag categories for review analysis
const TAG_PATTERNS = {
  ux: ["confusing", "intuitive", "easy to use", "hard to use", "ui", "interface", "design", "navigation", "layout"],
  performance: ["slow", "fast", "lag", "crash", "bug", "freeze", "responsive", "speed", "loading"],
  pricing: ["expensive", "cheap", "worth", "overpriced", "affordable", "value", "subscription", "free tier"],
  support: ["support", "help", "response", "customer service", "ticket", "documentation", "community"],
  features: ["feature", "missing", "wish", "want", "need", "add", "roadmap", "update"],
  reliability: ["reliable", "unreliable", "downtime", "stable", "outage", "trust", "depend"],
  integration: ["integrate", "api", "connect", "sync", "export", "import", "plugin", "extension"],
  onboarding: ["onboarding", "learning curve", "getting started", "tutorial", "documentation", "setup"],
  mobile: ["mobile", "app", "ios", "android", "phone", "tablet"],
  enterprise: ["enterprise", "team", "organization", "admin", "permissions", "security", "sso"],
};

// Sentiment keywords
const SENTIMENT = {
  positive: ["love", "amazing", "excellent", "perfect", "best", "great", "awesome", "fantastic", "recommend", "game changer"],
  negative: ["hate", "terrible", "awful", "worst", "horrible", "disappointed", "frustrating", "waste", "regret", "avoid"],
  neutral: ["okay", "fine", "average", "decent", "acceptable"],
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

function tagContent(text) {
  const lower = text.toLowerCase();
  const tags = [];

  for (const [tag, keywords] of Object.entries(TAG_PATTERNS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        tags.push(tag);
        break;
      }
    }
  }

  return [...new Set(tags)];
}

function analyzeSentiment(text) {
  const lower = text.toLowerCase();
  let positive = 0;
  let negative = 0;

  for (const word of SENTIMENT.positive) {
    if (lower.includes(word)) positive++;
  }
  for (const word of SENTIMENT.negative) {
    if (lower.includes(word)) negative++;
  }

  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
}

function extractRating(text) {
  // Look for star ratings in various formats
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/i, // "4.5 out of 5" or "4/5"
    /(\d+)\s*stars?/i, // "5 stars"
    /rating[:\s]+(\d+(?:\.\d+)?)/i, // "rating: 4.5"
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseFloat(match[1]);
    }
  }
  return null;
}

async function searchAppStoreReviews(company) {
  console.error(`  Searching app store reviews...`);

  const reviews = [];
  const queries = [
    `"${company}" app review site:apps.apple.com`,
    `"${company}" review site:play.google.com`,
    `"${company}" app store review`,
    `"${company}" mobile app review`,
  ];

  for (const query of queries) {
    const results = runSearch(query, 5, true);

    for (const r of results) {
      const text = r.snippet + " " + (r.content || "");
      reviews.push({
        source: r.url.includes("apple.com") ? "App Store" : r.url.includes("play.google.com") ? "Google Play" : "Review Site",
        title: r.title,
        url: r.url,
        content: r.snippet,
        rating: extractRating(text),
        sentiment: analyzeSentiment(text),
        tags: tagContent(text),
      });
    }
  }

  return reviews;
}

async function searchG2Reviews(company) {
  console.error(`  Searching G2/Capterra reviews...`);

  const reviews = [];
  const queries = [
    `"${company}" site:g2.com reviews`,
    `"${company}" site:capterra.com reviews`,
    `"${company}" site:trustradius.com reviews`,
    `"${company}" software review rating`,
  ];

  for (const query of queries) {
    const results = runSearch(query, 5, true);

    for (const r of results) {
      const text = r.snippet + " " + (r.content || "");
      let source = "Review Site";
      if (r.url.includes("g2.com")) source = "G2";
      if (r.url.includes("capterra.com")) source = "Capterra";
      if (r.url.includes("trustradius.com")) source = "TrustRadius";

      reviews.push({
        source,
        title: r.title,
        url: r.url,
        content: r.snippet,
        rating: extractRating(text),
        sentiment: analyzeSentiment(text),
        tags: tagContent(text),
      });
    }
  }

  return reviews;
}

async function searchCommunityForums(company) {
  console.error(`  Searching community forums...`);

  const posts = [];
  const queries = [
    `"${company}" community forum`,
    `"${company}" user forum discussion`,
    `"${company}" help forum`,
    `"${company}" feedback forum`,
    `site:community.${company.toLowerCase().replace(/\s+/g, "")}.com`,
  ];

  for (const query of queries) {
    const results = runSearch(query, 5, true);

    for (const r of results) {
      // Skip non-forum results
      if (!r.url.includes("community") && !r.url.includes("forum") && !r.url.includes("discuss")) {
        continue;
      }

      const text = r.snippet + " " + (r.content || "");
      posts.push({
        source: "Community Forum",
        title: r.title,
        url: r.url,
        content: r.snippet,
        sentiment: analyzeSentiment(text),
        tags: tagContent(text),
      });
    }
  }

  return posts;
}

async function searchSpecificForum(url) {
  console.error(`  Searching specific forum: ${url}...`);

  const posts = [];
  const domain = new URL(url).hostname;

  const results = runSearch(`site:${domain}`, 10, true);

  for (const r of results) {
    const text = r.snippet + " " + (r.content || "");
    posts.push({
      source: domain,
      title: r.title,
      url: r.url,
      content: r.snippet,
      sentiment: analyzeSentiment(text),
      tags: tagContent(text),
    });
  }

  return posts;
}

function buildTagMatrix(allContent) {
  const matrix = {};

  for (const tag of Object.keys(TAG_PATTERNS)) {
    matrix[tag] = {
      count: 0,
      positive: 0,
      negative: 0,
      neutral: 0,
      examples: [],
    };
  }

  for (const item of allContent) {
    for (const tag of item.tags) {
      if (!matrix[tag]) continue;
      matrix[tag].count++;
      matrix[tag][item.sentiment]++;
      if (matrix[tag].examples.length < 3 && item.content) {
        matrix[tag].examples.push({
          content: item.content.substring(0, 150),
          source: item.source,
          sentiment: item.sentiment,
        });
      }
    }
  }

  return matrix;
}

function formatResearchMarkdown(company, data) {
  const { appStoreReviews, g2Reviews, forumPosts, tagMatrix } = data;

  let md = `# Forum & Review Research: ${company}\n\n`;
  md += `**Sources analyzed:** ${appStoreReviews.length + g2Reviews.length + forumPosts.length} items\n`;
  md += `**Generated:** ${new Date().toISOString().split("T")[0]}\n\n`;

  // Tag matrix
  md += `## Tag Matrix\n\n`;
  md += `| Category | Mentions | Positive | Negative | Signal |\n`;
  md += `|----------|----------|----------|----------|--------|\n`;

  const sortedTags = Object.entries(tagMatrix)
    .sort((a, b) => b[1].count - a[1].count)
    .filter(([, data]) => data.count > 0);

  for (const [tag, data] of sortedTags) {
    const signal = data.negative > data.positive ? "⚠️ Issue" : data.positive > data.negative ? "✅ Strength" : "📍 Mixed";
    md += `| ${tag} | ${data.count} | ${data.positive} | ${data.negative} | ${signal} |\n`;
  }

  // Top issues
  md += `\n## Top Issues (Negative Sentiment)\n\n`;
  const issues = sortedTags.filter(([, d]) => d.negative > d.positive).slice(0, 3);
  for (const [tag, data] of issues) {
    md += `### ${tag.charAt(0).toUpperCase() + tag.slice(1)}\n\n`;
    for (const ex of data.examples.filter((e) => e.sentiment === "negative")) {
      md += `> "${ex.content}..." - ${ex.source}\n\n`;
    }
  }

  // Top strengths
  md += `## Top Strengths (Positive Sentiment)\n\n`;
  const strengths = sortedTags.filter(([, d]) => d.positive > d.negative).slice(0, 3);
  for (const [tag, data] of strengths) {
    md += `### ${tag.charAt(0).toUpperCase() + tag.slice(1)}\n\n`;
    for (const ex of data.examples.filter((e) => e.sentiment === "positive")) {
      md += `> "${ex.content}..." - ${ex.source}\n\n`;
    }
  }

  // Source breakdown
  md += `## Source Breakdown\n\n`;

  if (appStoreReviews.length > 0) {
    md += `### App Store Reviews (${appStoreReviews.length})\n\n`;
    for (const r of appStoreReviews.slice(0, 5)) {
      const ratingStr = r.rating ? ` (${r.rating}/5)` : "";
      md += `- [${r.title.substring(0, 50)}...](${r.url})${ratingStr} - ${r.sentiment}\n`;
    }
    md += `\n`;
  }

  if (g2Reviews.length > 0) {
    md += `### G2/Capterra Reviews (${g2Reviews.length})\n\n`;
    for (const r of g2Reviews.slice(0, 5)) {
      const ratingStr = r.rating ? ` (${r.rating}/5)` : "";
      md += `- [${r.title.substring(0, 50)}...](${r.url})${ratingStr} - ${r.sentiment}\n`;
    }
    md += `\n`;
  }

  if (forumPosts.length > 0) {
    md += `### Community Forum Posts (${forumPosts.length})\n\n`;
    for (const p of forumPosts.slice(0, 5)) {
      md += `- [${p.title.substring(0, 50)}...](${p.url}) - ${p.sentiment}\n`;
    }
  }

  return md;
}

async function main() {
  const args = process.argv.slice(2);

  let company = null;
  let focusAppStore = false;
  let focusG2 = false;
  let specificUrl = null;
  let outputDir = null;
  let jsonOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--appstore") {
      focusAppStore = true;
    } else if (arg === "--g2") {
      focusG2 = true;
    } else if (arg === "--url" && args[i + 1]) {
      specificUrl = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (!arg.startsWith("-")) {
      company = arg;
    }
  }

  if (!company) {
    console.log("Usage: research-forum.js <company> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --appstore           Focus on app store reviews");
    console.log("  --g2                 Focus on G2/Capterra reviews");
    console.log("  --url <forum-url>    Search specific forum URL");
    console.log("  --json               Output JSON only");
    console.log("  --output <dir>       Save research to directory");
    console.log("");
    console.log("Examples:");
    console.log('  research-forum.js "Figma"');
    console.log('  research-forum.js "Linear" --appstore');
    console.log('  research-forum.js "Notion" --g2 --output ./research');
    process.exit(1);
  }

  console.error(`\nForum Research: ${company}`);
  console.error("─".repeat(40));

  let appStoreReviews = [];
  let g2Reviews = [];
  let forumPosts = [];

  // Search based on focus
  if (!focusAppStore && !focusG2) {
    // Search everything
    appStoreReviews = await searchAppStoreReviews(company);
    g2Reviews = await searchG2Reviews(company);
    forumPosts = await searchCommunityForums(company);
  } else {
    if (focusAppStore) {
      appStoreReviews = await searchAppStoreReviews(company);
    }
    if (focusG2) {
      g2Reviews = await searchG2Reviews(company);
    }
  }

  if (specificUrl) {
    const specificPosts = await searchSpecificForum(specificUrl);
    forumPosts.push(...specificPosts);
  }

  const allContent = [...appStoreReviews, ...g2Reviews, ...forumPosts];
  const tagMatrix = buildTagMatrix(allContent);

  console.error(`  Found ${allContent.length} items`);
  console.error("─".repeat(40));
  console.error("Research complete.\n");

  const research = {
    company,
    appStoreReviews,
    g2Reviews,
    forumPosts,
    tagMatrix,
    summary: {
      totalItems: allContent.length,
      sentimentBreakdown: {
        positive: allContent.filter((c) => c.sentiment === "positive").length,
        negative: allContent.filter((c) => c.sentiment === "negative").length,
        neutral: allContent.filter((c) => c.sentiment === "neutral").length,
      },
    },
    researchedAt: new Date().toISOString(),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(research, null, 2));
  } else {
    console.log("=== RESEARCH JSON ===");
    console.log(JSON.stringify(research, null, 2));
    console.log("\n=== RESEARCH MARKDOWN ===");
    console.log(formatResearchMarkdown(company, research));
  }

  if (outputDir) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const jsonPath = path.join(outputDir, "forum-research.json");
    const mdPath = path.join(outputDir, "forum-matrix.md");
    fs.writeFileSync(jsonPath, JSON.stringify(research, null, 2));
    fs.writeFileSync(mdPath, formatResearchMarkdown(company, research));
    console.error(`\nSaved to: ${outputDir}`);
  }
}

export { searchAppStoreReviews, searchG2Reviews, searchCommunityForums, buildTagMatrix };

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
