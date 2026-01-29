#!/usr/bin/env node

/**
 * gchat-scraper.js - Extract unread messages from Google Chat
 *
 * Uses puppeteer-core to connect to existing Chrome instance and
 * scrape unread messages from chat.google.com
 */

import puppeteer from 'puppeteer-core';

const GCHAT_URL = 'https://chat.google.com';
const TIMEOUT = 60000;

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
 * Extract unread conversations from Google Chat sidebar
 */
async function getUnreadConversations(page) {
  const conversations = await page.evaluate(() => {
    const results = [];

    // Google Chat uses various indicators for unread
    // Look for bold text, unread badges, or specific aria attributes
    const selectors = [
      // Unread indicator badge
      '[data-unread="true"]',
      '[aria-label*="unread"]',
      // Bold text items in sidebar
      '[role="listitem"] [style*="font-weight: 700"]',
      '[role="listitem"] [style*="font-weight: bold"]',
      // Items with notification dots
      '.aYu',  // Google's notification indicator class
    ];

    // First try to find all conversation items
    const listItems = document.querySelectorAll('[role="listitem"], [data-id]');

    listItems.forEach(item => {
      // Check if item has unread indicators
      const hasUnreadBadge = item.querySelector('[data-unread="true"]') ||
                              item.querySelector('.aYu') ||
                              item.querySelector('[aria-label*="unread"]');

      const hasBoldText = item.querySelector('[style*="font-weight: 700"]') ||
                          item.querySelector('[style*="font-weight: bold"]');

      if (hasUnreadBadge || hasBoldText) {
        // Extract conversation name
        const nameEl = item.querySelector('[data-name]') ||
                       item.querySelector('[aria-label]') ||
                       item.querySelector('[class*="name"]') ||
                       item;

        const name = nameEl?.getAttribute('data-name') ||
                     nameEl?.getAttribute('aria-label')?.split(',')[0] ||
                     nameEl?.textContent?.trim()?.split('\n')[0];

        if (name && !results.some(r => r.name === name)) {
          results.push({
            name: name.substring(0, 100),
            element: item.getAttribute('data-id') || null,
            type: item.getAttribute('data-type') || 'conversation'
          });
        }
      }
    });

    // If nothing found via unread indicators, look for Spaces with activity
    if (results.length === 0) {
      const spaceItems = document.querySelectorAll('[data-space-id], [aria-label*="Space"]');
      spaceItems.forEach(item => {
        const label = item.getAttribute('aria-label') || item.textContent?.trim();
        if (label && (label.includes('unread') || label.includes('new message'))) {
          results.push({
            name: label.split(',')[0],
            type: 'space'
          });
        }
      });
    }

    return results;
  });

  return conversations;
}

/**
 * Navigate to a conversation and extract messages
 */
async function getConversationMessages(page, conversationName, maxMessages = 30) {
  // Click on the conversation in sidebar
  const clicked = await page.evaluate((name) => {
    const items = document.querySelectorAll('[role="listitem"], [data-id]');
    for (const item of items) {
      const text = item.textContent?.trim();
      const ariaLabel = item.getAttribute('aria-label');
      const dataName = item.querySelector('[data-name]')?.getAttribute('data-name');

      if (text?.includes(name) || ariaLabel?.includes(name) || dataName === name) {
        item.click();
        return true;
      }
    }
    return false;
  }, conversationName);

  if (!clicked) {
    console.error(`Could not find conversation: ${conversationName}`);
    return [];
  }

  // Wait for messages to load
  await delay(2000);

  // Extract messages from the main panel
  const messages = await page.evaluate((max) => {
    const results = [];

    // Google Chat message selectors
    const messageContainers = document.querySelectorAll(
      '[data-message-id], [jslog*="message"], .nF6pT, [role="listitem"][data-id]'
    );

    const elementsArray = Array.from(messageContainers).slice(-max);

    elementsArray.forEach(el => {
      // Extract sender - usually in a span or div with specific attributes
      const senderEl = el.querySelector('[data-member-id]') ||
                       el.querySelector('[data-hovercard-id]') ||
                       el.querySelector('[class*="sender"]') ||
                       el.querySelector('[aria-label*="sent by"]');

      let sender = senderEl?.textContent?.trim() ||
                   senderEl?.getAttribute('data-name') ||
                   senderEl?.getAttribute('aria-label')?.match(/sent by (\w+)/)?.[1] ||
                   'Unknown';

      // Extract message text
      const textEl = el.querySelector('[data-message-text]') ||
                     el.querySelector('[class*="message-text"]') ||
                     el.querySelector('.oGsu4') || // Google's message text class
                     el.querySelector('[dir="ltr"]');

      const text = textEl?.textContent?.trim() || el.textContent?.trim() || '';

      // Extract timestamp
      const timeEl = el.querySelector('[data-absolute-timestamp]') ||
                     el.querySelector('time') ||
                     el.querySelector('[aria-label*="sent at"]');

      const timestamp = timeEl?.getAttribute('data-absolute-timestamp') ||
                        timeEl?.getAttribute('datetime') ||
                        timeEl?.textContent?.trim() || '';

      // Filter out UI noise
      if (text && text.length > 1 && !text.match(/^(Reply|Thread|Reactions)$/)) {
        results.push({
          sender: sender.substring(0, 50),
          text: text.substring(0, 1000),
          timestamp
        });
      }
    });

    return results;
  }, maxMessages);

  return messages;
}

/**
 * Get messages from Spaces (group chats)
 */
async function getSpaceMessages(page, spaceName, maxMessages = 30) {
  // Navigate to the space
  const clicked = await page.evaluate((name) => {
    // Look in the Spaces section
    const spaceItems = document.querySelectorAll('[data-space-id], [aria-label*="Space"]');
    for (const item of spaceItems) {
      const text = item.textContent?.trim();
      const ariaLabel = item.getAttribute('aria-label');
      if (text?.includes(name) || ariaLabel?.includes(name)) {
        item.click();
        return true;
      }
    }
    return false;
  }, spaceName);

  if (!clicked) {
    console.error(`Could not find space: ${spaceName}`);
    return [];
  }

  await delay(2000);
  return await getConversationMessages(page, spaceName, maxMessages);
}

/**
 * Main scraping function
 */
export async function scrapeGoogleChat() {
  const results = {
    account: null,
    conversations: [],
    spaces: [],
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
  let page = pages.find(p => p.url().includes('chat.google.com'));

  // If not already on Google Chat, navigate there
  if (!page) {
    page = pages[pages.length - 1] || await browser.newPage();
    console.log('Navigating to Google Chat...');
    await page.goto(GCHAT_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });
    await delay(3000);
  }

  const url = page.url();

  // Check if logged in
  if (url.includes('accounts.google.com') || url.includes('signin')) {
    results.errors.push('Not logged into Google Chat. Please login in the browser first.');
    await browser.disconnect();
    return results;
  }

  // Try to get account info
  results.account = await page.evaluate(() => {
    const accountEl = document.querySelector('[aria-label*="Google Account"]') ||
                      document.querySelector('[data-email]') ||
                      document.querySelector('[class*="account"]');
    return accountEl?.getAttribute('data-email') ||
           accountEl?.getAttribute('aria-label')?.match(/([^\s]+@[^\s]+)/)?.[1] ||
           'DreamWorks Google Chat';
  });

  console.log(`Connected to Google Chat: ${results.account}`);

  // Get unread conversations
  const unreadConversations = await getUnreadConversations(page);
  console.log(`Found ${unreadConversations.length} unread items`);

  // Process conversations (DMs)
  const dms = unreadConversations.filter(c => c.type !== 'space');
  const spaces = unreadConversations.filter(c => c.type === 'space');

  // Get messages from DMs
  for (const conv of dms.slice(0, 10)) {
    console.log(`Scraping conversation: ${conv.name}`);
    const messages = await getConversationMessages(page, conv.name);
    if (messages.length > 0) {
      results.conversations.push({
        name: conv.name,
        messages
      });
    }
    await delay(1000);
  }

  // Get messages from Spaces
  for (const space of spaces.slice(0, 5)) {
    console.log(`Scraping space: ${space.name}`);
    const messages = await getSpaceMessages(page, space.name);
    if (messages.length > 0) {
      results.spaces.push({
        name: space.name,
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
  console.log('=== Google Chat Scraper ===');

  try {
    const results = await scrapeGoogleChat();

    if (results.errors.length > 0) {
      console.error('Errors:', results.errors);
    }

    console.log(`\nAccount: ${results.account}`);
    console.log(`Conversations with messages: ${results.conversations.length}`);
    console.log(`Spaces with messages: ${results.spaces.length}`);

    // Output JSON for inspection
    console.log('\n--- Results ---');
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}
