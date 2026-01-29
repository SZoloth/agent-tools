#!/usr/bin/env node

/**
 * slack-scraper.js - Extract unread messages from Slack web app
 *
 * Uses puppeteer-core to connect to existing Chrome instance and
 * scrape unread messages from app.slack.com
 */

import puppeteer from 'puppeteer-core';

const SLACK_URL = 'https://app.slack.com';
const TIMEOUT = 60000; // 1 minute timeout for operations

async function connectBrowser() {
  return puppeteer.connect({
    browserURL: 'http://localhost:9222',
    defaultViewport: null,
  });
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Extract unread channels from Slack sidebar
 */
async function getUnreadChannels(page) {
  // Slack marks unread channels with bold text or specific data attributes
  // The sidebar structure varies, so we try multiple selectors
  const channels = await page.evaluate(() => {
    const results = [];

    // Try various selectors for unread items
    const selectors = [
      // Unread channels have specific styling or attributes
      '[data-qa="channel_sidebar_name_highlighted"]',
      '[data-qa-channel-sidebar-is-unread="true"]',
      '.p-channel_sidebar__channel--unread',
      '[class*="unread"]',
      // Bold text indicates unread
      '.c-link--bold',
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent?.trim();
        if (text && !results.some(r => r.name === text)) {
          results.push({
            name: text,
            selector: selector,
            element: el.closest('[data-qa-channel-sidebar-channel-id]')?.getAttribute('data-qa-channel-sidebar-channel-id') || null
          });
        }
      });
    }

    // If no unread found via specific selectors, look for sidebar channels
    if (results.length === 0) {
      const sidebarChannels = document.querySelectorAll('[data-qa="channel_sidebar_name"]');
      sidebarChannels.forEach(el => {
        const parent = el.closest('.c-link');
        // Check if parent has bold styling
        if (parent?.classList.contains('c-link--bold') ||
            parent?.closest('[data-qa-channel-sidebar-is-unread]')) {
          const text = el.textContent?.trim();
          if (text) {
            results.push({ name: text, selector: 'sidebar' });
          }
        }
      });
    }

    return results;
  });

  return channels;
}

/**
 * Navigate to a specific channel and extract messages
 */
async function getChannelMessages(page, channelName, maxMessages = 50) {
  // Click on the channel in sidebar
  const clicked = await page.evaluate((name) => {
    const links = document.querySelectorAll('[data-qa="channel_sidebar_name"]');
    for (const link of links) {
      if (link.textContent?.trim() === name) {
        link.click();
        return true;
      }
    }
    // Try alternate selector
    const altLinks = document.querySelectorAll('.p-channel_sidebar__name');
    for (const link of altLinks) {
      if (link.textContent?.trim() === name) {
        link.click();
        return true;
      }
    }
    return false;
  }, channelName);

  if (!clicked) {
    console.error(`Could not find channel: ${channelName}`);
    return [];
  }

  // Wait for messages to load
  await delay(2000);

  // Extract messages from the main panel
  const messages = await page.evaluate((max) => {
    const results = [];

    // Slack message selectors
    const messageSelectors = [
      '[data-qa="message_container"]',
      '.c-message_kit__message',
      '.c-message',
    ];

    let messageElements = [];
    for (const selector of messageSelectors) {
      messageElements = document.querySelectorAll(selector);
      if (messageElements.length > 0) break;
    }

    // Get the most recent messages (up to max)
    const elementsArray = Array.from(messageElements).slice(-max);

    elementsArray.forEach(el => {
      // Extract sender
      const senderEl = el.querySelector('[data-qa="message_sender_name"]') ||
                       el.querySelector('.c-message__sender_link') ||
                       el.querySelector('.c-message_kit__sender');
      const sender = senderEl?.textContent?.trim() || 'Unknown';

      // Extract message text
      const textEl = el.querySelector('[data-qa="message_content"]') ||
                     el.querySelector('.c-message_kit__text') ||
                     el.querySelector('.c-message__message_blocks');
      const text = textEl?.textContent?.trim() || '';

      // Extract timestamp
      const timeEl = el.querySelector('[data-qa="message_timestamp"]') ||
                     el.querySelector('.c-timestamp');
      const timestamp = timeEl?.textContent?.trim() ||
                        timeEl?.getAttribute('title') || '';

      if (text) {
        results.push({
          sender,
          text: text.substring(0, 1000), // Limit message length
          timestamp
        });
      }
    });

    return results;
  }, maxMessages);

  return messages;
}

/**
 * Get unread DMs from Slack
 */
async function getUnreadDMs(page) {
  // Navigate to DMs section and find unread
  const dms = await page.evaluate(() => {
    const results = [];

    // Look for DM section and unread items
    const dmItems = document.querySelectorAll('[data-qa="im_sidebar_name"]');
    dmItems.forEach(el => {
      const parent = el.closest('[data-qa-channel-sidebar-is-unread="true"]') ||
                     el.closest('.c-link--bold')?.closest('div');
      if (parent) {
        const name = el.textContent?.trim();
        if (name) {
          results.push({ name, type: 'dm' });
        }
      }
    });

    return results;
  });

  return dms;
}

/**
 * Main scraping function
 */
export async function scrapeSlack() {
  const results = {
    workspace: null,
    channels: [],
    dms: [],
    errors: []
  };

  let browser;
  try {
    browser = await connectBrowser();
  } catch (e) {
    results.errors.push('Could not connect to Chrome on :9222. Run browser-start.js first.');
    return results;
  }

  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('slack.com'));

  // If not already on Slack, navigate there
  if (!page) {
    page = pages[pages.length - 1] || await browser.newPage();
    console.log('Navigating to Slack...');
    await page.goto(SLACK_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });
    await delay(3000);
  }

  const url = page.url();

  // Check if logged in
  if (url.includes('signin') || url.includes('sign_in')) {
    results.errors.push('Not logged into Slack. Please login in the browser first.');
    await browser.disconnect();
    return results;
  }

  // Extract workspace name
  results.workspace = await page.evaluate(() => {
    const workspaceEl = document.querySelector('[data-qa="team-menu-trigger"]') ||
                        document.querySelector('.p-ia__sidebar_header__team_name');
    return workspaceEl?.textContent?.trim() || 'Unknown Workspace';
  });

  console.log(`Connected to Slack workspace: ${results.workspace}`);

  // Get unread channels
  const unreadChannels = await getUnreadChannels(page);
  console.log(`Found ${unreadChannels.length} unread channels`);

  // Get messages from each unread channel
  for (const channel of unreadChannels.slice(0, 10)) { // Limit to 10 channels
    console.log(`Scraping channel: ${channel.name}`);
    const messages = await getChannelMessages(page, channel.name);
    if (messages.length > 0) {
      results.channels.push({
        name: channel.name,
        messages
      });
    }
    await delay(1000); // Be nice to Slack
  }

  // Get unread DMs
  const unreadDMs = await getUnreadDMs(page);
  console.log(`Found ${unreadDMs.length} unread DMs`);

  for (const dm of unreadDMs.slice(0, 5)) { // Limit to 5 DMs
    console.log(`Scraping DM: ${dm.name}`);
    const messages = await getChannelMessages(page, dm.name);
    if (messages.length > 0) {
      results.dms.push({
        name: dm.name,
        messages
      });
    }
    await delay(1000);
  }

  await browser.disconnect();
  return results;
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== Slack Scraper ===');

  try {
    const results = await scrapeSlack();

    if (results.errors.length > 0) {
      console.error('Errors:', results.errors);
    }

    console.log(`\nWorkspace: ${results.workspace}`);
    console.log(`Channels with messages: ${results.channels.length}`);
    console.log(`DMs with messages: ${results.dms.length}`);

    // Output JSON for inspection
    console.log('\n--- Results ---');
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}
