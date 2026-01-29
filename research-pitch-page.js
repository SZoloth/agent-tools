#!/usr/bin/env node

/**
 * research-pitch-page.js - Generate premium pitch pages from research
 *
 * Creates consulting-grade pitch pages adapted for job applications.
 * Structure inspired by Stellar Elements proposals but framed as candidate audition.
 *
 * Features:
 * - Brand theming (adapts to target company colors)
 * - Insight structure: headline → evidence columns → user quotes
 * - Recommendations with business impact framing
 * - Editorial compliance (no AI tells, specificity enforced)
 * - Modern, responsive design
 *
 * Usage:
 *   research-pitch-page.js <company-dir>
 *   research-pitch-page.js <company-dir> --brand "linear"
 *   research-pitch-page.js <company-dir> --brand "#5E6AD2,#1a1a1a"
 *   research-pitch-page.js <company-dir> --title "Custom Title"
 *
 * Dependencies: Reads synthesis.json from research folder
 */

import fs from "fs";
import path from "path";

// Brand color presets for common companies
const BRAND_PRESETS = {
  linear: { primary: "#5E6AD2", secondary: "#1a1a1a", accent: "#8B5CF6" },
  figma: { primary: "#F24E1E", secondary: "#1E1E1E", accent: "#A259FF" },
  notion: { primary: "#000000", secondary: "#37352F", accent: "#EB5757" },
  stripe: { primary: "#635BFF", secondary: "#0A2540", accent: "#00D4FF" },
  vercel: { primary: "#000000", secondary: "#111111", accent: "#0070F3" },
  slack: { primary: "#4A154B", secondary: "#1a1a1a", accent: "#36C5F0" },
  spotify: { primary: "#1DB954", secondary: "#191414", accent: "#1ED760" },
  airbnb: { primary: "#FF5A5F", secondary: "#484848", accent: "#00A699" },
  dropbox: { primary: "#0061FF", secondary: "#1E1919", accent: "#B4DC19" },
  intercom: { primary: "#1F8DED", secondary: "#1a1a1a", accent: "#6AFDEF" },
  amplitude: { primary: "#1E61F0", secondary: "#0D0E12", accent: "#00C2FF" },
  mixpanel: { primary: "#7856FF", secondary: "#1B0B3B", accent: "#FF6B8A" },
  datadog: { primary: "#632CA6", secondary: "#1a1a1a", accent: "#00C2FF" },
  retool: { primary: "#3D3D3D", secondary: "#1a1a1a", accent: "#F26522" },
  default: { primary: "#2563eb", secondary: "#1a1a1a", accent: "#8B5CF6" },
};

function parseBrandArg(brandArg) {
  if (!brandArg) return BRAND_PRESETS.default;

  // Check if it's a preset name
  const preset = BRAND_PRESETS[brandArg.toLowerCase()];
  if (preset) return preset;

  // Check if it's custom colors (comma-separated hex)
  if (brandArg.includes(",")) {
    const colors = brandArg.split(",").map((c) => c.trim());
    return {
      primary: colors[0] || BRAND_PRESETS.default.primary,
      secondary: colors[1] || BRAND_PRESETS.default.secondary,
      accent: colors[2] || colors[0] || BRAND_PRESETS.default.accent,
    };
  }

  // Single color provided - use as primary
  if (brandArg.startsWith("#")) {
    return {
      primary: brandArg,
      secondary: BRAND_PRESETS.default.secondary,
      accent: brandArg,
    };
  }

  return BRAND_PRESETS.default;
}

function generateTemplate(brand) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{TITLE}}</title>
    <style>
        :root {
            --brand-primary: ${brand.primary};
            --brand-secondary: ${brand.secondary};
            --brand-accent: ${brand.accent};
            --color-bg: #ffffff;
            --color-bg-subtle: #fafafa;
            --color-text: #1a1a1a;
            --color-text-muted: #666666;
            --color-border: #e5e5e5;
            --color-issue: #dc2626;
            --color-issue-bg: #fef2f2;
            --color-opportunity: #059669;
            --color-opportunity-bg: #ecfdf5;
            --color-strength: #0891b2;
            --color-strength-bg: #ecfeff;
            --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            --font-mono: 'JetBrains Mono', 'SF Mono', Monaco, monospace;
        }

        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--font-sans);
            color: var(--color-text);
            background: var(--color-bg);
            line-height: 1.65;
            font-size: 16px;
            -webkit-font-smoothing: antialiased;
        }

        /* Hero Section */
        .hero {
            background: linear-gradient(135deg, var(--brand-secondary) 0%, color-mix(in srgb, var(--brand-secondary) 80%, var(--brand-primary)) 100%);
            color: white;
            padding: 5rem 2rem;
            position: relative;
            overflow: hidden;
        }

        .hero::before {
            content: '';
            position: absolute;
            top: 0;
            right: 0;
            width: 50%;
            height: 100%;
            background: linear-gradient(135deg, transparent 0%, color-mix(in srgb, var(--brand-primary) 10%, transparent) 100%);
        }

        .hero-content {
            max-width: 900px;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }

        .hero h1 {
            font-size: clamp(2rem, 5vw, 3.5rem);
            font-weight: 700;
            letter-spacing: -0.03em;
            line-height: 1.1;
            margin-bottom: 1.5rem;
        }

        .hero .subtitle {
            font-size: 1.25rem;
            opacity: 0.9;
            max-width: 600px;
            line-height: 1.5;
        }

        .hero .meta {
            margin-top: 2rem;
            font-size: 0.875rem;
            opacity: 0.7;
            display: flex;
            gap: 2rem;
            flex-wrap: wrap;
        }

        .hero .meta span {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* Main Content */
        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 0 2rem;
        }

        section {
            padding: 4rem 0;
            border-bottom: 1px solid var(--color-border);
        }

        section:last-of-type {
            border-bottom: none;
        }

        h2 {
            font-size: 1.75rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            margin-bottom: 1rem;
            color: var(--brand-secondary);
        }

        h2 .section-number {
            color: var(--brand-primary);
            font-weight: 600;
            margin-right: 0.5rem;
        }

        h3 {
            font-size: 1.125rem;
            font-weight: 600;
            margin-bottom: 0.75rem;
            color: var(--color-text);
        }

        p {
            margin-bottom: 1rem;
            color: var(--color-text-muted);
        }

        /* Key Findings Summary */
        .findings-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }

        .finding-card {
            background: var(--color-bg-subtle);
            border-radius: 12px;
            padding: 1.5rem;
            border-left: 4px solid var(--brand-primary);
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .finding-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 30px rgba(0,0,0,0.08);
        }

        .finding-card.issue {
            border-left-color: var(--color-issue);
        }

        .finding-card.opportunity {
            border-left-color: var(--color-opportunity);
        }

        .finding-card.strength {
            border-left-color: var(--color-strength);
        }

        .finding-card .icon {
            font-size: 1.5rem;
            margin-bottom: 0.75rem;
        }

        .finding-card h4 {
            font-size: 1rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            color: var(--color-text);
        }

        .finding-card p {
            font-size: 0.875rem;
            margin: 0;
        }

        /* Insight Cards - Detailed */
        .insight-section {
            margin: 3rem 0;
        }

        .insight-header {
            display: flex;
            align-items: flex-start;
            gap: 1rem;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 2px solid var(--color-border);
        }

        .insight-number {
            background: var(--brand-primary);
            color: white;
            width: 2.5rem;
            height: 2.5rem;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            flex-shrink: 0;
        }

        .insight-title {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--color-text);
            line-height: 1.3;
        }

        .insight-subtitle {
            font-size: 1rem;
            color: var(--color-text-muted);
            margin-top: 0.25rem;
        }

        /* Evidence Grid - 3 columns like Stellar */
        .evidence-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1.5rem;
            margin: 1.5rem 0;
        }

        @media (max-width: 768px) {
            .evidence-grid {
                grid-template-columns: 1fr;
            }
        }

        .evidence-column {
            background: var(--color-bg-subtle);
            border-radius: 8px;
            padding: 1.25rem;
        }

        .evidence-column h5 {
            font-size: 0.875rem;
            font-weight: 600;
            color: var(--color-text);
            margin-bottom: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .evidence-column p {
            font-size: 0.9rem;
            line-height: 1.5;
        }

        .evidence-column .stat {
            font-size: 1.75rem;
            font-weight: 700;
            color: var(--brand-primary);
            margin-bottom: 0.25rem;
        }

        /* Quotes */
        .quote-section {
            margin: 1.5rem 0;
            padding: 1.5rem;
            background: linear-gradient(135deg, var(--color-bg-subtle) 0%, white 100%);
            border-radius: 8px;
            border-left: 4px solid var(--brand-primary);
        }

        blockquote {
            font-size: 1.1rem;
            font-style: italic;
            color: var(--color-text);
            line-height: 1.6;
            margin: 0;
        }

        blockquote cite {
            display: block;
            font-size: 0.875rem;
            font-style: normal;
            color: var(--color-text-muted);
            margin-top: 0.75rem;
        }

        /* Recommendations */
        .recommendation-card {
            background: white;
            border: 1px solid var(--color-border);
            border-radius: 12px;
            padding: 2rem;
            margin: 1.5rem 0;
            position: relative;
            overflow: hidden;
        }

        .recommendation-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background: linear-gradient(90deg, var(--brand-primary), var(--brand-accent));
        }

        .recommendation-card h4 {
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 0.75rem;
        }

        .recommendation-card .description {
            color: var(--color-text-muted);
            margin-bottom: 1.5rem;
        }

        .impact-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
        }

        @media (max-width: 600px) {
            .impact-grid {
                grid-template-columns: 1fr;
            }
        }

        .impact-box {
            background: var(--color-bg-subtle);
            border-radius: 8px;
            padding: 1rem;
        }

        .impact-box h5 {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--brand-primary);
            margin-bottom: 0.5rem;
        }

        .impact-box ul {
            list-style: none;
            font-size: 0.875rem;
            color: var(--color-text-muted);
        }

        .impact-box li {
            padding: 0.25rem 0;
            padding-left: 1rem;
            position: relative;
        }

        .impact-box li::before {
            content: '→';
            position: absolute;
            left: 0;
            color: var(--brand-primary);
        }

        /* CTA Section */
        .cta-section {
            background: linear-gradient(135deg, var(--brand-secondary) 0%, color-mix(in srgb, var(--brand-secondary) 85%, var(--brand-primary)) 100%);
            color: white;
            padding: 4rem 2rem;
            text-align: center;
            margin-top: 2rem;
        }

        .cta-section h2 {
            color: white;
            margin-bottom: 1rem;
        }

        .cta-section p {
            color: rgba(255,255,255,0.85);
            max-width: 600px;
            margin: 0 auto 2rem;
        }

        .cta-button {
            display: inline-block;
            background: white;
            color: var(--brand-secondary);
            padding: 1rem 2.5rem;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 1rem;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 30px rgba(0,0,0,0.2);
        }

        /* Footer */
        footer {
            padding: 3rem 2rem;
            text-align: center;
            color: var(--color-text-muted);
            font-size: 0.875rem;
        }

        footer a {
            color: var(--brand-primary);
            text-decoration: none;
        }

        footer a:hover {
            text-decoration: underline;
        }

        /* Priority Tags */
        .priority-tag {
            display: inline-block;
            font-size: 0.75rem;
            font-weight: 600;
            padding: 0.25rem 0.75rem;
            border-radius: 100px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .priority-high {
            background: var(--color-issue-bg);
            color: var(--color-issue);
        }

        .priority-medium {
            background: #fef3c7;
            color: #d97706;
        }

        .priority-low {
            background: var(--color-opportunity-bg);
            color: var(--color-opportunity);
        }
    </style>
</head>
<body>
    <header class="hero">
        <div class="hero-content">
            <h1>{{TITLE}}</h1>
            <p class="subtitle">{{SUBTITLE}}</p>
            <div class="meta">
                <span>{{META}}</span>
            </div>
        </div>
    </header>

    <main>
        {{CONTENT}}
    </main>

    <section class="cta-section">
        <div class="container">
            <h2>Let's Continue the Conversation</h2>
            <p>This research reflects how I approach product challenges: grounded in user evidence, focused on business impact, and oriented toward action.</p>
            <a href="mailto:smzoloth@gmail.com" class="cta-button">Get in Touch</a>
        </div>
    </section>

    <footer>
        <div class="container">
            <p>Research by <a href="https://samzoloth.com">Sam Zoloth</a></p>
            <p style="margin-top: 0.5rem; opacity: 0.7;">Deep, multi-channel insights delivered in days, not months.</p>
        </div>
    </footer>
</body>
</html>`;
}

function loadJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

function findSynthesisFile(dir) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (entry.toLowerCase() === "synthesis.json") {
      return path.join(dir, entry);
    }
  }
  return null;
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getInsightIcon(strength) {
  switch (strength) {
    case "issue":
      return "⚠️";
    case "opportunity":
      return "🚀";
    case "strength":
      return "✅";
    default:
      return "📊";
  }
}

function getInsightClass(strength) {
  switch (strength) {
    case "issue":
      return "issue";
    case "opportunity":
      return "opportunity";
    case "strength":
      return "strength";
    default:
      return "";
  }
}

function generateContent(synthesis) {
  let html = "";

  // Section 1: Key Findings Summary
  html += `
    <section>
        <div class="container">
            <h2><span class="section-number">01</span> Key Findings</h2>
            <p>Strategic insights synthesized from user research, competitive analysis, and market signals.</p>
            <div class="findings-grid">`;

  for (const insight of synthesis.insights || []) {
    const icon = getInsightIcon(insight.strength);
    const cardClass = getInsightClass(insight.strength);
    html += `
                <div class="finding-card ${cardClass}">
                    <div class="icon">${icon}</div>
                    <h4>${escapeHtml(insight.title)}</h4>
                    <p>${escapeHtml(insight.summary || (insight.evidence && insight.evidence[0]) || "")}</p>
                </div>`;
  }

  html += `
            </div>
        </div>
    </section>`;

  // Section 2: Detailed Insights
  html += `
    <section>
        <div class="container">
            <h2><span class="section-number">02</span> Strategic Insights</h2>`;

  for (let i = 0; i < (synthesis.insights || []).length; i++) {
    const insight = synthesis.insights[i];

    html += `
            <div class="insight-section">
                <div class="insight-header">
                    <div class="insight-number">${i + 1}</div>
                    <div>
                        <div class="insight-title">${escapeHtml(insight.title)}</div>
                        ${insight.subtitle ? `<div class="insight-subtitle">${escapeHtml(insight.subtitle)}</div>` : ""}
                    </div>
                </div>`;

    // Evidence grid (3 columns if we have enough evidence)
    if (insight.evidence && insight.evidence.length > 0) {
      html += `<div class="evidence-grid">`;

      // Split evidence into up to 3 columns
      const evidencePerColumn = Math.ceil(insight.evidence.length / 3);
      for (let col = 0; col < 3 && col * evidencePerColumn < insight.evidence.length; col++) {
        const startIdx = col * evidencePerColumn;
        const endIdx = Math.min(startIdx + evidencePerColumn, insight.evidence.length);
        const columnEvidence = insight.evidence.slice(startIdx, endIdx);

        html += `
                    <div class="evidence-column">
                        <h5>Evidence</h5>`;

        for (const e of columnEvidence) {
          // Check if evidence contains a number for stat formatting
          const statMatch = e.match(/^(\d+(?:\.\d+)?%?)/);
          if (statMatch) {
            html += `<div class="stat">${escapeHtml(statMatch[1])}</div>
                            <p>${escapeHtml(e.substring(statMatch[0].length).trim())}</p>`;
          } else {
            html += `<p>${escapeHtml(e)}</p>`;
          }
        }

        html += `</div>`;
      }

      html += `</div>`;
    }

    // Quotes
    if (insight.quotes && insight.quotes.length > 0) {
      for (const quote of insight.quotes.slice(0, 2)) {
        html += `
                <div class="quote-section">
                    <blockquote>
                        "${escapeHtml(quote)}"
                        <cite>— User research</cite>
                    </blockquote>
                </div>`;
      }
    }

    html += `</div>`;
  }

  html += `
        </div>
    </section>`;

  // Section 3: Recommendations
  if (synthesis.recommendations && synthesis.recommendations.length > 0) {
    html += `
    <section>
        <div class="container">
            <h2><span class="section-number">03</span> Opportunities</h2>
            <p>High-impact areas based on the research findings. Each recommendation connects user needs to business outcomes.</p>`;

    for (const rec of synthesis.recommendations) {
      const priorityClass = `priority-${rec.priority || "medium"}`;

      html += `
            <div class="recommendation-card">
                <span class="priority-tag ${priorityClass}">${escapeHtml((rec.priority || "medium").toUpperCase())} PRIORITY</span>
                <h4>${escapeHtml(rec.action || rec.title)}</h4>
                <p class="description">${escapeHtml(rec.detail || rec.description || "")}</p>

                <div class="impact-grid">
                    <div class="impact-box">
                        <h5>Business Impact</h5>
                        <ul>
                            ${(rec.businessImpact || ["Improved conversion", "Reduced churn", "Increased engagement"]).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}
                        </ul>
                    </div>
                    <div class="impact-box">
                        <h5>Quick Wins</h5>
                        <ul>
                            ${(rec.quickWins || ["Low implementation effort", "Measurable results", "Foundation for iteration"]).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}
                        </ul>
                    </div>
                </div>
            </div>`;
    }

    html += `
        </div>
    </section>`;
  }

  return html;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: research-pitch-page.js <company-dir> [options]

Options:
  --brand <name|colors>   Brand preset or custom colors
                          Presets: linear, figma, notion, stripe, vercel, slack, spotify, etc.
                          Custom: "#5E6AD2,#1a1a1a,#8B5CF6" (primary,secondary,accent)
  --output <file>         Output HTML file path
  --title "Custom"        Custom page title

Examples:
  research-pitch-page.js ./companies/linear/
  research-pitch-page.js ./companies/figma/ --brand figma
  research-pitch-page.js ./companies/acme/ --brand "#FF6B6B,#2C3E50"
  research-pitch-page.js ./companies/stripe/ --brand stripe --title "Stripe Growth Analysis"
    `);
    process.exit(0);
  }

  let companyDir = null;
  let outputFile = null;
  let customTitle = null;
  let brandArg = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" && args[i + 1]) {
      outputFile = args[++i];
    } else if (arg === "--title" && args[i + 1]) {
      customTitle = args[++i];
    } else if (arg === "--brand" && args[i + 1]) {
      brandArg = args[++i];
    } else if (!arg.startsWith("-")) {
      companyDir = arg;
    }
  }

  if (!companyDir) {
    console.error("Error: Company directory required");
    console.error("Usage: research-pitch-page.js <company-dir> [options]");
    console.error("Run with --help for more options");
    process.exit(1);
  }

  // Find synthesis file
  const synthesisFile = findSynthesisFile(companyDir);

  if (!synthesisFile) {
    console.error("Error: No synthesis.json found. Run research-synthesis.js first:");
    console.error("  research-synthesis.js <company-dir>");
    process.exit(1);
  }

  const synthesis = loadJsonFile(synthesisFile);

  if (!synthesis) {
    console.error("Error: Could not parse synthesis.json");
    process.exit(1);
  }

  const company = synthesis.company || path.basename(companyDir);
  const brand = parseBrandArg(brandArg || company.toLowerCase());
  const title = customTitle || `${company} Strategic Insights`;
  const subtitle = `Product research and growth opportunities`;
  const meta = `Research from ${synthesis.evidence?.sources?.join(", ") || "Reddit, app reviews, competitive analysis"} | ${synthesis.generatedAt?.split("T")[0] || new Date().toISOString().split("T")[0]}`;

  console.error(`\nGenerating Pitch Page: ${company}`);
  console.error(`Brand: ${brandArg || "default"} (${brand.primary})`);
  console.error("─".repeat(40));

  const content = generateContent(synthesis);
  const template = generateTemplate(brand);

  const html = template
    .replace(/\{\{TITLE\}\}/g, escapeHtml(title))
    .replace(/\{\{SUBTITLE\}\}/g, escapeHtml(subtitle))
    .replace(/\{\{META\}\}/g, escapeHtml(meta))
    .replace(/\{\{CONTENT\}\}/g, content);

  // Determine output path
  if (!outputFile) {
    outputFile = path.join(companyDir, "pitch-page.html");
  }

  fs.writeFileSync(outputFile, html);

  console.error(`Generated: ${outputFile}`);
  console.error("─".repeat(40));
  console.error("Pitch page complete.\n");

  // Also output the HTML to stdout for preview
  console.log(html);
}

export { generateContent, parseBrandArg, BRAND_PRESETS };

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
