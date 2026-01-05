#!/usr/bin/env node
import dotenv from 'dotenv';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import puppeteer from 'puppeteer';
import winston from 'winston';

dotenv.config();

// ============================================
// SINGLE INSTANCE LOCK
// ============================================

const LOCK_FILE = '/tmp/x-automation.lock';

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = fs.readFileSync(LOCK_FILE, 'utf8');
    console.error(`❌ Another instance is running (PID: ${pid})`);
    console.error(`   Kill it first: kill ${pid}`);
    process.exit(1);
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) {
    fs.unlinkSync(LOCK_FILE);
  }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => {
  logger.info('🛑 Shutting down...');
  releaseLock();
  process.exit(0);
});

acquireLock();

// ============================================
// CONFIG & ENV
// ============================================

const DRY_RUN = process.env.DRY_RUN === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TEST_MODE = process.argv.includes('--test');
const HEALTH_CHECK = process.argv.includes('--health');
const TEST_ACCOUNT = process.env.TEST_ACCOUNT;

// ============================================
// LOGGING SETUP
// ============================================

if (!fs.existsSync('./logs')) fs.mkdirSync('./logs');
if (!fs.existsSync('./logs/screenshots')) fs.mkdirSync('./logs/screenshots');

const logger = winston.createLogger({
  level: DEBUG ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ 
      filename: `./logs/${new Date().toISOString().split('T')[0]}.log`,
      level: 'info'
    }),
    new winston.transports.File({ 
      filename: './logs/errors.log',
      level: 'error'
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`)
      )
    })
  ]
});

// ============================================
// INIT
// ============================================

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const db = new Database('automation.db');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
  maxRetries: 3,
  timeout: 30000
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
    posted BOOLEAN DEFAULT 1,
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

// Create indexes
db.exec(`CREATE INDEX IF NOT EXISTS idx_replies_account ON replies(account_handle)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_account_date ON daily_stats(account_handle, date)`);

logger.info('✅ Database initialized with WAL mode');

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

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function stableTweetId(author, text, timestamp) {
  const input = `${author}||${text.substring(0, 300)}||${timestamp}`;
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
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

function isWithinActiveHours() {
  const hour = new Date().getHours();
  return hour >= 8 && hour < 22;
}

async function takeScreenshot(name) {
  if (!page) return;
  try {
    const filename = `./logs/screenshots/${name}-${Date.now()}.png`;
    await page.screenshot({ path: filename, fullPage: false });
    logger.debug(`📸 Screenshot: ${filename}`);
  } catch (e) {
    logger.error(`Screenshot failed: ${e.message}`);
  }
}

// ============================================
// BROWSER AUTOMATION
// ============================================

async function initBrowser() {
  logger.info('🌐 Starting browser...');
  
  const userDataDir = path.join(process.cwd(), '.chrome-profile');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir);
  
  browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    userDataDir: userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });
  
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  logger.info('✅ Browser ready with persistent profile');
}

async function humanType(selector, text) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector);
  await sleep(gaussianRandom(300, 800));
  
  for (const char of text.split('')) {
    await page.keyboard.type(char);
    await sleep(gaussianRandom(50, 150));
  }
}

async function robustClick(selector, description) {
  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    await sleep(gaussianRandom(500, 1500));
    logger.debug(`✅ Clicked: ${description}`);
    return true;
  } catch (e) {
    logger.warn(`⚠️  Could not click ${description}: ${e.message}`);
    await takeScreenshot(`failed-click-${description}`);
    return false;
  }
}

async function loginToHypeFury() {
  logger.info('🔐 Opening HypeFury...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  
  await sleep(3000);
  
  // Check if logged in by looking for engagement builder elements
  const isLoggedIn = await page.evaluate(() => {
    return document.body.innerText.includes('Engagement Builder') ||
           document.querySelector('[class*="engagement"]') !== null;
  });
  
  if (!isLoggedIn) {
    logger.warn('⚠️  Not logged in - waiting 60 seconds for manual login...');
    await takeScreenshot('login-required');
    await sleep(60000);
  } else {
    logger.info('✅ Already logged in to HypeFury');
  }
  
  await takeScreenshot('hypefury-loaded');
}

async function switchAccount(accountHandle) {
  logger.info(`🔄 Switching to ${accountHandle}...`);
  
  try {
    // Try to find and click account dropdown
    const dropdownClicked = await robustClick('[class*="follower"]', 'account-dropdown');
    if (!dropdownClicked) return false;
    
    await sleep(gaussianRandom(1000, 2000));
    
    // Find account by handle (without @)
    const handle = accountHandle.replace('@', '');
    const accountFound = await page.evaluate((h) => {
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const target = buttons.find(el => el.textContent.includes(h));
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, handle);
    
    if (accountFound) {
      await sleep(gaussianRandom(2000, 4000));
      await takeScreenshot(`switched-${accountHandle}`);
      logger.info(`✅ Switched to ${accountHandle}`);
      return true;
    } else {
      logger.warn(`⚠️  Account ${accountHandle} not found`);
      return false;
    }
    
  } catch (error) {
    logger.error(`❌ Switch account failed: ${error.message}`);
    await takeScreenshot('switch-failed');
    return false;
  }
}

async function scrapeTweets() {
  logger.info('📡 Scraping tweets from feed...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  
  await sleep(gaussianRandom(3000, 5000));
  
  try {
    const tweets = await page.evaluate(() => {
      const results = [];
      
      // Find tweet cards - try multiple selectors
      const selectors = [
        '[role="dialog"]',
        '[class*="tweet"]',
        '[data-testid*="tweet"]'
      ];
      
      let cards = [];
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel);
        if (cards.length > 0) break;
      }
      
      for (const card of cards) {
        try {
          // Find author
          const authorEl = card.querySelector('strong, [class*="author"], [class*="name"]');
          const author = authorEl ? authorEl.textContent.trim() : 'Unknown';
          
          // Find text
          const textEl = card.querySelector('p, [class*="text"], [class*="content"]');
          const text = textEl ? textEl.textContent.trim() : '';
          
          // Find timestamp
          const timeEl = card.querySelector('time, [datetime]');
          const timestamp = timeEl ? 
            (timeEl.getAttribute('datetime') || new Date().toISOString()) : 
            new Date().toISOString();
          
          if (text.length > 10) {
            results.push({ author, text, timestamp });
          }
        } catch (e) {
          // Skip invalid elements
        }
      }
      
      return results;
    });
    
    // Generate stable IDs
    const tweetsWithIds = tweets.map(t => ({
      ...t,
      id: crypto.createHash('sha256')
        .update(`${t.author}||${t.text.substring(0, 300)}||${t.timestamp}`)
        .digest('hex').substring(0, 16)
    }));
    
    logger.info(`📨 Found ${tweetsWithIds.length} tweets`);
    await takeScreenshot('scraped-tweets');
    return tweetsWithIds;
    
  } catch (error) {
    logger.error(`❌ Scraping failed: ${error.message}`);
    await takeScreenshot('scrape-failed');
    return [];
  }
}

async function postReply(replyText) {
  if (DRY_RUN) {
    logger.info(`🔸 [DRY-RUN] Would post: "${replyText}"`);
    return true;
  }
  
  logger.info('💬 Posting reply...');
  
  try {
    // Find reply textarea
    const textareaSelector = 'textarea[placeholder*="say"], textarea[placeholder*="reply"], textarea';
    await page.waitForSelector(textareaSelector, { timeout: 10000 });
    
    await humanType(textareaSelector, replyText);
    await sleep(gaussianRandom(1000, 3000));
    
    await takeScreenshot('reply-typed');
    
    // Click Reply button
    const replyClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const replyBtn = buttons.find(b => 
        b.textContent.toLowerCase().includes('reply') && 
        !b.textContent.toLowerCase().includes('quote')
      );
      if (replyBtn) {
        replyBtn.click();
        return true;
      }
      return false;
    });
    
    if (replyClicked) {
      await sleep(gaussianRandom(3000, 6000));
      await takeScreenshot('reply-posted');
      logger.info('✅ Reply posted');
      return true;
    } else {
      logger.warn('⚠️  Reply button not found - clicking Skip');
      await robustClick('button:has-text("Skip")', 'skip-button');
      return false;
    }
    
  } catch (error) {
    logger.error(`❌ Post reply failed: ${error.message}`);
    await takeScreenshot('post-failed');
    return false;
  }
}

async function clickSkip() {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const skipBtn = buttons.find(b => b.textContent.toLowerCase().includes('skip'));
    if (skipBtn) skipBtn.click();
  }).catch(() => {});
  await sleep(gaussianRandom(500, 1500));
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

Generate ONE reply (max 280 chars). Be authentic.`
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
    logger.error(`❌ Grok API Error: ${error.message}`);
    
    // Circuit breaker: if too many failures, pause
    if (error.status === 429) {
      logger.warn('⚠️  Rate limited - sleeping 60s');
      await sleep(60000);
    }
    
    throw error;
  }
}

// ============================================
// ACCOUNT PROCESSING
// ============================================

async function processAccount(accountConfig) {
  const handle = accountConfig.twitter_handle;
  logger.info(`\n🎯 Processing ${handle}`);
  
  const weekNumber = getWeekNumber(accountConfig.created_date);
  const limits = getWarmupLimits(weekNumber);
  const todayReplies = getTodayRepliesCount(handle);
  
  logger.info(`📅 Week ${weekNumber} - Limit: ${limits.min_replies}-${limits.max_replies}`);
  logger.info(`📊 Today's replies: ${todayReplies}/${limits.max_replies}`);
  
  if (todayReplies >= limits.max_replies) {
    logger.info(`✋ Max replies reached for ${handle}`);
    return;
  }
  
  try {
    const switched = await switchAccount(handle);
    if (!switched && !TEST_MODE) return;
    
    const tweets = await scrapeTweets();
    
    for (const tweet of tweets) {
      const currentReplies = getTodayRepliesCount(handle);
      if (currentReplies >= limits.max_replies) break;
      
      if (hasRepliedToTweet(handle, tweet.id)) {
        logger.debug(`⏭️  Already replied to ${tweet.id}`);
        await clickSkip();
        continue;
      }
      
      // Random chance to reply (40%)
      if (Math.random() > 0.4) {
        logger.debug(`⏭️  Skipping (random 60%)`);
        await clickSkip();
        continue;
      }
      
      logger.info(`\n💭 @${tweet.author}: "${tweet.text.substring(0, 60)}..."`);
      
      const reply = await generateReply(accountConfig, tweet.text, tweet.author);
      logger.info(`📝 Reply: "${reply}"`);
      
      const posted = await postReply(reply);
      
      // Log to database
      db.prepare(`
        INSERT OR IGNORE INTO replies (account_handle, tweet_id, tweet_author, tweet_text, reply_text, posted)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(handle, tweet.id, tweet.author, tweet.text, reply, posted ? 1 : 0);
      
      if (posted) {
        incrementTodayReplies(handle);
        logger.info(`✅ Logged to database`);
      }
      
      await sleep(gaussianRandom(5000, 15000));
    }
    
  } catch (error) {
    logger.error(`❌ Error processing ${handle}: ${error.message}`);
    await takeScreenshot(`error-${handle}`);
  }
}

// ============================================
// SESSION
// ============================================

async function runSession() {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`🚀 SESSION STARTED`);
  logger.info(`${'='.repeat(60)}\n`);
  
  let accounts = config.accounts;
  
  // Filter by TEST_ACCOUNT if specified
  if (TEST_ACCOUNT) {
    accounts = accounts.filter(a => a.twitter_handle === TEST_ACCOUNT);
    logger.info(`🧪 TEST MODE: Only ${TEST_ACCOUNT}`);
  }
  
  // Exclude 3 random accounts
  const numExclude = Math.min(3, accounts.length - 1);
  const excludedAccounts = shuffle(accounts).slice(0, numExclude);
  const activeAccounts = accounts.filter(acc => !excludedAccounts.includes(acc));
  
  if (excludedAccounts.length > 0) {
    logger.info(`🚫 Excluded: ${excludedAccounts.map(a => a.twitter_handle).join(', ')}`);
  }
  logger.info(`✅ Active: ${activeAccounts.map(a => a.twitter_handle).join(', ')}\n`);
  
  for (const account of shuffle(activeAccounts)) {
    if (!isWithinActiveHours() && !TEST_MODE) {
      logger.info('⏰ Outside active hours (8-22) - pausing');
      break;
    }
    
    await processAccount(account);
    
    const delayMin = gaussianRandom(3, 10);
    logger.info(`\n⏸️  Waiting ${Math.round(delayMin)} minutes...\n`);
    await sleep(delayMin * 60 * 1000);
  }
  
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`✅ SESSION COMPLETED`);
  logger.info(`${'='.repeat(60)}\n`);
}

// ============================================
// HEALTH CHECK
// ============================================

async function healthCheck() {
  logger.info('🏥 Running health check...\n');
  
  const checks = {
    chrome: false,
    hypefury: false,
    grok: false,
    database: false
  };
  
  // Check Chrome
  try {
    if (fs.existsSync('/usr/bin/google-chrome')) {
      checks.chrome = true;
      logger.info('✅ Chrome installed');
    } else {
      logger.error('❌ Chrome not found at /usr/bin/google-chrome');
    }
  } catch (e) {
    logger.error(`❌ Chrome check failed: ${e.message}`);
  }
  
  // Check Grok API
  try {
    await grok.chat.completions.create({
      model: 'grok-4-1-fast-non-reasoning',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 5
    });
    checks.grok = true;
    logger.info('✅ Grok API working');
  } catch (e) {
    logger.error(`❌ Grok API failed: ${e.message}`);
  }
  
  // Check Database
  try {
    db.prepare('SELECT 1').get();
    checks.database = true;
    logger.info('✅ Database writable');
  } catch (e) {
    logger.error(`❌ Database failed: ${e.message}`);
  }
  
  // Check HypeFury (requires browser)
  try {
    await initBrowser();
    await page.goto('https://app.hypefury.com', { timeout: 20000 });
    checks.hypefury = true;
    logger.info('✅ HypeFury reachable');
    await browser.close();
  } catch (e) {
    logger.error(`❌ HypeFury check failed: ${e.message}`);
    if (browser) await browser.close();
  }
  
  logger.info('\n📊 Health Summary:');
  const allGood = Object.values(checks).every(v => v);
  if (allGood) {
    logger.info('🎉 All systems operational!');
  } else {
    logger.warn('⚠️  Some checks failed - review above');
  }
  
  return allGood;
}

// ============================================
// MAIN
// ============================================

async function main() {
  if (HEALTH_CHECK) {
    await healthCheck();
    process.exit(0);
  }
  
  logger.info(`🤖 X-Automation System v3`);
  logger.info(`📅 Mode: ${DRY_RUN ? 'DRY-RUN' : 'PRODUCTION'}`);
  logger.info(`🐛 Debug: ${DEBUG ? 'ON' : 'OFF'}`);
  logger.info(`📊 Accounts: ${config.accounts.length}\n`);
  
  await initBrowser();
  await loginToHypeFury();
  
  if (TEST_MODE) {
    logger.info('🧪 TEST MODE - Running single session\n');
    await runSession();
    logger.info('\n✅ Test complete!');
    if (browser) await browser.close();
    process.exit(0);
  }
  
  // Production loop
  while (true) {
    if (isWithinActiveHours()) {
      await runSession();
      
      const pauseMin = gaussianRandom(60, 180);
      logger.info(`\n😴 Next session in ${Math.round(pauseMin)} minutes...\n`);
      await sleep(pauseMin * 60 * 1000);
    } else {
      logger.info('😴 Outside active hours - sleeping 30 minutes\n');
      await sleep(30 * 60 * 1000);
    }
  }
}

// ============================================
// RUN
// ============================================

main().catch(async (error) => {
  logger.error(`💥 Fatal Error: ${error.message}`);
  await takeScreenshot('fatal-error');
  if (browser) await browser.close();
  releaseLock();
  process.exit(1);
});
