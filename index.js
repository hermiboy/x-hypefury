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
    const pidStr = fs.readFileSync(LOCK_FILE, 'utf8');
    const pid = parseInt(pidStr);
    
    // Check if process actually exists
    try {
      process.kill(pid, 0);
      console.error(`❌ Another instance running (PID: ${pid})`);
      console.error(`   Kill: kill ${pid} or rm ${LOCK_FILE}`);
      process.exit(1);
    } catch (e) {
      // Process doesn't exist, stale lock
      console.log('🧹 Removing stale lock file');
      fs.unlinkSync(LOCK_FILE);
    }
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
process.on('SIGTERM', releaseLock);

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
// LOGGING
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

db.pragma('journal_mode = WAL');

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1',
  maxRetries: 3,
  timeout: 30000
});

let browser = null;
let page = null;

// Track API failures per account for circuit breaker
const apiFailures = {};

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
    tweet_age_minutes INTEGER,
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
    target_count INTEGER DEFAULT 0,
    UNIQUE(account_handle, date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    session_num INTEGER NOT NULL,
    account_handle TEXT NOT NULL,
    target_replies INTEGER NOT NULL,
    completed_replies INTEGER DEFAULT 0,
    UNIQUE(date, session_num, account_handle)
  )
`);

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

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

function getTodayStats(accountHandle) {
  const today = getTodayString();
  const row = db.prepare(`
    SELECT * FROM daily_stats 
    WHERE account_handle = ? AND date = ?
  `).get(accountHandle, today);
  
  return row || { replies_count: 0, target_count: 0 };
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

function isWithinActiveHours(accountHandle) {
  const hour = new Date().getHours();
  
  // Get account-specific hours if configured
  const account = config.accounts.find(a => a.twitter_handle === accountHandle);
  const startHour = account?.active_hours?.start || 8;
  const endHour = account?.active_hours?.end || 22;
  
  return hour >= startHour && hour < endHour;
}

function getTweetAge(timestamp) {
  const tweetTime = new Date(timestamp).getTime();
  const now = Date.now();
  return (now - tweetTime) / 60000; // minutes
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
// DAILY PLANNING
// ============================================

function calculateDailyTargets() {
  const today = getTodayString();
  const targets = {};
  
  for (const account of config.accounts) {
    const stats = getTodayStats(account.twitter_handle);
    
    // If target already set, use it
    if (stats.target_count > 0) {
      targets[account.twitter_handle] = {
        target: stats.target_count,
        completed: stats.replies_count,
        remaining: stats.target_count - stats.replies_count
      };
      continue;
    }
    
    // Calculate new target
    const weekNumber = getWeekNumber(account.created_date);
    const limits = getWarmupLimits(weekNumber);
    const target = randomInt(limits.min_replies, limits.max_replies);
    
    // Save to database
    db.prepare(`
      INSERT INTO daily_stats (account_handle, date, replies_count, target_count)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(account_handle, date) 
      DO UPDATE SET target_count = ?
    `).run(account.twitter_handle, today, target, target);
    
    targets[account.twitter_handle] = {
      target: target,
      completed: stats.replies_count,
      remaining: target - stats.replies_count
    };
  }
  
  return targets;
}

function planSessionDistribution(targets, numSessions) {
  const today = getTodayString();
  const plans = {};
  
  // Clear existing plans for today
  db.prepare(`DELETE FROM session_plans WHERE date = ?`).run(today);
  
  for (const [handle, data] of Object.entries(targets)) {
    if (data.remaining <= 0) {
      plans[handle] = [];
      continue;
    }
    
    const sessionTargets = [];
    let remaining = data.remaining;
    
    // Distribute across sessions (minimum 2 appearances)
    const minSessions = Math.min(2, numSessions);
    const actualSessions = Math.min(
      numSessions,
      Math.max(minSessions, Math.ceil(remaining / 8))
    );
    
    for (let i = 0; i < actualSessions; i++) {
      if (remaining <= 0) break;
      
      let sessionTarget;
      if (i === actualSessions - 1) {
        // Last session: take all remaining
        sessionTarget = remaining;
      } else {
        // Distribute randomly
        const avgPerSession = remaining / (actualSessions - i);
        const min = Math.max(1, Math.floor(avgPerSession * 0.6));
        const max = Math.ceil(avgPerSession * 1.4);
        sessionTarget = randomInt(min, max);
        sessionTarget = Math.min(sessionTarget, remaining);
      }
      
      sessionTargets.push(sessionTarget);
      remaining -= sessionTarget;
      
      // Save to database
      db.prepare(`
        INSERT INTO session_plans (date, session_num, account_handle, target_replies)
        VALUES (?, ?, ?, ?)
      `).run(today, i + 1, handle, sessionTarget);
    }
    
    plans[handle] = sessionTargets;
  }
  
  return plans;
}

function getSessionPlan(sessionNum) {
  const today = getTodayString();
  const rows = db.prepare(`
    SELECT account_handle, target_replies, completed_replies
    FROM session_plans
    WHERE date = ? AND session_num = ?
  `).all(today, sessionNum);
  
  const plan = {};
  for (const row of rows) {
    plan[row.account_handle] = {
      target: row.target_replies,
      completed: row.completed_replies
    };
  }
  
  return plan;
}

function updateSessionProgress(sessionNum, accountHandle, count) {
  const today = getTodayString();
  db.prepare(`
    UPDATE session_plans
    SET completed_replies = completed_replies + ?
    WHERE date = ? AND session_num = ? AND account_handle = ?
  `).run(count, today, sessionNum, accountHandle);
}

// ============================================
// TWEET AGE BUCKETS
// ============================================

function categorizeTweetsByAge(tweets) {
  const buckets = {
    fresh: [],    // <10 min
    medium: [],   // 10-30 min
    older: [],    // 30min-2h
    old: []       // 2h-6h
  };
  
  for (const tweet of tweets) {
    const age = getTweetAge(tweet.timestamp);
    
    if (age < 10) buckets.fresh.push(tweet);
    else if (age < 30) buckets.medium.push(tweet);
    else if (age < 120) buckets.older.push(tweet);
    else if (age < 360) buckets.old.push(tweet);
    // Tweets >6h are ignored
  }
  
  return buckets;
}

function selectTweetsWithAgeMix(buckets, numNeeded, isCleanupSession = false) {
  // Cleanup session: more lenient, take older tweets
  let distribution;
  
  if (isCleanupSession) {
    distribution = {
      fresh: randomInt(10, 30),   // 10-30% fresh
      medium: randomInt(20, 40),  // 20-40% medium
      older: randomInt(20, 40),   // 20-40% older
      old: randomInt(10, 30)      // 10-30% old
    };
  } else {
    distribution = {
      fresh: randomInt(20, 40),   // 20-40% fresh
      medium: randomInt(30, 50),  // 30-50% medium
      older: randomInt(10, 30),   // 10-30% older
      old: randomInt(0, 20)       // 0-20% old
    };
  }
  
  // Normalize percentages
  const total = distribution.fresh + distribution.medium + distribution.older + distribution.old;
  for (const key in distribution) {
    distribution[key] = distribution[key] / total;
  }
  
  const selected = [];
  
  // Pick from each bucket
  const pickFrom = (bucket, percentage) => {
    const count = Math.floor(numNeeded * percentage);
    const available = shuffle(bucket);
    return available.slice(0, Math.min(count, available.length));
  };
  
  selected.push(...pickFrom(buckets.fresh, distribution.fresh));
  selected.push(...pickFrom(buckets.medium, distribution.medium));
  selected.push(...pickFrom(buckets.older, distribution.older));
  selected.push(...pickFrom(buckets.old, distribution.old));
  
  // If not enough, fill from any bucket
  if (selected.length < numNeeded) {
    const allRemaining = [
      ...buckets.fresh,
      ...buckets.medium,
      ...buckets.older,
      ...buckets.old
    ].filter(t => !selected.find(s => s.id === t.id));
    
    const needed = numNeeded - selected.length;
    selected.push(...shuffle(allRemaining).slice(0, needed));
  }
  
  return shuffle(selected);
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
  
  logger.info('✅ Browser ready');
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

async function loginToHypeFury() {
  logger.info('🔐 Opening HypeFury...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  
  await sleep(3000);
  
  const isLoggedIn = await page.evaluate(() => {
    return document.body.innerText.includes('Engagement Builder') ||
           document.querySelector('[class*="engagement"]') !== null;
  });
  
  if (!isLoggedIn) {
    logger.warn('⚠️  Not logged in - waiting 60s...');
    await takeScreenshot('login-required');
    await sleep(60000);
  } else {
    logger.info('✅ Logged in to HypeFury');
  }
  
  await takeScreenshot('hypefury-loaded');
}

async function switchAccount(accountHandle) {
  logger.info(`🔄 Switching to ${accountHandle}...`);
  
  try {
    // Click dropdown
    const dropdownClicked = await page.evaluate(() => {
      const elements = document.querySelectorAll('[class*="follower"], button, a');
      for (const el of elements) {
        if (el.textContent.includes('follower')) {
          el.click();
          return true;
        }
      }
      return false;
    });
    
    if (!dropdownClicked) {
      logger.warn('⚠️  Dropdown not found');
      return false;
    }
    
    await sleep(gaussianRandom(1000, 2000));
    
    const handle = accountHandle.replace('@', '');
    const switched = await page.evaluate((h) => {
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const target = buttons.find(el => el.textContent.includes(h));
      if (target) {
        target.click();
        return true;
      }
      return false;
    }, handle);
    
    if (switched) {
      await sleep(gaussianRandom(2000, 4000));
      await takeScreenshot(`switched-${accountHandle}`);
      logger.info(`✅ Switched to ${accountHandle}`);
      return true;
    } else {
      logger.warn(`⚠️  Account ${accountHandle} not found`);
      return false;
    }
    
  } catch (error) {
    logger.error(`❌ Switch failed: ${error.message}`);
    await takeScreenshot('switch-failed');
    return false;
  }
}

async function scrapeTweets() {
  logger.info('📡 Scraping tweets...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  
  await sleep(gaussianRandom(3000, 5000));
  
  try {
    const tweets = await page.evaluate(() => {
      const results = [];
      const selectors = ['[role="dialog"]', '[class*="tweet"]', '[data-testid*="tweet"]'];
      
      let cards = [];
      for (const sel of selectors) {
        cards = document.querySelectorAll(sel);
        if (cards.length > 0) break;
      }
      
      for (const card of cards) {
        try {
          const authorEl = card.querySelector('strong, [class*="author"], [class*="name"]');
          const author = authorEl ? authorEl.textContent.trim() : 'Unknown';
          
          const textEl = card.querySelector('p, [class*="text"], [class*="content"]');
          const text = textEl ? textEl.textContent.trim() : '';
          
          const timeEl = card.querySelector('time, [datetime]');
          const timestamp = timeEl ? 
            (timeEl.getAttribute('datetime') || new Date().toISOString()) : 
            new Date().toISOString();
          
          if (text.length > 10) {
            results.push({ author, text, timestamp });
          }
        } catch (e) {}
      }
      
      return results;
    });
    
    // Generate stable IDs using helper function
    const tweetsWithIds = tweets.map(t => ({
      ...t,
      id: stableTweetId(t.author, t.text, t.timestamp)
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
    const textareaSelector = 'textarea[placeholder*="say"], textarea[placeholder*="reply"], textarea';
    await page.waitForSelector(textareaSelector, { timeout: 10000 });
    
    await humanType(textareaSelector, replyText);
    await sleep(gaussianRandom(1000, 3000));
    
    await takeScreenshot('reply-typed');
    
    // Click Reply button (NO :has-text() - fixed!)
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
      logger.warn('⚠️  Reply button not found');
      await clickSkip();
      return false;
    }
    
  } catch (error) {
    logger.error(`❌ Post failed: ${error.message}`);
    await takeScreenshot('post-failed');
    return false;
  }
}

async function clickSkip() {
  // Fixed: NO :has-text()
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const skipBtn = buttons.find(b => b.textContent.toLowerCase().includes('skip'));
    if (skipBtn) skipBtn.click();
  }).catch(() => {});
  await sleep(gaussianRandom(500, 1500));
}

// ============================================
// GROK API WITH CIRCUIT BREAKER
// ============================================

async function generateReply(accountConfig, tweetText, tweetAuthor) {
  const handle = accountConfig.twitter_handle;
  
  // Circuit breaker check
  if (apiFailures[handle] >= 5) {
    const lastFailTime = apiFailures[`${handle}_time`] || 0;
    const hoursSinceLastFail = (Date.now() - lastFailTime) / 3600000;
    
    if (hoursSinceLastFail < 1) {
      logger.warn(`🚫 Circuit breaker: ${handle} paused for 1 hour`);
      throw new Error('Circuit breaker active');
    } else {
      // Reset after cooldown
      apiFailures[handle] = 0;
    }
  }
  
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
    
    // Reset failure counter on success
    apiFailures[handle] = 0;
    
    return reply.replace(/^["']|["']$/g, '');
    
  } catch (error) {
    logger.error(`❌ Grok API Error: ${error.message}`);
    
    // Increment failure counter
    apiFailures[handle] = (apiFailures[handle] || 0) + 1;
    apiFailures[`${handle}_time`] = Date.now();
    
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

async function processAccount(accountConfig, sessionNum, isCleanupSession = false) {
  const handle = accountConfig.twitter_handle;
  logger.info(`\n🎯 Processing ${handle}`);
  
  // Get session plan
  const plan = getSessionPlan(sessionNum);
  const accountPlan = plan[handle];
  
  if (!accountPlan) {
    logger.debug(`⏭️  ${handle} not in session ${sessionNum} plan`);
    return;
  }
  
  const targetReplies = accountPlan.target;
  let repliesMade = 0;
  
  logger.info(`📋 Session ${sessionNum} target: ${targetReplies} replies`);
  
  try {
    const switched = await switchAccount(handle);
    if (!switched && !TEST_MODE) return;
    
    const allTweets = await scrapeTweets();
    
    if (allTweets.length === 0) {
      logger.warn('⚠️  No tweets found');
      return;
    }
    
    // Categorize by age
    const buckets = categorizeTweetsByAge(allTweets);
    logger.debug(`Tweet buckets: fresh=${buckets.fresh.length}, medium=${buckets.medium.length}, older=${buckets.older.length}, old=${buckets.old.length}`);
    
    // Get account-specific config
    const skipRate = accountConfig.skip_rate || 0.6;
    const maxAttempts = Math.ceil(targetReplies / (1 - skipRate)) + 5; // Buffer
    
    // Select tweets with age mix
    const selectedTweets = selectTweetsWithAgeMix(buckets, maxAttempts, isCleanupSession);
    logger.info(`📝 Selected ${selectedTweets.length} tweets (mix of ages)`);
    
    for (const tweet of selectedTweets) {
      if (repliesMade >= targetReplies) {
        logger.info(`✅ Target reached (${repliesMade}/${targetReplies})`);
        break;
      }
      
      // Check if already replied
      if (hasRepliedToTweet(handle, tweet.id)) {
        logger.debug(`⏭️  Already replied to ${tweet.id}`);
        await clickSkip();
        continue;
      }
      
      // Random skip (account-specific rate)
      if (Math.random() < skipRate) {
        logger.debug(`⏭️  Random skip (${Math.round(skipRate*100)}% rate)`);
        await clickSkip();
        continue;
      }
      
      const tweetAge = getTweetAge(tweet.timestamp);
      logger.info(`\n💭 @${tweet.author} (age: ${Math.round(tweetAge)}min): "${tweet.text.substring(0, 60)}..."`);
      
      const reply = await generateReply(accountConfig, tweet.text, tweet.author);
      logger.info(`📝 Reply: "${reply}"`);
      
      const posted = await postReply(reply);
      
      // Log to database
      db.prepare(`
        INSERT OR IGNORE INTO replies (account_handle, tweet_id, tweet_author, tweet_text, reply_text, tweet_age_minutes, posted)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(handle, tweet.id, tweet.author, tweet.text, reply, Math.round(tweetAge), posted ? 1 : 0);
      
      if (posted) {
        incrementTodayReplies(handle);
        updateSessionProgress(sessionNum, handle, 1);
        repliesMade++;
        logger.info(`✅ Progress: ${repliesMade}/${targetReplies}`);
      }
      
      await sleep(gaussianRandom(5000, 15000));
    }
    
    if (repliesMade < targetReplies) {
      logger.warn(`⚠️  Only completed ${repliesMade}/${targetReplies} (not enough tweets)`);
    }
    
  } catch (error) {
    logger.error(`❌ Error processing ${handle}: ${error.message}`);
    await takeScreenshot(`error-${handle}`);
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function runSession(sessionNum, totalSessions) {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`🚀 SESSION ${sessionNum}/${totalSessions} STARTED`);
  logger.info(`${'='.repeat(60)}\n`);
  
  const isCleanupSession = sessionNum >= totalSessions;
  
  if (isCleanupSession) {
    logger.info('🧹 CLEANUP SESSION - Must complete all targets!');
  }
  
  // Get session plan
  const plan = getSessionPlan(sessionNum);
  const accountsInSession = Object.keys(plan);
  
  if (accountsInSession.length === 0) {
    logger.info('⏭️  No accounts scheduled for this session');
    return;
  }
  
  // Filter by TEST_ACCOUNT if specified
  let accounts = config.accounts.filter(a => accountsInSession.includes(a.twitter_handle));
  
  if (TEST_ACCOUNT) {
    accounts = accounts.filter(a => a.twitter_handle === TEST_ACCOUNT);
    logger.info(`🧪 TEST MODE: Only ${TEST_ACCOUNT}`);
  }
  
  logger.info(`✅ Accounts in session: ${accounts.map(a => a.twitter_handle).join(', ')}\n`);
  
  // Shuffle order
  const shuffledAccounts = shuffle(accounts);
  
  for (const account of shuffledAccounts) {
    if (!isWithinActiveHours(account.twitter_handle) && !TEST_MODE) {
      logger.info(`⏰ ${account.twitter_handle} outside active hours`);
      continue;
    }
    
    await processAccount(account, sessionNum, isCleanupSession);
    
    const delayMin = gaussianRandom(3, 10);
    logger.info(`\n⏸️  Waiting ${Math.round(delayMin)} minutes...\n`);
    await sleep(delayMin * 60 * 1000);
  }
  
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`✅ SESSION ${sessionNum} COMPLETED`);
  logger.info(`${'='.repeat(60)}\n`);
}

// ============================================
// HEALTH CHECK
// ============================================

async function healthCheck() {
  logger.info('🏥 Running health check...\n');
  
  const checks = {
    chrome: false,
    grok: false,
    database: false,
    hypefury: false
  };
  
  // Chrome
  try {
    if (fs.existsSync('/usr/bin/google-chrome')) {
      checks.chrome = true;
      logger.info('✅ Chrome installed');
    } else {
      logger.error('❌ Chrome not found');
    }
  } catch (e) {
    logger.error(`❌ Chrome check failed: ${e.message}`);
  }
  
  // Grok
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
  
  // Database
  try {
    db.prepare('SELECT 1').get();
    checks.database = true;
    logger.info('✅ Database writable');
  } catch (e) {
    logger.error(`❌ Database failed: ${e.message}`);
  }
  
  // HypeFury
  try {
    await initBrowser();
    await page.goto('https://app.hypefury.com', { timeout: 20000 });
    checks.hypefury = true;
    logger.info('✅ HypeFury reachable');
    await browser.close();
  } catch (e) {
    logger.error(`❌ HypeFury failed: ${e.message}`);
    if (browser) await browser.close();
  }
  
  logger.info('\n📊 Health Summary:');
  const allGood = Object.values(checks).every(v => v);
  if (allGood) {
    logger.info('🎉 All systems operational!');
  } else {
    logger.warn('⚠️  Some checks failed');
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
  
  logger.info(`🤖 X-Automation System - ULTIMATE`);
  logger.info(`📅 Mode: ${DRY_RUN ? 'DRY-RUN' : 'PRODUCTION'}`);
  logger.info(`🐛 Debug: ${DEBUG ? 'ON' : 'OFF'}`);
  logger.info(`📊 Accounts: ${config.accounts.length}\n`);
  
  await initBrowser();
  await loginToHypeFury();
  
  // Calculate daily targets
  const targets = calculateDailyTargets();
  logger.info('📋 Daily Targets:');
  for (const [handle, data] of Object.entries(targets)) {
    logger.info(`   ${handle}: ${data.target} replies (${data.completed} done, ${data.remaining} remaining)`);
  }
  
  // Plan sessions (3-4 per day)
  const numSessions = 3;
  const sessionPlan = planSessionDistribution(targets, numSessions);
  
  logger.info('\n📅 Session Distribution:');
  for (const [handle, sessions] of Object.entries(sessionPlan)) {
    if (sessions.length > 0) {
      logger.info(`   ${handle}: [${sessions.join(', ')}] across ${sessions.length} sessions`);
    }
  }
  logger.info('');
  
  if (TEST_MODE) {
    logger.info('🧪 TEST MODE - Running session 1 only\n');
    await runSession(1, numSessions);
    logger.info('\n✅ Test complete!');
    if (browser) await browser.close();
    process.exit(0);
  }
  
  // Production loop
  let currentSession = 1;
  
  while (true) {
    if (isWithinActiveHours(config.accounts[0].twitter_handle)) {
      await runSession(currentSession, numSessions);
      
      currentSession++;
      if (currentSession > numSessions) {
        // Reset for next day
        logger.info('🌙 All sessions complete for today. Sleeping until tomorrow...\n');
        await sleep(6 * 60 * 60 * 1000); // 6 hours
        currentSession = 1;
        
        // Recalculate for new day
        const newTargets = calculateDailyTargets();
        planSessionDistribution(newTargets, numSessions);
      } else {
        // Wait between sessions
        const pauseMin = gaussianRandom(60, 180);
        logger.info(`\n😴 Next session in ${Math.round(pauseMin)} minutes...\n`);
        await sleep(pauseMin * 60 * 1000);
      }
    } else {
      logger.info('😴 Outside active hours - sleeping 30 min\n');
      await sleep(30 * 60 * 1000);
    }
  }
}

// ============================================
// RUN
// ============================================

main().catch(async (error) => {
  logger.error(`💥 Fatal Error: ${error.message}`);
  logger.error(error.stack);
  await takeScreenshot('fatal-error');
  if (browser) await browser.close();
  releaseLock();
  process.exit(1);
});
