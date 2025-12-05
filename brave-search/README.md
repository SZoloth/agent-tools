# Brave Search

Headless web search and content extraction using Brave Search. No browser required.

## Why use this instead of search-tools?

**search-tools** uses Puppeteer + Chrome to scrape Google. It works but has problems:

- Requires Chrome installed locally
- Google aggressively detects bots and shows CAPTCHAs
- Can't run in headless server environments (needs `--setup` with visible browser to solve CAPTCHAs)
- Heavy dependencies (Puppeteer, Chrome profile syncing)

**brave-search** uses plain HTTP requests to Brave Search:

- No browser needed, just Node.js
- Works in headless/server environments
- Lightweight (only jsdom + readability for parsing)
- Brave doesn't (currently) block simple requests

The tradeoff: Brave Search results may differ from Google's. For most documentation/technical searches, they're comparable.

## Setup

```bash
cd ~/agent-tools/brave-search
npm install
```

Add to PATH in your shell config:
```bash
export PATH="$PATH:$HOME/agent-tools/brave-search"
```

## Search

```bash
search.js "query"                    # Basic search (5 results)
search.js "query" -n 10              # More results
search.js "query" --content          # Include page content as markdown
search.js "query" -n 3 --content     # Combined
```

## Extract Page Content

```bash
content.js https://example.com/article
```

Fetches a URL and extracts readable content as markdown.

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## Limitations

- Brave may eventually add bot detection (they haven't yet)
- Some sites block non-browser requests for content extraction
- Results limited to what Brave Search indexes
