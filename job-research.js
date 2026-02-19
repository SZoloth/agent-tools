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
 *   job-research.js <company-name>                  # Research company (premium tier)
 *   job-research.js <company-name> --hm "PM title"  # Include HM search for role
 *   job-research.js <company-name> --json           # Output JSON only
 *   job-research.js <company-name> --output <dir>   # Save to directory
 *   job-research.js <company-name> --tier standard  # Brave Search only
 *   job-research.js <company-name> --tier premium   # EXA + Brave (default)
 *   job-research.js <company-name> --tier pinnacle  # EXA + deep content extraction
 *
 * Dependencies: brave-search/search.js, exa-search.js
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const SEARCH_CMD = path.join(process.env.HOME, "agent-tools/brave-search/search.js");
const EXA_CMD = path.join(process.env.HOME, "agent-tools/exa-search.js");

// Check if EXA is available
const EXA_AVAILABLE = !!process.env.EXA_API_KEY;

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
    console.error(`Brave search failed for "${query}": ${err.message}`);
    return [];
  }
}

function runExaSearch(query, options = {}) {
  if (!EXA_AVAILABLE) return [];

  try {
    const args = [query];
    if (options.type) args.push("--type", options.type);
    if (options.category) args.push("--category", options.category);
    if (options.numResults) args.push(`-n${options.numResults}`);
    args.push("--json");

    const output = execFileSync(EXA_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(output);
    if (data.error) {
      console.error(`EXA search error: ${data.error}`);
      return [];
    }
    return (data.results || []).map((r) => ({
      title: r.title || "No title",
      url: r.url,
      snippet: (r.text || "").slice(0, 300),
      content: r.text || null,
      source: "exa",
    }));
  } catch (err) {
    console.error(`EXA search failed for "${query}": ${err.message}`);
    return [];
  }
}

function runExaTemplate(template, arg, numResults = 5) {
  if (!EXA_AVAILABLE) return [];

  try {
    const args = ["--template", template, arg, `-n${numResults}`, "--json"];
    const output = execFileSync(EXA_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(output);
    if (data.error) {
      console.error(`EXA template error: ${data.error}`);
      return [];
    }
    return (data.results || []).map((r) => ({
      title: r.title || "No title",
      url: r.url,
      snippet: (r.text || "").slice(0, 300),
      content: r.text || null,
      source: "exa",
    }));
  } catch (err) {
    console.error(`EXA template "${template}" failed: ${err.message}`);
    return [];
  }
}

function runExaFindSimilar(url, numResults = 5) {
  if (!EXA_AVAILABLE) return [];

  try {
    const args = ["--similar", url, `-n${numResults}`, "--json"];
    const output = execFileSync(EXA_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(output);
    if (data.error) {
      console.error(`EXA findSimilar error: ${data.error}`);
      return [];
    }
    return (data.results || []).map((r) => ({
      title: r.title || "No title",
      url: r.url,
      snippet: (r.text || "").slice(0, 300),
      content: r.text || null,
      source: "exa",
    }));
  } catch (err) {
    console.error(`EXA findSimilar failed for "${url}": ${err.message}`);
    return [];
  }
}

function runExaGetContents(urls) {
  if (!EXA_AVAILABLE || urls.length === 0) return [];

  try {
    const args = ["--contents", ...urls, "--json"];
    const output = execFileSync(EXA_CMD, args, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
    const data = JSON.parse(output);
    if (data.error) {
      console.error(`EXA getContents error: ${data.error}`);
      return [];
    }
    return (data.results || data.contents || []).map((r) => ({
      title: r.title || "No title",
      url: r.url,
      snippet: (r.text || "").slice(0, 300),
      content: r.text || null,
      source: "exa",
    }));
  } catch (err) {
    console.error(`EXA getContents failed: ${err.message}`);
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
        source: "brave",
      });
    }
  }

  return results;
}

/**
 * Merge EXA results (higher quality) with Brave results, deduplicating by URL.
 * EXA results appear first.
 */
function mergeResults(exaResults, braveResults) {
  const seen = new Set();
  const merged = [];

  for (const r of exaResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }
  for (const r of braveResults) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  return merged;
}

// ============================================================================
// RESEARCH FUNCTIONS
// ============================================================================

async function searchCompanyInfo(company, tier) {
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
  let overviewResults = runSearch(`${company} company about funding employees`, 5);

  // EXA supplement for premium/pinnacle
  if (tier !== "standard") {
    const exaOverview = runExaSearch(`${company} company overview funding employees`, {
      type: "neural",
      numResults: 5,
    });
    overviewResults = mergeResults(exaOverview, overviewResults);
  }

  // Look for Crunchbase result for structured data
  const crunchbase = overviewResults.find((r) =>
    r.url.includes("crunchbase.com")
  );
  if (crunchbase) {
    results.crunchbaseUrl = crunchbase.url;
    const fundingMatch = crunchbase.snippet.match(
      /(?:raised|funding)\s+\$?([\d.]+[MBK]?)/i
    );
    if (fundingMatch) results.funding.amount = fundingMatch[1];

    const employeeMatch = crunchbase.snippet.match(
      /(\d+[-\u2013]\d+|\d+\+?)\s*employees/i
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

async function searchLeadership(company, tier) {
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

  // EXA: search for HM's actual writing (premium/pinnacle)
  if (tier !== "standard") {
    console.error(`  [EXA] Searching HM thought leadership...`);
    const hmContent = runExaTemplate("hm-content", company, 5);
    for (const r of hmContent) {
      if (r.snippet && r.snippet.length > 30) {
        leadership.ceo.recentPosts.push({
          platform: "exa",
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

  const hmTitles = deriveHMTitles(roleTitle);

  const searchTerms = `${company} ${hmTitles[0]}`;
  hmResults.searchQuery = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
    searchTerms
  )}`;

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

  if (lower.includes("product manager") || lower.includes(" pm")) {
    if (lower.includes("senior") || lower.includes("sr")) {
      titles.push("Director of Product", "VP Product", "Head of Product");
    } else if (lower.includes("principal") || lower.includes("group")) {
      titles.push("VP Product", "Chief Product Officer");
    } else {
      titles.push("Senior Product Manager", "Director of Product", "Head of Product");
    }
  } else if (lower.includes("engineer") || lower.includes("developer")) {
    if (lower.includes("senior") || lower.includes("staff")) {
      titles.push("Engineering Manager", "Director of Engineering");
    } else {
      titles.push("Engineering Manager", "Senior Engineering Manager");
    }
  } else if (lower.includes("design")) {
    titles.push("Head of Design", "Director of Design", "Design Manager");
  } else {
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

async function searchCompanyContent(company, tier) {
  console.error(`  Searching company content...`);

  const content = {
    blogPosts: [],
    podcasts: [],
    pressReleases: [],
  };

  // Brave search for blog posts
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
        source: "brave",
      });
    }
  }

  // EXA: engineering blog (premium/pinnacle)
  if (tier !== "standard") {
    console.error(`  [EXA] Searching engineering blog...`);
    const exaBlog = runExaTemplate("engineering-blog", company, 5);
    for (const r of exaBlog) {
      if (!content.blogPosts.find((b) => b.url === r.url)) {
        content.blogPosts.push({
          title: r.title,
          url: r.url,
          date: extractDate(r.snippet),
          source: "exa",
        });
      }
    }
  }

  // EXA: product intelligence (premium/pinnacle)
  if (tier !== "standard") {
    console.error(`  [EXA] Searching product intelligence...`);
    const exaProduct = runExaTemplate("product-intel", company, 5);
    for (const r of exaProduct) {
      if (!content.blogPosts.find((b) => b.url === r.url)) {
        content.blogPosts.push({
          title: r.title,
          url: r.url,
          date: extractDate(r.snippet),
          source: "exa",
        });
      }
    }
  }

  // EXA: industry analysis (premium/pinnacle)
  if (tier !== "standard") {
    console.error(`  [EXA] Searching industry analysis...`);
    const exaIndustry = runExaSearch(`${company} industry analysis strategy`, {
      category: "blog_post",
      numResults: 5,
    });
    for (const r of exaIndustry) {
      if (!content.blogPosts.find((b) => b.url === r.url)) {
        content.blogPosts.push({
          title: r.title,
          url: r.url,
          date: extractDate(r.snippet),
          source: "exa",
        });
      }
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

// Pinnacle-only: deep research with findSimilar and content extraction
async function searchDeepIntelligence(company, companyWebsite) {
  console.error(`  [EXA] Running deep intelligence (pinnacle)...`);

  const deep = {
    similarCompanies: [],
    deepContent: [],
    investorAnalysis: [],
  };

  // Find similar companies
  if (companyWebsite) {
    console.error(`  [EXA] Finding similar companies...`);
    const similar = runExaFindSimilar(companyWebsite, 5);
    deep.similarCompanies = similar.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet?.substring(0, 200) || "",
    }));
  }

  // Investor/funding analysis
  console.error(`  [EXA] Searching investor/funding intelligence...`);
  const investorResults = runExaSearch(`${company} funding investor letter`, {
    type: "neural",
    numResults: 5,
  });
  deep.investorAnalysis = investorResults.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet?.substring(0, 200) || "",
  }));

  return deep;
}

// Pinnacle-only: extract deep content from discovered URLs
async function extractDeepContent(allResults) {
  console.error(`  [EXA] Extracting deep content from top results...`);

  // Pick top URLs that have interesting content
  const urls = allResults
    .filter((r) => r.url && !r.url.includes("linkedin.com"))
    .slice(0, 5)
    .map((r) => r.url);

  if (urls.length === 0) return [];

  return runExaGetContents(urls);
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

async function runResearch(company, roleTitle = null, tier = "premium") {
  console.error(`\nResearching: ${company} (tier: ${tier})`);
  console.error("\u2500".repeat(40));

  if (tier !== "standard" && !EXA_AVAILABLE) {
    console.error("  WARNING: EXA_API_KEY not set. Falling back to Brave-only (standard tier).");
    tier = "standard";
  }

  const research = {
    company: await searchCompanyInfo(company, tier),
    leadership: await searchLeadership(company, tier),
    hiringManager: await searchHiringManager(company, roleTitle),
    companyContent: await searchCompanyContent(company, tier),
    news: await searchRecentNews(company),
    tier,
    researchedAt: new Date().toISOString(),
  };

  // Pinnacle: deep intelligence
  if (tier === "pinnacle") {
    research.deepIntelligence = await searchDeepIntelligence(
      company,
      research.company.website
    );

    // Collect all discovered URLs for deep content extraction
    const allResults = [
      ...research.companyContent.blogPosts,
      ...research.companyContent.pressReleases,
      ...research.news.map((n) => ({ url: n.url, title: n.headline })),
    ];
    const deepContent = await extractDeepContent(allResults);
    if (deepContent.length > 0) {
      research.deepIntelligence.deepContent = deepContent.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content?.substring(0, 1000) || "",
      }));
    }
  }

  console.error("\u2500".repeat(40));
  console.error("Research complete.\n");

  return research;
}

function formatResearchMarkdown(research) {
  const { company, leadership, hiringManager, companyContent, news } = research;

  let md = "";

  // Tier badge
  if (research.tier && research.tier !== "standard") {
    md += `> Research tier: **${research.tier}** (EXA semantic search enabled)\n\n`;
  }

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
      for (const post of leadership.ceo.recentPosts.slice(0, 3)) {
        const badge = post.platform === "exa" ? " [EXA]" : "";
        md += `- "${post.content.substring(0, 150)}..."${badge} ([source](${post.url}))\n`;
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
    md += `**Blog Posts & Analysis:**\n`;
    for (const post of companyContent.blogPosts.slice(0, 5)) {
      const badge = post.source === "exa" ? " [EXA]" : "";
      md += `- [${post.title}](${post.url})${post.date ? ` - ${post.date}` : ""}${badge}\n`;
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

  // Deep Intelligence (pinnacle only)
  if (research.deepIntelligence) {
    md += `\n### Deep Intelligence (Pinnacle)\n\n`;

    if (research.deepIntelligence.similarCompanies.length > 0) {
      md += `**Similar Companies:**\n`;
      for (const c of research.deepIntelligence.similarCompanies.slice(0, 5)) {
        md += `- [${c.title}](${c.url})\n`;
      }
      md += `\n`;
    }

    if (research.deepIntelligence.investorAnalysis.length > 0) {
      md += `**Investor/Funding Intelligence:**\n`;
      for (const r of research.deepIntelligence.investorAnalysis.slice(0, 3)) {
        md += `- [${r.title}](${r.url}): ${r.snippet?.substring(0, 100) || ""}...\n`;
      }
      md += `\n`;
    }

    if (research.deepIntelligence.deepContent?.length > 0) {
      md += `**Deep Content Extracts:**\n`;
      for (const r of research.deepIntelligence.deepContent.slice(0, 3)) {
        md += `- [${r.title}](${r.url}): ${r.content?.substring(0, 150) || ""}...\n`;
      }
      md += `\n`;
    }
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
  let tier = "premium";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--hm" && args[i + 1]) {
      roleTitle = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (arg === "--tier" && args[i + 1]) {
      tier = args[++i];
      if (!["standard", "premium", "pinnacle"].includes(tier)) {
        console.error(`Invalid tier: ${tier}. Use standard, premium, or pinnacle.`);
        process.exit(1);
      }
    } else if (!arg.startsWith("-")) {
      company = arg;
    }
  }

  if (!company) {
    console.log("Usage: job-research.js <company-name> [options]");
    console.log("");
    console.log("Options:");
    console.log('  --hm "role title"           Search for hiring manager candidates');
    console.log("  --json                      Output JSON only (no markdown)");
    console.log("  --output <dir>              Save research to directory");
    console.log("  --tier <standard|premium|pinnacle>");
    console.log("                              Research depth (default: premium)");
    console.log("");
    console.log("Tiers:");
    console.log("  standard   Brave Search only (fast, basic)");
    console.log("  premium    EXA semantic + Brave fallback (default)");
    console.log("  pinnacle   EXA + deep content extraction + similar companies");
    console.log("");
    console.log("Examples:");
    console.log('  job-research.js "Figma"');
    console.log('  job-research.js "Stripe" --hm "Senior Product Manager"');
    console.log('  job-research.js "Uber" --tier pinnacle --json');
    process.exit(1);
  }

  const research = await runResearch(company, roleTitle, tier);

  if (jsonOnly) {
    console.log(JSON.stringify(research, null, 2));
  } else {
    console.log("=== RESEARCH JSON ===");
    console.log(JSON.stringify(research, null, 2));
    console.log("\n=== RESEARCH MARKDOWN ===");
    console.log(formatResearchMarkdown(research));
  }

  // Save to output directory if specified
  if (outputDir) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
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
