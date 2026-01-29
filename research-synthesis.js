#!/usr/bin/env node

/**
 * research-synthesis.js - Multi-channel research synthesis
 *
 * Combines research from multiple channels into strategic insights:
 * - Reddit research (research-reddit.js output)
 * - Forum/review research (research-forum.js output)
 * - Company research (job-research.js output)
 * - Manual notes
 *
 * Outputs a structured insights document with:
 * - 3-5 synthesized strategic insights
 * - Evidence supporting each insight
 * - Product/growth recommendations
 * - Key quotes that tell the story
 *
 * Inspired by goHunt: "rivaled big consulting—delivered in days, not months"
 *
 * Usage:
 *   research-synthesis.js <company-dir>              # Read from company folder
 *   research-synthesis.js --reddit <file> --forum <file> --research <file>
 *   research-synthesis.js <company-dir> --output <dir>
 *
 * Dependencies: Reads JSON files from research tools
 */

import fs from "fs";
import path from "path";

// Insight categories for synthesis
const INSIGHT_CATEGORIES = {
  valueProposition: {
    label: "Value Proposition Gap",
    description: "What users actually value vs. what company thinks they value",
    signals: ["pricing", "features", "competitors", "praise", "painPoints"],
  },
  switchingCosts: {
    label: "Switching & Lock-in",
    description: "What keeps users on platform or prevents switching",
    signals: ["switchingCosts", "networkEffects", "integration"],
  },
  competitivePosition: {
    label: "Competitive Position",
    description: "How company is positioned vs. competitors",
    signals: ["competitors", "features", "pricing"],
  },
  userExperience: {
    label: "User Experience Issues",
    description: "Critical UX/product gaps affecting adoption or retention",
    signals: ["ux", "onboarding", "performance", "mobile"],
  },
  growthOpportunity: {
    label: "Growth Opportunity",
    description: "Untapped segments, features, or positioning",
    signals: ["features", "networkEffects", "enterprise", "mobile"],
  },
};

function loadJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

function findResearchFiles(dir) {
  const files = {
    reddit: null,
    forum: null,
    research: null,
  };

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower.includes("reddit") && entry.endsWith(".json")) {
      files.reddit = path.join(dir, entry);
    } else if (lower.includes("forum") && entry.endsWith(".json")) {
      files.forum = path.join(dir, entry);
    } else if (lower === "research.json" || (lower.includes("research") && entry.endsWith(".json"))) {
      files.research = path.join(dir, entry);
    }
  }

  return files;
}

function extractKeyEvidence(data) {
  const evidence = {
    quotes: [],
    signals: {},
    sources: [],
  };

  // Extract from Reddit research
  if (data.reddit) {
    evidence.sources.push(`Reddit (${data.reddit.threadCount || 0} threads)`);

    // Get quotes from heatmap
    if (data.reddit.heatmap) {
      for (const [theme, info] of Object.entries(data.reddit.heatmap)) {
        if (!evidence.signals[theme]) {
          evidence.signals[theme] = { count: 0, strength: "low" };
        }
        evidence.signals[theme].count += info.count || 0;

        // Add top quotes
        if (info.topQuotes) {
          for (const quote of info.topQuotes.slice(0, 2)) {
            evidence.quotes.push({
              text: quote,
              source: "Reddit",
              theme,
            });
          }
        }
      }
    }
  }

  // Extract from Forum research
  if (data.forum) {
    const itemCount = (data.forum.appStoreReviews?.length || 0) +
                     (data.forum.g2Reviews?.length || 0) +
                     (data.forum.forumPosts?.length || 0);
    evidence.sources.push(`Reviews (${itemCount} items)`);

    // Get signals from tag matrix
    if (data.forum.tagMatrix) {
      for (const [tag, info] of Object.entries(data.forum.tagMatrix)) {
        if (!evidence.signals[tag]) {
          evidence.signals[tag] = { count: 0, positive: 0, negative: 0 };
        }
        evidence.signals[tag].count += info.count || 0;
        evidence.signals[tag].positive += info.positive || 0;
        evidence.signals[tag].negative += info.negative || 0;

        // Add example quotes
        if (info.examples) {
          for (const ex of info.examples.slice(0, 1)) {
            evidence.quotes.push({
              text: ex.content,
              source: ex.source,
              theme: tag,
              sentiment: ex.sentiment,
            });
          }
        }
      }
    }
  }

  // Extract from company research
  if (data.research) {
    evidence.sources.push("Company Research");

    // Add CEO quotes
    if (data.research.leadership?.ceo?.recentPosts) {
      for (const post of data.research.leadership.ceo.recentPosts.slice(0, 2)) {
        evidence.quotes.push({
          text: post.content,
          source: "CEO Statement",
          theme: "leadership",
        });
      }
    }
  }

  // Calculate signal strength
  for (const [signal, info] of Object.entries(evidence.signals)) {
    if (info.count >= 5) {
      info.strength = "high";
    } else if (info.count >= 2) {
      info.strength = "medium";
    }
  }

  return evidence;
}

function generateInsights(company, evidence, data) {
  const insights = [];

  // Analyze signals to generate insights
  const signalStrengths = Object.entries(evidence.signals)
    .map(([signal, info]) => ({ signal, ...info }))
    .sort((a, b) => b.count - a.count);

  // Value Proposition insight
  const pricingSignal = evidence.signals.pricing;
  const featuresSignal = evidence.signals.features;
  const competitorSignal = evidence.signals.competitors;

  if (pricingSignal?.count > 0 || featuresSignal?.count > 0) {
    const quotes = evidence.quotes
      .filter((q) => ["pricing", "features", "competitors"].includes(q.theme))
      .slice(0, 2);

    const negativeCount = (pricingSignal?.negative || 0) + (featuresSignal?.negative || 0);
    const hasIssue = negativeCount > 0;

    insights.push({
      category: "valueProposition",
      title: hasIssue
        ? `Value perception mismatch: users question ${company}'s pricing vs. delivered value`
        : `Clear value proposition: users understand what ${company} offers`,
      evidence: [
        `Pricing mentions: ${pricingSignal?.count || 0} (${pricingSignal?.negative || 0} negative)`,
        `Feature requests: ${featuresSignal?.count || 0}`,
        `Competitor comparisons: ${competitorSignal?.count || 0}`,
      ],
      quotes: quotes.map((q) => q.text),
      strength: hasIssue ? "issue" : "strength",
    });
  }

  // Switching/Lock-in insight
  const switchingSignal = evidence.signals.switchingCosts;
  const networkSignal = evidence.signals.networkEffects;
  const integrationSignal = evidence.signals.integration;

  if (switchingSignal?.count > 0 || networkSignal?.count > 0 || integrationSignal?.count > 0) {
    const quotes = evidence.quotes
      .filter((q) => ["switchingCosts", "networkEffects", "integration"].includes(q.theme))
      .slice(0, 2);

    insights.push({
      category: "switchingCosts",
      title: networkSignal?.count > switchingSignal?.count
        ? `Network effects drive retention: users stay because their team/community uses ${company}`
        : `High switching costs: data/workflow lock-in keeps users on ${company}`,
      evidence: [
        `Switching mentions: ${switchingSignal?.count || 0}`,
        `Network effects: ${networkSignal?.count || 0}`,
        `Integration lock-in: ${integrationSignal?.count || 0}`,
      ],
      quotes: quotes.map((q) => q.text),
      strength: "insight",
    });
  }

  // UX/Product insight
  const uxSignal = evidence.signals.ux;
  const performanceSignal = evidence.signals.performance;
  const onboardingSignal = evidence.signals.onboarding;

  if (uxSignal?.count > 0 || performanceSignal?.count > 0) {
    const quotes = evidence.quotes
      .filter((q) => ["ux", "performance", "onboarding"].includes(q.theme))
      .slice(0, 2);

    const totalIssues = (uxSignal?.negative || 0) + (performanceSignal?.negative || 0);
    const hasIssue = totalIssues > 0;

    insights.push({
      category: "userExperience",
      title: hasIssue
        ? `Product friction: users report ${totalIssues} UX/performance issues`
        : `Strong product experience: users praise ${company}'s UX`,
      evidence: [
        `UX mentions: ${uxSignal?.count || 0} (${uxSignal?.negative || 0} negative)`,
        `Performance: ${performanceSignal?.count || 0} (${performanceSignal?.negative || 0} negative)`,
        `Onboarding: ${onboardingSignal?.count || 0}`,
      ],
      quotes: quotes.map((q) => q.text),
      strength: hasIssue ? "issue" : "strength",
    });
  }

  // Growth opportunity insight
  const enterpriseSignal = evidence.signals.enterprise;
  const mobileSignal = evidence.signals.mobile;

  if (enterpriseSignal?.count > 0 || mobileSignal?.count > 0) {
    const quotes = evidence.quotes
      .filter((q) => ["enterprise", "mobile"].includes(q.theme))
      .slice(0, 2);

    insights.push({
      category: "growthOpportunity",
      title: enterpriseSignal?.count > mobileSignal?.count
        ? `Enterprise expansion: ${enterpriseSignal.count} mentions of team/org needs`
        : `Mobile opportunity: ${mobileSignal?.count || 0} mentions of mobile experience`,
      evidence: [
        `Enterprise mentions: ${enterpriseSignal?.count || 0}`,
        `Mobile mentions: ${mobileSignal?.count || 0}`,
      ],
      quotes: quotes.map((q) => q.text),
      strength: "opportunity",
    });
  }

  return insights.slice(0, 5);
}

function generateRecommendations(insights) {
  const recommendations = [];

  for (const insight of insights) {
    if (insight.strength === "issue") {
      switch (insight.category) {
        case "valueProposition":
          recommendations.push({
            priority: "high",
            action: "Clarify value proposition and pricing alignment",
            detail: "Users are questioning the value received for the price. Consider tiered pricing, clearer feature differentiation, or value communication improvements.",
            businessImpact: [
              "Reduce pricing-related churn by 10-15%",
              "Improve trial-to-paid conversion through clearer value communication",
              "Unlock pricing flexibility with tiered offerings",
            ],
            quickWins: [
              "A/B test updated pricing page copy",
              "Survey churned users on value perception",
              "Add feature comparison table to pricing page",
            ],
          });
          break;
        case "userExperience":
          recommendations.push({
            priority: "high",
            action: "Address critical UX/performance issues",
            detail: "Product friction is creating negative sentiment. Prioritize the most-mentioned pain points in upcoming sprints.",
            businessImpact: [
              "Reduce support ticket volume by addressing common friction points",
              "Improve NPS scores through better user experience",
              "Increase daily active usage through reduced friction",
            ],
            quickWins: [
              "Prioritize top 3 most-mentioned UX issues for next sprint",
              "Add progress indicators to slow-loading flows",
              "Implement quick-win UI polish on critical paths",
            ],
          });
          break;
      }
    } else if (insight.strength === "opportunity") {
      switch (insight.category) {
        case "growthOpportunity":
          recommendations.push({
            priority: "medium",
            action: "Explore expansion opportunity",
            detail: "User feedback indicates demand for enterprise features or improved mobile experience. Validate with targeted interviews.",
            businessImpact: [
              "Open new revenue stream from underserved segment",
              "Increase wallet share from existing customers",
              "Strengthen competitive moat in target market",
            ],
            quickWins: [
              "Interview 10 users requesting this capability",
              "Analyze competitor offerings in this space",
              "Prototype minimal viable feature for validation",
            ],
          });
          break;
      }
    } else if (insight.strength === "strength") {
      recommendations.push({
        priority: "low",
        action: `Leverage ${insight.category} as differentiator`,
        detail: "Users praise this aspect. Double down in marketing and positioning.",
        businessImpact: [
          "Strengthen brand differentiation in crowded market",
          "Reduce CAC by leading with proven value prop",
          "Increase word-of-mouth referrals from satisfied users",
        ],
        quickWins: [
          "Update landing page to feature this strength prominently",
          "Collect testimonials highlighting this capability",
          "Create case study showing this value in action",
        ],
      });
    }
  }

  return recommendations;
}

function formatSynthesisMarkdown(company, insights, recommendations, evidence) {
  let md = `# Strategic Insights: ${company}\n\n`;
  md += `**Sources:** ${evidence.sources.join(", ")}\n`;
  md += `**Generated:** ${new Date().toISOString().split("T")[0]}\n\n`;

  md += `---\n\n`;
  md += `## Executive Summary\n\n`;
  md += `Analysis of ${evidence.quotes.length} user quotes across ${evidence.sources.length} channels reveals:\n\n`;

  for (const insight of insights) {
    const icon = insight.strength === "issue" ? "⚠️" : insight.strength === "opportunity" ? "🚀" : "✅";
    md += `- ${icon} **${insight.title}**\n`;
  }

  md += `\n## Key Insights\n\n`;

  for (let i = 0; i < insights.length; i++) {
    const insight = insights[i];
    const icon = insight.strength === "issue" ? "⚠️" : insight.strength === "opportunity" ? "🚀" : "✅";

    md += `### ${i + 1}. ${icon} ${insight.title}\n\n`;

    md += `**Evidence:**\n`;
    for (const e of insight.evidence) {
      md += `- ${e}\n`;
    }
    md += `\n`;

    if (insight.quotes.length > 0) {
      md += `**User Voices:**\n`;
      for (const q of insight.quotes) {
        md += `> "${q}"\n\n`;
      }
    }
  }

  md += `## Recommendations\n\n`;

  for (let i = 0; i < recommendations.length; i++) {
    const rec = recommendations[i];
    const emoji = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";

    md += `### ${i + 1}. ${emoji} ${rec.action}\n\n`;
    md += `${rec.detail}\n\n`;

    if (rec.businessImpact?.length > 0) {
      md += `**Business Impact:**\n`;
      for (const impact of rec.businessImpact) {
        md += `- ${impact}\n`;
      }
      md += `\n`;
    }

    if (rec.quickWins?.length > 0) {
      md += `**Quick Wins:**\n`;
      for (const win of rec.quickWins) {
        md += `- ${win}\n`;
      }
      md += `\n`;
    }
  }

  md += `\n## All Evidence Quotes\n\n`;

  const quotesByTheme = {};
  for (const q of evidence.quotes) {
    if (!quotesByTheme[q.theme]) {
      quotesByTheme[q.theme] = [];
    }
    quotesByTheme[q.theme].push(q);
  }

  for (const [theme, quotes] of Object.entries(quotesByTheme)) {
    md += `### ${theme.charAt(0).toUpperCase() + theme.slice(1)}\n\n`;
    for (const q of quotes.slice(0, 3)) {
      md += `> "${q.text}" - *${q.source}*\n\n`;
    }
  }

  md += `---\n\n`;
  md += `*This research follows the goHunt methodology: deep, multi-channel insights delivered in days, not months.*\n`;

  return md;
}

async function main() {
  const args = process.argv.slice(2);

  let companyDir = null;
  let redditFile = null;
  let forumFile = null;
  let researchFile = null;
  let outputDir = null;
  let jsonOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--reddit" && args[i + 1]) {
      redditFile = args[++i];
    } else if (arg === "--forum" && args[i + 1]) {
      forumFile = args[++i];
    } else if (arg === "--research" && args[i + 1]) {
      researchFile = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg === "--json") {
      jsonOnly = true;
    } else if (!arg.startsWith("-")) {
      companyDir = arg;
    }
  }

  if (!companyDir && !redditFile && !forumFile && !researchFile) {
    console.log("Usage: research-synthesis.js <company-dir> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --reddit <file>      Reddit research JSON file");
    console.log("  --forum <file>       Forum research JSON file");
    console.log("  --research <file>    Company research JSON file");
    console.log("  --json               Output JSON only");
    console.log("  --output <dir>       Save synthesis to directory");
    console.log("");
    console.log("Examples:");
    console.log("  research-synthesis.js ./companies/figma/");
    console.log("  research-synthesis.js --reddit reddit.json --forum forum.json");
    process.exit(1);
  }

  // Find files from directory if provided
  if (companyDir) {
    const files = findResearchFiles(companyDir);
    if (!redditFile) redditFile = files.reddit;
    if (!forumFile) forumFile = files.forum;
    if (!researchFile) researchFile = files.research;
    if (!outputDir) outputDir = companyDir;
  }

  // Load research data
  const data = {
    reddit: redditFile ? loadJsonFile(redditFile) : null,
    forum: forumFile ? loadJsonFile(forumFile) : null,
    research: researchFile ? loadJsonFile(researchFile) : null,
  };

  // Determine company name
  let company = "Unknown";
  if (data.reddit?.company) company = data.reddit.company;
  else if (data.forum?.company) company = data.forum.company;
  else if (data.research?.company?.name) company = data.research.company.name;
  else if (companyDir) company = path.basename(companyDir);

  console.error(`\nSynthesizing Research: ${company}`);
  console.error("─".repeat(40));

  if (!data.reddit && !data.forum && !data.research) {
    console.error("Error: No research data found. Run research tools first:");
    console.error("  research-reddit.js <company> --output <dir>");
    console.error("  research-forum.js <company> --output <dir>");
    console.error("  job-research.js <company> --output <dir>");
    process.exit(1);
  }

  const evidence = extractKeyEvidence(data);
  const insights = generateInsights(company, evidence, data);
  const recommendations = generateRecommendations(insights);

  console.error(`  Sources: ${evidence.sources.join(", ")}`);
  console.error(`  Quotes extracted: ${evidence.quotes.length}`);
  console.error(`  Insights generated: ${insights.length}`);
  console.error("─".repeat(40));
  console.error("Synthesis complete.\n");

  const synthesis = {
    company,
    insights,
    recommendations,
    evidence: {
      sources: evidence.sources,
      signalStrengths: evidence.signals,
      quoteCount: evidence.quotes.length,
    },
    generatedAt: new Date().toISOString(),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(synthesis, null, 2));
  } else {
    console.log("=== SYNTHESIS JSON ===");
    console.log(JSON.stringify(synthesis, null, 2));
    console.log("\n=== SYNTHESIS MARKDOWN ===");
    console.log(formatSynthesisMarkdown(company, insights, recommendations, evidence));
  }

  if (outputDir) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const jsonPath = path.join(outputDir, "synthesis.json");
    const mdPath = path.join(outputDir, "insights.md");
    fs.writeFileSync(jsonPath, JSON.stringify(synthesis, null, 2));
    fs.writeFileSync(mdPath, formatSynthesisMarkdown(company, insights, recommendations, evidence));
    console.error(`\nSaved to: ${outputDir}`);
  }
}

export { extractKeyEvidence, generateInsights, generateRecommendations };

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
