#!/usr/bin/env node

/**
 * job-research.js - Automated company/HM/CEO research for job applications
 *
 * Uses web search to gather intelligence about:
 * - Company profile (funding, size, HQ, business model)
 * - Leadership (CEO/founders, recent public statements)
 * - Likely hiring managers (based on role title)
 * - Recent company content (blog, podcasts, news)
 *
 * Usage:
 *   job-research.js <company-name>                  # Research company
 *   job-research.js <company-name> --hm "PM title"  # Include HM search for role
 *   job-research.js <company-name> --json           # Output JSON only
 *   job-research.js <company-name> --output <dir>   # Save to directory
 *
 * Dependencies: Uses search.js from brave-search for web queries
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const SEARCH_CMD = path.join(process.env.HOME, "agent-tools/brave-search/search.js");

// ============================================================================
// SEARCH HELPERS
// ============================================================================

function runSearch(query, numResults = 5, fetchContent = false) {
  try {
    const args = [query, "-n", String(numResults)];
    if (fetchContent) args.push("--content");

    const output = execFileSync(SEARCH_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
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

// ============================================================================
// RESEARCH FUNCTIONS
// ============================================================================

async function searchCompanyInfo(company) {
  console.error(`  Searching company profile...`);

  const results = {
    name: company,
    website: null,
    founded: null,
    funding: { stage: null, amount: null, date: null },
    size: null,
    hq: null,
    description: null,
  };

  // Search for company overview
  const overviewResults = runSearch(`${company} company about funding employees`, 5);

  // Look for Crunchbase result for structured data
  const crunchbase = overviewResults.find((r) =>
    r.url.includes("crunchbase.com")
  );
  if (crunchbase) {
    results.crunchbaseUrl = crunchbase.url;
    // Extract info from snippet
    const fundingMatch = crunchbase.snippet.match(
      /(?:raised|funding)\s+\$?([\d.]+[MBK]?)/i
    );
    if (fundingMatch) results.funding.amount = fundingMatch[1];

    const employeeMatch = crunchbase.snippet.match(
      /(\d+[-–]\d+|\d+\+?)\s*employees/i
    );
    if (employeeMatch) results.size = employeeMatch[1] + " employees";
  }

  // Look for company website
  const companyDomain = overviewResults.find(
    (r) =>
      r.url.includes(company.toLowerCase().replace(/\s+/g, "")) &&
      !r.url.includes("linkedin") &&
      !r.url.includes("crunchbase") &&
      !r.url.includes("glassdoor")
  );
  if (companyDomain) {
    results.website = new URL(companyDomain.url).origin;
  }

  // Extract description from any result
  const descResult = overviewResults.find(
    (r) => r.snippet && r.snippet.length > 50
  );
  if (descResult) {
    results.description = descResult.snippet.substring(0, 300);
  }

  // Search for recent funding news
  const fundingResults = runSearch(`${company} funding round 2024 2025`, 3);
  for (const r of fundingResults) {
    const seriesMatch = r.snippet.match(
      /Series\s+([A-Z])|seed|pre-seed/i
    );
    const amountMatch = r.snippet.match(/\$(\d+(?:\.\d+)?)\s*(million|billion|M|B)/i);
    const dateMatch = r.snippet.match(
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|\d{4}/i
    );

    if (seriesMatch && !results.funding.stage) {
      results.funding.stage = seriesMatch[0];
    }
    if (amountMatch && !results.funding.amount) {
      results.funding.amount = `$${amountMatch[1]}${amountMatch[2].charAt(0).toUpperCase()}`;
    }
    if (dateMatch && !results.funding.date) {
      results.funding.date = dateMatch[0];
    }
  }

  return results;
}

async function searchLeadership(company) {
  console.error(`  Searching leadership...`);

  const leadership = {
    ceo: {
      name: null,
      linkedin: null,
      twitter: null,
      recentPosts: [],
    },
    relevantExecs: [],
  };

  // Search for CEO/founder
  const ceoResults = runSearch(`${company} CEO founder`, 5);

  for (const r of ceoResults) {
    // Look for name patterns
    const namePatterns = [
      /CEO\s+(?:and\s+)?(?:Co-)?[Ff]ounder\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/,
      /([A-Z][a-z]+\s+[A-Z][a-z]+),?\s+(?:the\s+)?CEO/,
      /(?:co-)?founder\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    ];

    for (const pattern of namePatterns) {
      const match = r.snippet.match(pattern) || r.title.match(pattern);
      if (match && !leadership.ceo.name) {
        leadership.ceo.name = match[1];
        break;
      }
    }

    // Check for LinkedIn
    if (r.url.includes("linkedin.com/in/") && !leadership.ceo.linkedin) {
      leadership.ceo.linkedin = r.url;
    }
  }

  // Search for CEO Twitter/X if we found a name
  if (leadership.ceo.name) {
    const twitterResults = runSearch(
      `${leadership.ceo.name} ${company} twitter OR x.com`,
      3
    );
    const twitterResult = twitterResults.find(
      (r) => r.url.includes("twitter.com") || r.url.includes("x.com")
    );
    if (twitterResult) {
      leadership.ceo.twitter = twitterResult.url;
    }

    // Search for recent CEO statements
    const statementsResults = runSearch(
      `"${leadership.ceo.name}" ${company} said interview 2024 2025`,
      3
    );
    for (const r of statementsResults) {
      if (r.snippet && r.snippet.length > 30) {
        leadership.ceo.recentPosts.push({
          platform: "web",
          content: r.snippet.substring(0, 200),
          url: r.url,
        });
      }
    }
  }

  // Search for other relevant execs (CPO, VP Product, etc.)
  const execResults = runSearch(
    `${company} "VP Product" OR "Chief Product" OR "Head of Product" site:linkedin.com`,
    3
  );
  for (const r of execResults) {
    if (r.url.includes("linkedin.com/in/")) {
      const nameMatch = r.title.match(/^([^-|]+)/);
      const titleMatch = r.snippet.match(
        /(VP|Vice President|Chief|Head|Director)\s+(?:of\s+)?Product/i
      );
      if (nameMatch) {
        leadership.relevantExecs.push({
          name: nameMatch[1].trim(),
          title: titleMatch ? titleMatch[0] : "Product Leader",
          linkedin: r.url,
        });
      }
    }
  }

  return leadership;
}

async function searchHiringManager(company, roleTitle) {
  console.error(`  Searching for hiring manager candidates...`);

  const hmResults = {
    candidates: [],
    searchQuery: null,
  };

  if (!roleTitle) {
    return hmResults;
  }

  // Derive likely HM titles from role
  const hmTitles = deriveHMTitles(roleTitle);

  // Build LinkedIn search URL for manual follow-up
  const searchTerms = `${company} ${hmTitles[0]}`;
  hmResults.searchQuery = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
    searchTerms
  )}`;

  // Search for each potential HM title
  for (const title of hmTitles.slice(0, 2)) {
    const results = runSearch(
      `${company} "${title}" site:linkedin.com`,
      3
    );

    for (const r of results) {
      if (r.url.includes("linkedin.com/in/")) {
        const nameMatch = r.title.match(/^([^-|]+)/);
        if (nameMatch) {
          const candidate = {
            name: nameMatch[1].trim(),
            title: extractTitle(r.snippet) || title,
            linkedin: r.url,
            confidence: title === hmTitles[0] ? "High - title match" : "Medium - org likely",
          };

          // Avoid duplicates
          if (!hmResults.candidates.find((c) => c.linkedin === candidate.linkedin)) {
            hmResults.candidates.push(candidate);
          }
        }
      }
    }
  }

  return hmResults;
}

function deriveHMTitles(roleTitle) {
  const lower = roleTitle.toLowerCase();
  const titles = [];

  // Product roles
  if (lower.includes("product manager") || lower.includes(" pm")) {
    if (lower.includes("senior") || lower.includes("sr")) {
      titles.push("Director of Product", "VP Product", "Head of Product");
    } else if (lower.includes("principal") || lower.includes("group")) {
      titles.push("VP Product", "Chief Product Officer");
    } else {
      titles.push("Senior Product Manager", "Director of Product", "Head of Product");
    }
  }
  // Engineering roles
  else if (lower.includes("engineer") || lower.includes("developer")) {
    if (lower.includes("senior") || lower.includes("staff")) {
      titles.push("Engineering Manager", "Director of Engineering");
    } else {
      titles.push("Engineering Manager", "Senior Engineering Manager");
    }
  }
  // Design roles
  else if (lower.includes("design")) {
    titles.push("Head of Design", "Director of Design", "Design Manager");
  }
  // Default
  else {
    titles.push("Director", "VP", "Head of");
  }

  return titles;
}

function extractTitle(snippet) {
  const patterns = [
    /((?:Senior\s+|Principal\s+|Staff\s+)?(?:Director|VP|Vice President|Head|Chief|Manager)\s+(?:of\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)/i,
    /((?:Senior\s+|Principal\s+)?Product\s+Manager)/i,
    /(Engineering\s+Manager)/i,
  ];

  for (const pattern of patterns) {
    const match = snippet.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function searchCompanyContent(company) {
  console.error(`  Searching company content...`);

  const content = {
    blogPosts: [],
    podcasts: [],
    pressReleases: [],
  };

  // Search for blog posts
  const blogResults = runSearch(`${company} blog engineering product 2024 2025`, 5);
  for (const r of blogResults) {
    if (
      r.url.includes("/blog") ||
      r.url.includes("medium.com") ||
      r.url.includes("engineering")
    ) {
      content.blogPosts.push({
        title: r.title,
        url: r.url,
        date: extractDate(r.snippet),
      });
    }
  }

  // Search for podcasts
  const podcastResults = runSearch(
    `${company} podcast interview CEO founder 2024 2025`,
    3
  );
  for (const r of podcastResults) {
    if (
      r.url.includes("podcast") ||
      r.url.includes("spotify") ||
      r.url.includes("youtube") ||
      r.snippet.toLowerCase().includes("podcast")
    ) {
      content.podcasts.push({
        title: r.title,
        url: r.url,
        date: extractDate(r.snippet),
      });
    }
  }

  // Search for press releases
  const pressResults = runSearch(`${company} announces launch press release 2024 2025`, 3);
  for (const r of pressResults) {
    if (
      r.url.includes("prnewswire") ||
      r.url.includes("businesswire") ||
      r.url.includes("techcrunch") ||
      r.url.includes("press")
    ) {
      content.pressReleases.push({
        title: r.title,
        url: r.url,
        date: extractDate(r.snippet),
      });
    }
  }

  return content;
}

async function searchRecentNews(company) {
  console.error(`  Searching recent news...`);

  const news = [];

  const newsResults = runSearch(`${company} news 2024 2025`, 5);

  for (const r of newsResults) {
    // Filter to likely news sources
    const newsIndicators = [
      "techcrunch",
      "reuters",
      "bloomberg",
      "wsj",
      "nytimes",
      "theverge",
      "wired",
      "forbes",
      "businessinsider",
      "venturebeat",
      "news",
    ];

    if (newsIndicators.some((ind) => r.url.toLowerCase().includes(ind))) {
      news.push({
        headline: r.title,
        source: new URL(r.url).hostname.replace("www.", ""),
        url: r.url,
        date: extractDate(r.snippet),
      });
    }
  }

  return news;
}

function extractDate(text) {
  if (!text) return null;

  const patterns = [
    /(\d{1,2}\s+(?:hours?|days?|weeks?)\s+ago)/i,
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/i,
    /(\d{4}-\d{2}-\d{2})/,
    /(Q[1-4]\s+\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ============================================================================
// MAIN
// ============================================================================

async function runResearch(company, roleTitle = null) {
  console.error(`\nResearching: ${company}`);
  console.error("─".repeat(40));

  const research = {
    company: await searchCompanyInfo(company),
    leadership: await searchLeadership(company),
    hiringManager: await searchHiringManager(company, roleTitle),
    companyContent: await searchCompanyContent(company),
    news: await searchRecentNews(company),
    researchedAt: new Date().toISOString(),
  };

  console.error("─".repeat(40));
  console.error("Research complete.\n");

  return research;
}

function formatResearchMarkdown(research) {
  const { company, leadership, hiringManager, companyContent, news } = research;

  let md = "";

  // Company Profile
  md += `### Company Profile\n\n`;
  md += `| Attribute | Value |\n`;
  md += `|-----------|-------|\n`;
  md += `| **Founded** | ${company.founded || "TBD"} |\n`;
  md += `| **Funding** | ${company.funding.stage || ""} ${company.funding.amount || "TBD"} ${company.funding.date ? `(${company.funding.date})` : ""} |\n`;
  md += `| **Employees** | ${company.size || "TBD"} |\n`;
  md += `| **HQ** | ${company.hq || "TBD"} |\n`;
  md += `| **Website** | ${company.website || "TBD"} |\n\n`;

  if (company.description) {
    md += `**Description:** ${company.description}\n\n`;
  }

  // Leadership
  md += `### Leadership\n\n`;
  if (leadership.ceo.name) {
    md += `**CEO/Founder:** ${leadership.ceo.name}`;
    if (leadership.ceo.linkedin) md += ` ([LinkedIn](${leadership.ceo.linkedin}))`;
    if (leadership.ceo.twitter) md += ` ([Twitter](${leadership.ceo.twitter}))`;
    md += `\n\n`;

    if (leadership.ceo.recentPosts.length > 0) {
      md += `**Recent Statements:**\n`;
      for (const post of leadership.ceo.recentPosts.slice(0, 2)) {
        md += `- "${post.content.substring(0, 150)}..." ([source](${post.url}))\n`;
      }
      md += `\n`;
    }
  } else {
    md += `*CEO/Founder: Research needed*\n\n`;
  }

  // Hiring Manager
  md += `### Likely Hiring Manager\n\n`;
  if (hiringManager.candidates.length > 0) {
    md += `| Priority | Name | Title | Confidence |\n`;
    md += `|----------|------|-------|------------|\n`;
    for (let i = 0; i < Math.min(hiringManager.candidates.length, 3); i++) {
      const c = hiringManager.candidates[i];
      md += `| ${i + 1} | [${c.name}](${c.linkedin}) | ${c.title} | ${c.confidence} |\n`;
    }
    md += `\n`;
  } else {
    md += `*No candidates found - manual search recommended*\n\n`;
  }

  if (hiringManager.searchQuery) {
    md += `**LinkedIn Search:** [Find more candidates](${hiringManager.searchQuery})\n\n`;
  }

  // Recent Company Content
  md += `### Recent Company Content\n\n`;
  let hasContent = false;

  if (companyContent.blogPosts.length > 0) {
    hasContent = true;
    md += `**Blog Posts:**\n`;
    for (const post of companyContent.blogPosts.slice(0, 3)) {
      md += `- [${post.title}](${post.url})${post.date ? ` - ${post.date}` : ""}\n`;
    }
    md += `\n`;
  }

  if (companyContent.podcasts.length > 0) {
    hasContent = true;
    md += `**Podcasts:**\n`;
    for (const podcast of companyContent.podcasts.slice(0, 2)) {
      md += `- [${podcast.title}](${podcast.url})${podcast.date ? ` - ${podcast.date}` : ""}\n`;
    }
    md += `\n`;
  }

  if (!hasContent) {
    md += `*No recent content found - check company blog/social media*\n\n`;
  }

  // Recent News
  md += `### Recent News\n\n`;
  if (news.length > 0) {
    for (const item of news.slice(0, 5)) {
      md += `- [${item.headline}](${item.url}) - ${item.source}${item.date ? ` (${item.date})` : ""}\n`;
    }
  } else {
    md += `*No recent news found*\n`;
  }

  return md;
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  let company = null;
  let roleTitle = null;
  let outputDir = null;
  let jsonOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--hm" && args[i + 1]) {
      roleTitle = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (!arg.startsWith("-")) {
      company = arg;
    }
  }

  if (!company) {
    console.log("Usage: job-research.js <company-name> [options]");
    console.log("");
    console.log("Options:");
    console.log('  --hm "role title"   Search for hiring manager candidates');
    console.log("  --json              Output JSON only (no markdown)");
    console.log("  --output <dir>      Save research to directory");
    console.log("");
    console.log("Examples:");
    console.log('  job-research.js "Figma"');
    console.log('  job-research.js "Stripe" --hm "Senior Product Manager"');
    console.log('  job-research.js "Uber" --json');
    process.exit(1);
  }

  const research = await runResearch(company, roleTitle);

  if (jsonOnly) {
    console.log(JSON.stringify(research, null, 2));
  } else {
    // Output both JSON and formatted markdown
    console.log("=== RESEARCH JSON ===");
    console.log(JSON.stringify(research, null, 2));
    console.log("\n=== RESEARCH MARKDOWN ===");
    console.log(formatResearchMarkdown(research));
  }

  // Save to output directory if specified
  if (outputDir) {
    const jsonPath = path.join(outputDir, "research.json");
    fs.writeFileSync(jsonPath, JSON.stringify(research, null, 2));
    console.error(`\nSaved research to: ${jsonPath}`);
  }
}

// Export for use as module
export { runResearch, formatResearchMarkdown };

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
