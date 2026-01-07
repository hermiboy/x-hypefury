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
    try {
      process.kill(pid, 0);
      console.error(`❌ Another instance running (PID: ${pid})`);
      process.exit(1);
    } catch (e) {
      console.log('🧹 Removing stale lock');
      fs.unlinkSync(LOCK_FILE);
    }
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock() {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
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
// CONFIG
// ============================================

const DRY_RUN = process.env.DRY_RUN === 'true';
const DEBUG = process.env.DEBUG === 'true';
const TEST_MODE = process.argv.includes('--test');
const HEALTH_CHECK = process.argv.includes('--health');

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
    tweet_likes INTEGER,
    engagement_score REAL,
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
    likes_count INTEGER DEFAULT 0,
    retweets_count INTEGER DEFAULT 0,
    target_replies INTEGER DEFAULT 0,
    is_low_activity_day BOOLEAN DEFAULT 0,
    UNIQUE(account_handle, date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS replied_authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_handle TEXT NOT NULL,
    tweet_author TEXT NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(account_handle, tweet_author, date)
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_replies_account ON replies(account_handle)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_date ON daily_stats(account_handle, date)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_authors ON replied_authors(account_handle, date)`);

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
  return row || { 
    replies_count: 0, 
    likes_count: 0,
    retweets_count: 0,
    target_replies: 0,
    is_low_activity_day: 0
  };
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

function incrementTodayLikes(accountHandle) {
  const today = getTodayString();
  db.prepare(`
    INSERT INTO daily_stats (account_handle, date, likes_count)
    VALUES (?, ?, 1)
    ON CONFLICT(account_handle, date) 
    DO UPDATE SET likes_count = likes_count + 1
  `).run(accountHandle, today);
}

function incrementTodayRetweets(accountHandle) {
  const today = getTodayString();
  db.prepare(`
    INSERT INTO daily_stats (account_handle, date, retweets_count)
    VALUES (?, ?, 1)
    ON CONFLICT(account_handle, date) 
    DO UPDATE SET retweets_count = retweets_count + 1
  `).run(accountHandle, today);
}

function hasRepliedToAuthor(accountHandle, tweetAuthor) {
  const today = getTodayString();
  const row = db.prepare(`
    SELECT id FROM replied_authors 
    WHERE account_handle = ? AND tweet_author = ? AND date = ?
  `).get(accountHandle, tweetAuthor, today);
  return !!row;
}

function markRepliedToAuthor(accountHandle, tweetAuthor) {
  const today = getTodayString();
  db.prepare(`
    INSERT OR IGNORE INTO replied_authors (account_handle, tweet_author, date)
    VALUES (?, ?, ?)
  `).run(accountHandle, tweetAuthor, today);
}

function getTweetAge(timestamp) {
  const tweetTime = new Date(timestamp).getTime();
  const now = Date.now();
  return (now - tweetTime) / 60000; // minutes
}

function calculateEngagementScore(tweet, accountConfig) {
  const age = getTweetAge(tweet.timestamp);
  const likes = tweet.likes || 0;
  
  // Likes per minute
  const likesPerMinute = likes / Math.max(age, 1);
  
  // Age multiplier
  let ageMultiplier = 1.0;
  if (age < 15) ageMultiplier = 2.0;
  else if (age < 30) ageMultiplier = 1.5;
  else if (age < 60) ageMultiplier = 1.2;
  else if (age < 120) ageMultiplier = 1.0;
  else if (age < 360) ageMultiplier = 0.5;
  else ageMultiplier = 0.2;
  
  // Account speed personality
  const speedBias = accountConfig.speed_personality || 'medium';
  if (speedBias === 'fast' && age < 15) ageMultiplier *= 1.3;
  if (speedBias === 'slow' && age > 30) ageMultiplier *= 1.2;
  
  return likesPerMinute * ageMultiplier;
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
    
    if (stats.target_replies > 0) {
      targets[account.twitter_handle] = {
        target: stats.target_replies,
        completed: stats.replies_count,
        remaining: stats.target_replies - stats.replies_count,
        isLowDay: stats.is_low_activity_day === 1
      };
      continue;
    }
    
    const weekNumber = getWeekNumber(account.created_date);
    const limits = getWarmupLimits(weekNumber);
    
    // Low activity day (15% chance)
    const isLowDay = Math.random() < 0.15;
    const target = isLowDay ? randomInt(5, 8) : randomInt(limits.min_replies, limits.max_replies);
    
    db.prepare(`
      INSERT INTO daily_stats (account_handle, date, replies_count, target_replies, is_low_activity_day)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(account_handle, date) 
      DO UPDATE SET target_replies = ?, is_low_activity_day = ?
    `).run(account.twitter_handle, today, target, isLowDay ? 1 : 0, target, isLowDay ? 1 : 0);
    
    targets[account.twitter_handle] = {
      target: target,
      completed: 0,
      remaining: target,
      isLowDay: isLowDay
    };
  }
  
  return targets;
}

// ============================================
// BROWSER AUTOMATION
// ============================================

async function initBrowser() {
  logger.info('🌐 Starting browser...');
  
  const userDataDir = path.join(process.cwd(), '.chrome-profile');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir);
  
  const proxyConfig = config.proxy;
  const proxyServer = `http://${proxyConfig.host}:${proxyConfig.port}`;
  
  browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    userDataDir: userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--proxy-server=${proxyServer}`,
      '--window-size=1920,1080'
    ]
  });
  
  page = await browser.newPage();
  
  // Authenticate proxy
  await page.authenticate({
    username: proxyConfig.username,
    password: proxyConfig.password
  });
  
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  logger.info('✅ Browser ready with proxy');
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
          
          // Try to get likes
          const likesEl = card.querySelector('[aria-label*="like"], [class*="like"]');
          const likesText = likesEl ? likesEl.textContent.trim() : '0';
          const likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
          
          if (text.length > 10) {
            results.push({ author, text, timestamp, likes });
          }
        } catch (e) {}
      }
      
      return results;
    });
    
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
      return false;
    }
    
  } catch (error) {
    logger.error(`❌ Post failed: ${error.message}`);
    await takeScreenshot('post-failed');
    return false;
  }
}

async function postLike() {
  if (DRY_RUN) {
    logger.info(`🔸 [DRY-RUN] Would like`);
    return true;
  }
  
  try {
    const liked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const likeBtn = buttons.find(b => 
        b.textContent.toLowerCase().includes('like') ||
        b.querySelector('[aria-label*="like"]')
      );
      if (likeBtn) {
        likeBtn.click();
        return true;
      }
      return false;
    });
    
    if (liked) {
      await sleep(gaussianRandom(500, 1500));
      logger.info('✅ Liked');
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`❌ Like failed: ${error.message}`);
    return false;
  }
}

async function postRetweet() {
  if (DRY_RUN) {
    logger.info(`🔸 [DRY-RUN] Would retweet`);
    return true;
  }
  
  try {
    const retweeted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const rtBtn = buttons.find(b => 
        b.textContent.toLowerCase().includes('retweet')
      );
      if (rtBtn) {
        rtBtn.click();
        return true;
      }
      return false;
    });
    
    if (retweeted) {
      await sleep(gaussianRandom(500, 1500));
      logger.info('✅ Retweeted');
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`❌ Retweet failed: ${error.message}`);
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
  const handle = accountConfig.twitter_handle;
  
  if (apiFailures[handle] >= 5) {
    const lastFailTime = apiFailures[`${handle}_time`] || 0;
    const hoursSinceLastFail = (Date.now() - lastFailTime) / 3600000;
    
    if (hoursSinceLastFail < 1) {
      logger.warn(`🚫 Circuit breaker: ${handle} paused`);
      throw new Error('Circuit breaker active');
    } else {
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
    apiFailures[handle] = 0;
    return reply.replace(/^["']|["']$/g, '');
    
  } catch (error) {
    logger.error(`❌ Grok API Error: ${error.message}`);
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

async function processAccount(accountConfig, targetReplies) {
  const handle = accountConfig.twitter_handle;
  logger.info(`\n🎯 Processing ${handle}`);
  logger.info(`📋 Target: ${targetReplies} replies`);
  
  const stats = getTodayStats(handle);
  let repliesMade = 0;
  
  try {
    const switched = await switchAccount(handle);
    if (!switched && !TEST_MODE) return 0;
    
    const allTweets = await scrapeTweets();
    
    if (allTweets.length === 0) {
      logger.warn('⚠️  No tweets found');
      return 0;
    }
    
    // Calculate engagement scores
    const tweetsWithScores = allTweets.map(tweet => ({
      ...tweet,
      score: calculateEngagementScore(tweet, accountConfig)
    }));
    
    // Sort by score
    tweetsWithScores.sort((a, b) => b.score - a.score);
    
    // Select top 8-12
    const topCount = randomInt(8, 12);
    const topTweets = tweetsWithScores.slice(0, topCount);
    
    // Randomly select 5-7 from top
    const selectCount = Math.min(randomInt(5, 7), targetReplies);
    const selectedTweets = shuffle(topTweets).slice(0, selectCount);
    
    logger.info(`📝 Selected ${selectedTweets.length} tweets from top ${topCount}`);
    
    // Get account engagement mix with daily + session variation
    const baseReplyRate = accountConfig.engagement_mix?.reply_rate || 0.7;
    const dailyVar = (Math.random() - 0.5) * 0.1; // ±5%
    const sessionVar = (Math.random() - 0.5) * 0.04; // ±2%
    const todayReplyRate = Math.max(0.5, Math.min(0.9, baseReplyRate + dailyVar + sessionVar));
    
    const baseLikeRate = accountConfig.engagement_mix?.like_rate || 0.2;
    const todayLikeRate = Math.max(0.1, Math.min(0.4, baseLikeRate + dailyVar + sessionVar));
    
    logger.debug(`📊 Today's mix: ${Math.round(todayReplyRate*100)}% replies, ${Math.round(todayLikeRate*100)}% likes`);
    
    // Get reply timing personality
    const replySpeed = accountConfig.reply_timing || { fast: 0.7, medium: 0.2, slow: 0.1 };
    
    // Session early exit chance (20%)
    const earlyExitChance = 0.2;
    const shouldExitEarly = Math.random() < earlyExitChance;
    const exitAfter = shouldExitEarly ? Math.floor(targetReplies * 0.6) : targetReplies;
    
    for (const tweet of selectedTweets) {
      if (repliesMade >= exitAfter) {
        if (shouldExitEarly) {
          logger.info(`🚪 Early exit after ${repliesMade} replies (target was ${targetReplies})`);
        }
        break;
      }
      
      // Max 1 reply per author per day
      if (hasRepliedToAuthor(handle, tweet.author)) {
        logger.debug(`⏭️  Already replied to @${tweet.author} today`);
        await clickSkip();
        continue;
      }
      
      const tweetAge = getTweetAge(tweet.timestamp);
      logger.info(`\n💭 @${tweet.author} (${Math.round(tweetAge)}min, ${tweet.likes} likes, score: ${tweet.score.toFixed(2)})`);
      logger.info(`   "${tweet.text.substring(0, 80)}..."`);
      
      // Decide: reply or like
      const action = Math.random() < todayReplyRate ? 'reply' : (Math.random() < todayLikeRate ? 'like' : 'skip');
      
      if (action === 'reply') {
        const reply = await generateReply(accountConfig, tweet.text, tweet.author);
        logger.info(`📝 Reply: "${reply}"`);
        
        // Determine reply timing based on personality
        const speedRoll = Math.random();
        let replyDelay;
        if (speedRoll < replySpeed.fast) {
          replyDelay = gaussianRandom(3000, 8000); // Fast: 3-8s
        } else if (speedRoll < replySpeed.fast + replySpeed.medium) {
          replyDelay = gaussianRandom(15000, 45000); // Medium: 15-45s
        } else {
          replyDelay = gaussianRandom(60000, 180000); // Slow: 1-3min
        }
        
        logger.debug(`⏱️  Waiting ${Math.round(replyDelay/1000)}s before replying`);
        await sleep(replyDelay);
        
        const posted = await postReply(reply);
        
        if (posted) {
          db.prepare(`
            INSERT OR IGNORE INTO replies 
            (account_handle, tweet_id, tweet_author, tweet_text, reply_text, tweet_age_minutes, tweet_likes, engagement_score, posted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
          `).run(handle, tweet.id, tweet.author, tweet.text, reply, Math.round(tweetAge), tweet.likes, tweet.score);
          
          incrementTodayReplies(handle);
          markRepliedToAuthor(handle, tweet.author);
          repliesMade++;
          
          // Maybe like after reply (40% chance)
          if (Math.random() < 0.4) {
            const likeDelay = randomInt(500, 3000);
            logger.debug(`⏱️  Liking in ${likeDelay}ms`);
            await sleep(likeDelay);
            const liked = await postLike();
            if (liked) incrementTodayLikes(handle);
          }
          
          logger.info(`✅ Progress: ${repliesMade}/${targetReplies}`);
        }
        
      } else if (action === 'like') {
        // Like before skip (60% chance)
        if (Math.random() < 0.6) {
          const likeDelay = randomInt(-2000, -500);
          logger.debug(`⏱️  Pre-like delay: ${Math.abs(likeDelay)}ms`);
          await sleep(Math.abs(likeDelay));
          const liked = await postLike();
          if (liked) incrementTodayLikes(handle);
        }
        logger.debug(`💙 Liked (no reply)`);
        await clickSkip();
      } else {
        logger.debug(`⏭️  Skipped`);
        await clickSkip();
      }
      
      await sleep(gaussianRandom(5000, 15000));
    }
    
    logger.info(`\n📊 Session complete: ${repliesMade} replies made`);
    return repliesMade;
    
  } catch (error) {
    logger.error(`❌ Error processing ${handle}: ${error.message}`);
    await takeScreenshot(`error-${handle}`);
    return repliesMade;
  }
}

// ============================================
// RETWEET MANAGEMENT
// ============================================

async function handleRetweets(accountConfig) {
  const handle = accountConfig.twitter_handle;
  const stats = getTodayStats(handle);
  
  // 0-2 retweets per day
  const maxRetweets = randomInt(0, 2);
  
  if (stats.retweets_count >= maxRetweets) {
    logger.debug(`${handle}: Retweet quota reached (${stats.retweets_count}/${maxRetweets})`);
    return;
  }
  
  // Check if within retweet time window
  const hour = new Date().getHours();
  const rtWindow = accountConfig.retweet_time_window || { start: 19, end: 22 };
  
  if (hour < rtWindow.start || hour >= rtWindow.end) {
    logger.debug(`${handle}: Outside retweet window (${rtWindow.start}-${rtWindow.end})`);
    return;
  }
  
  logger.info(`🔁 ${handle}: Checking for retweets...`);
  
  // Get all tweets from last 20 hours, sorted by likes
  const allTweets = await scrapeTweets();
  const twentyHoursAgo = Date.now() - (20 * 60 * 60 * 1000);
  
  const recentTweets = allTweets
    .filter(t => new Date(t.timestamp).getTime() > twentyHoursAgo)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 4);
  
  if (recentTweets.length === 0) {
    logger.debug('No tweets in pool');
    return;
  }
  
  // Random 0-2 from top 4
  const numToRetweet = Math.min(randomInt(0, 2), maxRetweets - stats.retweets_count);
  const tweetsToRetweet = shuffle(recentTweets).slice(0, numToRetweet);
  
  for (const tweet of tweetsToRetweet) {
    logger.info(`🔁 Retweeting from @${tweet.author} (${tweet.likes} likes)`);
    const retweeted = await postRetweet();
    if (retweeted) {
      incrementTodayRetweets(handle);
    }
    await sleep(gaussianRandom(30000, 60000)); // 30-60s between retweets
  }
}

// ============================================
// SESSION
// ============================================

async function runSession(sessionNum) {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`🚀 SESSION ${sessionNum} STARTED`);
  logger.info(`${'='.repeat(60)}\n`);
  
  const targets = calculateDailyTargets();
  
  // Select 3-7 accounts for this session
  const numAccounts = randomInt(3, 7);
  let availableAccounts = config.accounts.filter(a => {
    const target = targets[a.twitter_handle];
    return target && target.remaining > 0;
  });
  
  availableAccounts = shuffle(availableAccounts).slice(0, numAccounts);
  
  logger.info(`✅ Accounts: ${availableAccounts.map(a => a.twitter_handle).join(', ')}\n`);
  
  for (const account of availableAccounts) {
    const target = targets[account.twitter_handle];
    const sessionTarget = Math.min(randomInt(3, 8), target.remaining);
    
    const made = await processAccount(account, sessionTarget);
    
    // Handle retweets if in time window
    await handleRetweets(account);
    
    const delayMin = gaussianRandom(4, 12);
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
  
  const checks = { chrome: false, grok: false, database: false, proxy: false };
  
  if (fs.existsSync('/usr/bin/google-chrome')) {
    checks.chrome = true;
    logger.info('✅ Chrome installed');
  }
  
  try {
    await grok.chat.completions.create({
      model: 'grok-beta',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 5
    });
    checks.grok = true;
    logger.info('✅ Grok API working');
  } catch (e) {
    logger.error(`❌ Grok: ${e.message}`);
  }
  
  try {
    db.prepare('SELECT 1').get();
    checks.database = true;
    logger.info('✅ Database OK');
  } catch (e) {
    logger.error(`❌ Database: ${e.message}`);
  }
  
  logger.info(`✅ Proxy configured: ${config.proxy.host}`);
  checks.proxy = true;
  
  const allGood = Object.values(checks).every(v => v);
  logger.info(allGood ? '\n🎉 All systems go!' : '\n⚠️  Issues found');
  
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
  
  logger.info(`🤖 X-Automation System v3.0 ULTIMATE`);
  logger.info(`📅 Mode: ${DRY_RUN ? 'DRY-RUN' : 'PRODUCTION'}`);
  logger.info(`📊 Accounts: ${config.accounts.length}\n`);
  
  await initBrowser();
  await loginToHypeFury();
  
  const targets = calculateDailyTargets();
  logger.info('📋 Daily Targets:');
  for (const [handle, data] of Object.entries(targets)) {
    const dayType = data.isLowDay ? '(LOW DAY)' : '';
    logger.info(`   ${handle}: ${data.target} ${dayType}`);
  }
  
  if (TEST_MODE) {
    logger.info('\n🧪 TEST MODE - Single session\n');
    await runSession(1);
    if (browser) await browser.close();
    process.exit(0);
  }
  
  // Production loop
  let sessionCount = 0;
  const dailySessions = randomInt(3, 4); // 3-4 sessions per day
  
  logger.info(`\n📅 Today: ${dailySessions} sessions planned\n`);
  
  while (true) {
    const hour = new Date().getHours();
    
    if (hour >= 8 && hour < 22) {
      sessionCount++;
      await runSession(sessionCount);
      
      if (sessionCount >= dailySessions) {
        logger.info('🌙 All sessions complete. Sleeping until tomorrow...\n');
        sessionCount = 0;
        await sleep(8 * 60 * 60 * 1000);
        
        // Recalculate for new day
        const newTargets = calculateDailyTargets();
        const newDailySessions = randomInt(3, 4);
        logger.info(`\n📅 New day: ${newDailySessions} sessions planned\n`);
      } else {
        const pauseMin = gaussianRandom(60, 180);
        logger.info(`\n😴 Next session in ${Math.round(pauseMin)} minutes...\n`);
        await sleep(pauseMin * 60 * 1000);
      }
    } else {
      logger.info('😴 Outside active hours (8-22) - sleeping 30 min\n');
      await sleep(30 * 60 * 1000);
    }
  }
}

// ============================================
// RUN
// ============================================

main().catch(async (error) => {
  logger.error(`💥 Fatal: ${error.message}`);
  logger.error(error.stack);
  await takeScreenshot('fatal-error');
  if (browser) await browser.close();
  releaseLock();
  process.exit(1);
});
