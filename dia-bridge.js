#!/usr/bin/env node
/**
 * dia-bridge - CLI tool for Dia browser automation
 * Combines AppleScript (basic ops) and CDP (deep automation)
 *
 * Usage:
 *   dia-bridge tabs                    # List all tabs
 *   dia-bridge tab <n>                 # Get tab N details
 *   dia-bridge focus <n>               # Switch to tab N
 *   dia-bridge open <url>              # Open URL in new tab
 *   dia-bridge exec <n> <js>           # Execute JS on tab N
 *   dia-bridge content <n>             # Get page text content
 *   dia-bridge screenshot <n> [file]   # Screenshot tab N
 *   dia-bridge search <query>          # Search tabs by title/URL
 *   dia-bridge cdp-status              # Check CDP connection
 */

const { execFileSync } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const CDP_HOST = 'localhost';

// ============ AppleScript Layer (using execFileSync for safety) ============

function runAppleScript(script) {
  try {
    // Using execFileSync with osascript - script passed as argument, not shell
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function getTabsViaAppleScript() {
  const urls = runAppleScript('tell application "Dia" to get URL of every tab of window 1');
  const titles = runAppleScript('tell application "Dia" to get title of every tab of window 1');

  if (!urls || !titles) return [];

  const urlList = urls.split(', ');
  const titleList = titles.split(', ');

  return urlList.map((url, i) => ({
    index: i + 1,
    url: url.trim(),
    title: (titleList[i] || '').trim()
  }));
}

function focusTab(index) {
  // Validate index is a number to prevent injection
  const safeIndex = parseInt(index, 10);
  if (isNaN(safeIndex) || safeIndex < 1) return null;
  return runAppleScript(`tell application "Dia" to focus tab ${safeIndex} of window 1`);
}

function openUrl(url) {
  // Sanitize URL - remove any quotes that could break AppleScript
  const safeUrl = url.replace(/"/g, '').replace(/\\/g, '');
  return runAppleScript(`tell application "Dia" to open location "${safeUrl}"`);
}

// ============ CDP Layer ============

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}${urlPath}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function getCdpTargets() {
  try {
    const targets = await httpGet('/json/list');
    return targets.filter(t => t.type === 'page' && !t.url.startsWith('chrome'));
  } catch (e) {
    return null;
  }
}

async function getCdpVersion() {
  try {
    return await httpGet('/json/version');
  } catch (e) {
    return null;
  }
}

async function sendCdpCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 100000);

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout'));
    }, 10000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on('message', (data) => {
      const result = JSON.parse(data);
      if (result.id === id) {
        clearTimeout(timer);
        cleanup();
        resolve(result);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    ws.on('close', () => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        reject(new Error('Connection closed'));
      }
    });
  });
}

async function executeJs(targetIndex, expression) {
  const targets = await getCdpTargets();
  if (!targets || targets.length === 0) {
    console.error('CDP not available. Launch Dia with: open -a Dia --args --remote-debugging-port=9222');
    process.exit(1);
  }

  const target = targets[targetIndex - 1];
  if (!target) {
    console.error(`Tab ${targetIndex} not found. Available: 1-${targets.length}`);
    process.exit(1);
  }

  const result = await sendCdpCommand(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression,
    returnByValue: true
  });

  return result.result?.result?.value;
}

async function getPageContent(targetIndex) {
  return executeJs(targetIndex, 'document.body.innerText');
}

async function takeScreenshot(targetIndex, outputFile) {
  const targets = await getCdpTargets();
  if (!targets || targets.length === 0) {
    console.error('CDP not available');
    process.exit(1);
  }

  const target = targets[targetIndex - 1];
  if (!target) {
    console.error(`Tab ${targetIndex} not found`);
    process.exit(1);
  }

  const result = await sendCdpCommand(target.webSocketDebuggerUrl, 'Page.captureScreenshot', {
    format: 'png'
  });

  const filename = outputFile || `dia-screenshot-${Date.now()}.png`;
  const filepath = path.resolve(filename);
  fs.writeFileSync(filepath, Buffer.from(result.result.data, 'base64'));
  return filepath;
}

// ============ CLI Commands ============

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(`
dia-bridge - Dia browser automation CLI

Commands:
  tabs                    List all tabs (AppleScript)
  tab <n>                 Get tab N details
  focus <n>               Switch to tab N (AppleScript)
  open <url>              Open URL in new tab (AppleScript)
  exec <n> <js>           Execute JS on tab N (CDP)
  content <n>             Get page text content (CDP)
  screenshot <n> [file]   Screenshot tab N (CDP)
  search <query>          Search tabs by title/URL
  cdp-status              Check CDP connection
  cdp-tabs                List tabs via CDP (more detail)

Note: CDP commands require Dia launched with:
  open -a Dia --args --remote-debugging-port=9222
`);
    return;
  }

  switch (cmd) {
    case 'tabs': {
      const tabs = getTabsViaAppleScript();
      if (tabs.length === 0) {
        console.log('No tabs found or Dia not running');
        return;
      }
      tabs.forEach(t => {
        console.log(`${t.index.toString().padStart(3)}: ${t.title.substring(0, 50).padEnd(50)} ${t.url.substring(0, 60)}`);
      });
      console.log(`\nTotal: ${tabs.length} tabs`);
      break;
    }

    case 'tab': {
      const n = parseInt(args[1]);
      if (!n) {
        console.error('Usage: dia-bridge tab <number>');
        process.exit(1);
      }
      const tabs = getTabsViaAppleScript();
      const tab = tabs[n - 1];
      if (!tab) {
        console.error(`Tab ${n} not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(tab, null, 2));
      break;
    }

    case 'focus': {
      const n = parseInt(args[1]);
      if (!n) {
        console.error('Usage: dia-bridge focus <number>');
        process.exit(1);
      }
      focusTab(n);
      console.log(`Focused tab ${n}`);
      break;
    }

    case 'open': {
      const url = args[1];
      if (!url) {
        console.error('Usage: dia-bridge open <url>');
        process.exit(1);
      }
      openUrl(url);
      console.log(`Opened: ${url}`);
      break;
    }

    case 'exec': {
      const n = parseInt(args[1]);
      const js = args.slice(2).join(' ');
      if (!n || !js) {
        console.error('Usage: dia-bridge exec <tab-number> <javascript>');
        process.exit(1);
      }
      const result = await executeJs(n, js);
      console.log(result);
      break;
    }

    case 'content': {
      const n = parseInt(args[1]);
      if (!n) {
        console.error('Usage: dia-bridge content <tab-number>');
        process.exit(1);
      }
      const content = await getPageContent(n);
      console.log(content);
      break;
    }

    case 'screenshot': {
      const n = parseInt(args[1]);
      const file = args[2];
      if (!n) {
        console.error('Usage: dia-bridge screenshot <tab-number> [filename]');
        process.exit(1);
      }
      const filepath = await takeScreenshot(n, file);
      console.log(`Screenshot saved: ${filepath}`);
      break;
    }

    case 'search': {
      const query = args.slice(1).join(' ').toLowerCase();
      if (!query) {
        console.error('Usage: dia-bridge search <query>');
        process.exit(1);
      }
      const tabs = getTabsViaAppleScript();
      const matches = tabs.filter(t =>
        t.title.toLowerCase().includes(query) ||
        t.url.toLowerCase().includes(query)
      );
      if (matches.length === 0) {
        console.log('No matching tabs found');
        return;
      }
      matches.forEach(t => {
        console.log(`${t.index.toString().padStart(3)}: ${t.title.substring(0, 50).padEnd(50)} ${t.url.substring(0, 60)}`);
      });
      break;
    }

    case 'cdp-status': {
      const version = await getCdpVersion();
      if (!version) {
        console.log('❌ CDP not available');
        console.log('\nTo enable, restart Dia with:');
        console.log('  open -a Dia --args --remote-debugging-port=9222');
        process.exit(1);
      }
      console.log('✅ CDP Connected');
      console.log(`   Browser: ${version.Browser}`);
      console.log(`   Protocol: ${version['Protocol-Version']}`);

      const targets = await getCdpTargets();
      console.log(`   Page targets: ${targets?.length || 0}`);
      break;
    }

    case 'cdp-tabs': {
      const targets = await getCdpTargets();
      if (!targets) {
        console.error('CDP not available');
        process.exit(1);
      }
      targets.forEach((t, i) => {
        console.log(`${(i + 1).toString().padStart(3)}: ${t.title.substring(0, 50).padEnd(50)} ${t.url.substring(0, 60)}`);
      });
      console.log(`\nTotal: ${targets.length} CDP targets`);
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.log('Run "dia-bridge help" for usage');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
