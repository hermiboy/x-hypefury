import dotenv from 'dotenv';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';
import puppeteer from 'puppeteer';

dotenv.config();

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const db = new Database('automation.db');

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

let browser = null;
let page = null;

// ============================================
// DATABASE
// ============================================

db.exec(`
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_handle TEXT NOT NULL,
    tweet_id TEXT NOT NULL,
    tweet_author TEXT NOT NULL,
    tweet_text TEXT,
    reply_text TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_handle, tweet_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_handle TEXT NOT NULL,
    date TEXT NOT NULL,
    replies_count INTEGER DEFAULT 0,
    UNIQUE(account_handle, date)
  )
`);

console.log('✅ Database initialized');

// ============================================
// HELPERS
// ============================================

function gaussianRandom(min, max) {
  const mean = (min + max) / 2;
  const stdDev = (max - min) / 6;
  let u1 = Math.random();
  let u2 = Math.random();
  let z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let result = mean + z0 * stdDev;
  return Math.max(min, Math.min(max, result));
}

function randomDelay(minMs, maxMs) {
  return gaussianRandom(minMs, maxMs);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getWeekNumber(accountCreatedDate) {
  const created = new Date(accountCreatedDate);
  const now = new Date();
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.ceil(diffDays / 7);
}

function getWarmupLimits(weekNumber) {
  const schedule = config.warmup_schedule;
  if (weekNumber === 1) return schedule.week_1;
  if (weekNumber === 2) return schedule.week_2;
  if (weekNumber === 3) return schedule.week_3;
  if (weekNumber === 4) return schedule.week_4;
  if (weekNumber === 5) return schedule.week_5;
  return schedule['week_6+'];
}

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

function getTodayRepliesCount(accountHandle) {
  const today = getTodayString();
  const row = db.prepare(`
    SELECT replies_count FROM daily_stats 
    WHERE account_handle = ? AND date = ?
  `).get(accountHandle, today);
  return row ? row.replies_count : 0;
}

function incrementTodayReplies(accountHandle) {
  const today = getTodayString();
  db.prepare(`
    INSERT INTO daily_stats (account_handle, date, replies_count)
    VALUES (?, ?, 1)
    ON CONFLICT(account_handle, date) 
    DO UPDATE SET replies_count = replies_count + 1
  `).run(accountHandle, today);
}

function hasRepliedToTweet(accountHandle, tweetId) {
  const row = db.prepare(`
    SELECT id FROM replies 
    WHERE account_handle = ? AND tweet_id = ?
  `).get(accountHandle, tweetId);
  return !!row;
}

// ============================================
// BROWSER AUTOMATION
// ============================================

async function initBrowser() {
  console.log('🌐 Starting browser...');
  
  browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080'
    ]
  });
  
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  console.log('✅ Browser ready');
}

async function humanType(text) {
  for (const char of text.split('')) {
    await page.keyboard.type(char);
    await sleep(randomDelay(50, 150));
  }
}

async function loginToHypeFury() {
  console.log('🔐 Opening HypeFury...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  
  await sleep(5000);
  
  // Check if already logged in
  const isLoggedIn = await page.$('.engagement-builder, [data-testid="engagement-builder"]');
  
  if (!isLoggedIn) {
    console.log('⚠️  Please login manually!');
    console.log('   Waiting 60 seconds...');
    await sleep(60000);
  } else {
    console.log('✅ Already logged in');
  }
}

async function switchAccount(accountHandle) {
  console.log(`🔄 Switching to ${accountHandle}...`);
  
  try {
    // Click account dropdown
    await page.click('[class*="followers"]');
    await sleep(randomDelay(1000, 2000));
    
    // Click on account
    const accountButtons = await page.$$('text/' + accountHandle.replace('@', ''));
    
    if (accountButtons.length > 0) {
      await accountButtons[0].click();
      await sleep(randomDelay(2000, 4000));
      console.log(`✅ Switched to ${accountHandle}`);
    } else {
      console.log(`⚠️  Account ${accountHandle} not found in dropdown`);
    }
  } catch (error) {
    console.log(`⚠️  Could not switch account: ${error.message}`);
  }
}

async function scrapeTweets() {
  console.log('📡 Scraping tweets from feed...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2'
  });
  
  await sleep(randomDelay(3000, 5000));
  
  try {
    const tweets = await page.evaluate(() => {
      const tweetElements = [];
      
      // Find all visible tweet cards
      const cards = document.querySelectorAll('[role="dialog"], .tweet-card, [class*="tweet"]');
      
      for (const card of cards) {
        try {
          const authorEl = card.querySelector('[class*="author"], .author, strong');
          const textEl = card.querySelector('p, [class*="text"]');
          const timeEl = card.querySelector('time, [class*="time"]');
          
          if (authorEl && textEl) {
            const author = authorEl.textContent.trim();
            const text = textEl.textContent.trim();
            const time = timeEl ? timeEl.getAttribute('datetime') || new Date().toISOString() : new Date().toISOString();
            
            // Generate unique ID from text hash
            const id = 'tweet_' + text.substring(0, 50).replace(/\s/g, '_') + '_' + Date.now();
            
            tweetElements.push({
              id: id,
              author: author.replace('@', ''),
              text: text,
              timestamp: time,
              likes: 0 // Can't reliably scrape likes from HypeFury
            });
          }
        } catch (e) {
          // Skip invalid elements
        }
      }
      
      return tweetElements;
    });
    
    console.log(`📨 Found ${tweets.length} tweets`);
    return tweets;
    
  } catch (error) {
    console.error(`❌ Error scraping tweets: ${error.message}`);
    return [];
  }
}

async function postReply(replyText) {
  console.log('💬 Posting reply...');
  
  try {
    // Find reply textarea
    const textarea = await page.$('textarea[placeholder*="say"], textarea[placeholder*="reply"]');
    
    if (!textarea) {
      console.log('⚠️  Reply textarea not found');
      return false;
    }
    
    await textarea.click();
    await sleep(randomDelay(500, 1000));
    
    // Type reply
    await humanType(replyText);
    await sleep(randomDelay(1000, 2000));
    
    // Click Reply button
    const replyButton = await page.$('button:has-text("Reply"), button[class*="reply"]');
    
    if (replyButton) {
      await replyButton.click();
      await sleep(randomDelay(3000, 5000));
      console.log('✅ Reply posted');
      return true;
    } else {
      console.log('⚠️  Reply button not found - clicking Skip');
      const skipButton = await page.$('button:has-text("Skip")');
      if (skipButton) await skipButton.click();
      return false;
    }
    
  } catch (error) {
    console.error(`❌ Error posting reply: ${error.message}`);
    return false;
  }
}

async function clickSkip() {
  try {
    const skipButton = await page.$('button:has-text("Skip")');
    if (skipButton) {
      await skipButton.click();
      await sleep(randomDelay(1000, 2000));
    }
  } catch (e) {}
}

// ============================================
// GROK API
// ============================================

async function generateReply(accountConfig, tweetText, tweetAuthor) {
  const messages = [
    {
      role: 'system',
      content: accountConfig.prompt
    },
    {
      role: 'user',
      content: `Tweet from ${tweetAuthor}: "${tweetText}"

Style: ${accountConfig.reply_style}
Tone: ${accountConfig.tone}

Generate a reply (max 280 chars). Be authentic.`
    }
  ];

  try {
    const completion = await grok.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      messages: messages,
      temperature: 0.8,
      max_tokens: 100
    });

    const reply = completion.choices[0].message.content.trim();
    return reply.replace(/^["']|["']$/g, '');
    
  } catch (error) {
    console.error('❌ Grok API Error:', error.message);
    throw error;
  }
}

// ============================================
// ACCOUNT PROCESSING
// ============================================

async function processAccount(accountConfig) {
  const handle = accountConfig.twitter_handle;
  console.log(`\n🎯 Processing ${handle}`);
  
  const weekNumber = getWeekNumber(accountConfig.created_date);
  const limits = getWarmupLimits(weekNumber);
  const todayReplies = getTodayRepliesCount(handle);
  
  console.log(`📅 Week ${weekNumber} - Limit: ${limits.min_replies}-${limits.max_replies}`);
  console.log(`📊 Today's replies: ${todayReplies}/${limits.max_replies}`);
  
  if (todayReplies >= limits.max_replies) {
    console.log(`✋ Max replies reached`);
    return;
  }
  
  try {
    await switchAccount(handle);
    
    const tweets = await scrapeTweets();
    
    for (const tweet of tweets) {
      const currentReplies = getTodayRepliesCount(handle);
      if (currentReplies >= limits.max_replies) break;
      
      if (hasRepliedToTweet(handle, tweet.id)) {
        console.log(`⏭️  Already replied to this tweet`);
        await clickSkip();
        continue;
      }
      
      // Random chance to reply (40%)
      if (Math.random() > 0.4) {
        console.log(`⏭️  Skipping (random)`);
        await clickSkip();
        continue;
      }
      
      console.log(`\n💭 Tweet from @${tweet.author}: "${tweet.text.substring(0, 80)}..."`);
      
      const reply = await generateReply(accountConfig, tweet.text, tweet.author);
      console.log(`📝 Reply: "${reply}"`);
      
      const posted = await postReply(reply);
      
      if (posted) {
        db.prepare(`
          INSERT INTO replies (account_handle, tweet_id, tweet_author, tweet_text, reply_text)
          VALUES (?, ?, ?, ?, ?)
        `).run(handle, tweet.id, tweet.author, tweet.text, reply);
        
        incrementTodayReplies(handle);
        console.log(`✅ Logged to database`);
      }
      
      await sleep(randomDelay(5000, 15000));
    }
    
  } catch (error) {
    console.error(`❌ Error processing ${handle}: ${error.message}`);
  }
}

// ============================================
// SESSION
// ============================================

async function runSession() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 SESSION STARTED`);
  console.log(`${'='.repeat(60)}\n`);
  
  // Exclude 3 random accounts
  const excludedAccounts = shuffle(config.accounts).slice(0, Math.min(3, config.accounts.length - 1));
  const activeAccounts = config.accounts.filter(acc => !excludedAccounts.includes(acc));
  
  console.log(`🚫 Excluded: ${excludedAccounts.map(a => a.twitter_handle).join(', ')}`);
  console.log(`✅ Active: ${activeAccounts.map(a => a.twitter_handle).join(', ')}\n`);
  
  for (const account of shuffle(activeAccounts)) {
    await processAccount(account);
    
    const delayMin = gaussianRandom(3, 10);
    console.log(`\n⏸️  Waiting ${Math.round(delayMin)} minutes...\n`);
    await sleep(delayMin * 60 * 1000);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ SESSION COMPLETED`);
  console.log(`${'='.repeat(60)}\n`);
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log(`🤖 X-Automation Phase 2`);
  console.log(`📊 Accounts: ${config.accounts.length}\n`);
  
  await initBrowser();
  await loginToHypeFury();
  
  while (true) {
    await runSession();
    
    const pauseMin = gaussianRandom(60, 180);
    console.log(`\n😴 Next session in ${Math.round(pauseMin)} minutes...\n`);
    await sleep(pauseMin * 60 * 1000);
  }
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

main().catch(error => {
  console.error('💥 Fatal Error:', error);
  if (browser) browser.close();
  process.exit(1);
});
