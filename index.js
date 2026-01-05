import dotenv from 'dotenv';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';
import puppeteer from 'puppeteer';
import { createCursor, GhostCursor } from 'ghost-cursor';

dotenv.config();

// ============================================
// CONFIG & INITIALIZATION
// ============================================

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const db = new Database('automation.db');

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

let browser = null;
let page = null;
let cursor = null;

// ============================================
// DATABASE SETUP
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
    liked BOOLEAN DEFAULT 0,
    retweeted BOOLEAN DEFAULT 0,
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
    UNIQUE(account_handle, date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    accounts_active TEXT,
    accounts_excluded TEXT,
    total_actions INTEGER DEFAULT 0
  )
`);

console.log('✅ Database initialized');

// ============================================
// GAUSSIAN RANDOM (für natürliche Variabilität)
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

// ============================================
// HELPER FUNCTIONS
// ============================================

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
  
  return row || { replies_count: 0, likes_count: 0, retweets_count: 0 };
}

function incrementStat(accountHandle, statType) {
  const today = getTodayString();
  
  db.prepare(`
    INSERT INTO daily_stats (account_handle, date, ${statType})
    VALUES (?, ?, 1)
    ON CONFLICT(account_handle, date) 
    DO UPDATE SET ${statType} = ${statType} + 1
  `).run(accountHandle, today);
}

function hasRepliedToTweet(accountHandle, tweetId) {
  const row = db.prepare(`
    SELECT id FROM replies 
    WHERE account_handle = ? AND tweet_id = ?
  `).get(accountHandle, tweetId);
  
  return !!row;
}

function calculateEngagementRate(tweet) {
  const now = Date.now();
  const tweetTime = new Date(tweet.timestamp).getTime();
  const ageMinutes = (now - tweetTime) / 60000;
  
  if (ageMinutes < 1) return tweet.likes; // Very fresh
  return tweet.likes / ageMinutes;
}

// ============================================
// BROWSER AUTOMATION - HUMAN-LIKE
// ============================================

async function initBrowser() {
  console.log('🌐 Initializing browser...');
  
  browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });
  
  page = await browser.newPage();
  cursor = createCursor(page);
  
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
  
  console.log('✅ Browser ready');
}

async function humanClick(selector, offsetRange = 10) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  
  const box = await element.boundingBox();
  const x = box.x + box.width / 2 + gaussianRandom(-offsetRange, offsetRange);
  const y = box.y + box.height / 2 + gaussianRandom(-offsetRange, offsetRange);
  
  // Hover before click
  await cursor.move(x, y);
  await sleep(randomDelay(300, 1500));
  
  // Click
  await page.mouse.click(x, y);
  await sleep(randomDelay(500, 1000));
}

async function humanType(text, typoChance = 0.03) {
  const chars = text.split('');
  
  for (let i = 0; i < chars.length; i++) {
    // Random typo
    if (Math.random() < typoChance && i > 2) {
      const wrongChar = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      await page.keyboard.type(wrongChar);
      await sleep(randomDelay(100, 300));
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(200, 400));
    }
    
    await page.keyboard.type(chars[i]);
    await sleep(randomDelay(50, 200));
  }
}

async function humanScroll(distance = null) {
  const scrollAmount = distance || gaussianRandom(200, 600);
  const steps = Math.floor(gaussianRandom(3, 8));
  
  for (let i = 0; i < steps; i++) {
    await page.evaluate((amount) => {
      window.scrollBy({
        top: amount,
        behavior: 'smooth'
      });
    }, scrollAmount / steps);
    
    await sleep(randomDelay(100, 300));
  }
  
  // Random pause
  await sleep(randomDelay(500, 2000));
}

async function randomBehavioralNoise() {
  const roll = Math.random();
  
  if (roll < 0.05) {
    // Wrong click
    console.log('  🎲 Behavioral: Wrong click');
    try {
      await page.mouse.click(
        gaussianRandom(100, 1800),
        gaussianRandom(100, 1000)
      );
      await sleep(randomDelay(500, 1500));
    } catch (e) {}
  } else if (roll < 0.08) {
    // Zoom
    console.log('  🎲 Behavioral: Zoom');
    await page.keyboard.down('Control');
    await page.mouse.wheel({ deltaY: -100 });
    await sleep(randomDelay(500, 1000));
    await page.mouse.wheel({ deltaY: 100 });
    await page.keyboard.up('Control');
  } else if (roll < 0.10) {
    // Extra scroll
    console.log('  🎲 Behavioral: Extra scroll');
    await humanScroll(gaussianRandom(-200, -50));
    await sleep(randomDelay(1000, 2000));
  }
}

// ============================================
// HYPEFURY INTEGRATION
// ============================================

async function loginToHypeFury() {
  console.log('🔐 Logging into HypeFury...');
  
  await page.goto('https://app.hypefury.com/login', {
    waitUntil: 'networkidle2'
  });
  
  await sleep(randomDelay(2000, 4000));
  
  // TODO: Add login logic here
  // For now, manual login expected
  console.log('⚠️  Please login manually if not already logged in');
  console.log('   Waiting 30 seconds...');
  await sleep(30000);
}

async function switchToAccount(accountHandle) {
  console.log(`🔄 Switching to ${accountHandle}`);
  
  try {
    await humanClick('.account-switcher');
    await sleep(randomDelay(1000, 2000));
    
    await humanClick(`[data-account="${accountHandle}"]`);
    await sleep(randomDelay(2000, 4000));
    
    console.log(`✅ Switched to ${accountHandle}`);
  } catch (error) {
    console.error(`❌ Failed to switch account: ${error.message}`);
    throw error;
  }
}

async function scrapeEngagementBuilderFeed() {
  console.log('📡 Scraping Engagement Builder feed...');
  
  await page.goto('https://app.hypefury.com/engagement-builder', {
    waitUntil: 'networkidle2'
  });
  
  await sleep(randomDelay(2000, 4000));
  await humanScroll();
  
  const tweets = await page.$$eval('.tweet-item', (items) => {
    return items.map(item => {
      try {
        return {
          id: item.getAttribute('data-tweet-id') || `tweet_${Date.now()}_${Math.random()}`,
          author: item.querySelector('.tweet-author')?.textContent?.trim() || 'unknown',
          text: item.querySelector('.tweet-text')?.textContent?.trim() || '',
          likes: parseInt(item.querySelector('.tweet-likes')?.textContent?.replace(/\D/g, '') || '0'),
          timestamp: item.querySelector('.tweet-time')?.getAttribute('datetime') || new Date().toISOString(),
          hasImage: !!item.querySelector('.tweet-image')
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  });
  
  console.log(`📨 Found ${tweets.length} tweets`);
  return tweets;
}

async function postReply(replyText) {
  console.log('💬 Posting reply...');
  
  try {
    await humanClick('.reply-button');
    await sleep(randomDelay(1000, 2000));
    
    await humanType(replyText);
    await sleep(randomDelay(1000, 3000));
    
    await humanClick('.post-reply-button');
    await sleep(randomDelay(2000, 4000));
    
    console.log('✅ Reply posted');
    return true;
  } catch (error) {
    console.error(`❌ Failed to post reply: ${error.message}`);
    return false;
  }
}

async function likeTweet() {
  console.log('❤️  Liking tweet...');
  
  try {
    await humanClick('.like-button');
    await sleep(randomDelay(500, 1500));
    return true;
  } catch (error) {
    console.error(`❌ Failed to like: ${error.message}`);
    return false;
  }
}

async function retweetTweet() {
  console.log('🔄 Retweeting...');
  
  try {
    await humanClick('.retweet-button');
    await sleep(randomDelay(1000, 2000));
    await humanClick('.confirm-retweet');
    await sleep(randomDelay(2000, 3000));
    return true;
  } catch (error) {
    console.error(`❌ Failed to retweet: ${error.message}`);
    return false;
  }
}

// ============================================
// GROK API - REPLY GENERATION
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

Generate a reply (max 280 chars) that fits this style. Be authentic and engaging.`
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
  
  try {
    await switchToAccount(handle);
    
    const stats = getTodayStats(handle);
    const weekNumber = getWeekNumber(accountConfig.created_date);
    const limits = getWarmupLimits(weekNumber);
    
    console.log(`📊 Today: ${stats.replies_count} replies, ${stats.likes_count} likes`);
    console.log(`📅 Week ${weekNumber}: Limit ${limits.min_replies}-${limits.max_replies}`);
    
    const tweets = await scrapeEngagementBuilderFeed();
    
    // Filter quality tweets
    const qualityTweets = tweets.filter(tweet => {
      const engagementRate = calculateEngagementRate(tweet);
      return (
        tweet.likes >= config.min_tweet_likes &&
        engagementRate >= config.min_engagement_rate &&
        !hasRepliedToTweet(handle, tweet.id)
      );
    });
    
    console.log(`✨ ${qualityTweets.length} quality tweets found`);
    
    // Decide actions for this check
    const shouldReply = Math.random() < 0.4 && stats.replies_count < limits.max_replies;
    const numLikes = Math.floor(gaussianRandom(1, 5));
    
    if (shouldReply && qualityTweets.length > 0) {
      const tweet = qualityTweets[0];
      
      console.log(`\n💭 Generating reply for: "${tweet.text.substring(0, 50)}..."`);
      const reply = await generateReply(accountConfig, tweet.text, tweet.author);
      console.log(`📝 Reply: "${reply}"`);
      
      // Like before or after?
      const likeBefore = Math.random() < 0.5;
      
      if (likeBefore && Math.random() < 0.8) {
        await likeTweet();
        incrementStat(handle, 'likes_count');
        await sleep(randomDelay(2000, 5000));
      }
      
      const posted = await postReply(reply);
      
      if (posted) {
        incrementStat(handle, 'replies_count');
        
        db.prepare(`
          INSERT INTO replies (account_handle, tweet_id, tweet_author, tweet_text, reply_text, liked)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(handle, tweet.id, tweet.author, tweet.text, reply, likeBefore ? 1 : 0);
        
        if (!likeBefore && Math.random() < 0.8) {
          await sleep(randomDelay(3000, 8000));
          await likeTweet();
          incrementStat(handle, 'likes_count');
        }
      }
    }
    
    // Extra likes
    for (let i = 0; i < numLikes && i < qualityTweets.length; i++) {
      await humanScroll(gaussianRandom(100, 300));
      await sleep(randomDelay(2000, 5000));
      await likeTweet();
      incrementStat(handle, 'likes_count');
    }
    
    // Random noise
    await randomBehavioralNoise();
    
  } catch (error) {
    console.error(`❌ Error processing ${handle}:`, error.message);
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function runSession() {
  const sessionDuration = gaussianRandom(30, 60); // 30-60 minutes
  const numPasses = Math.floor(gaussianRandom(2, 4)); // 2-4 passes through accounts
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 SESSION STARTED`);
  console.log(`⏱️  Duration: ${Math.round(sessionDuration)} minutes`);
  console.log(`🔄 Passes: ${numPasses}`);
  console.log(`${'='.repeat(80)}\n`);
  
  // Exclude 3 random accounts
  const excludedAccounts = shuffle(config.accounts).slice(0, 3);
  const activeAccounts = config.accounts.filter(
    acc => !excludedAccounts.includes(acc)
  );
  
  console.log(`🚫 Excluded: ${excludedAccounts.map(a => a.twitter_handle).join(', ')}`);
  console.log(`✅ Active: ${activeAccounts.map(a => a.twitter_handle).join(', ')}\n`);
  
  const sessionEnd = Date.now() + (sessionDuration * 60 * 1000);
  let passNumber = 0;
  
  while (Date.now() < sessionEnd && passNumber < numPasses) {
    passNumber++;
    console.log(`\n--- Pass ${passNumber}/${numPasses} ---\n`);
    
    const shuffledAccounts = shuffle(activeAccounts);
    
    for (const account of shuffledAccounts) {
      if (Date.now() >= sessionEnd) break;
      
      await processAccount(account);
      
      // Variable delay between accounts
      const delayMinutes = gaussianRandom(3, 15);
      console.log(`\n⏸️  Waiting ${Math.round(delayMinutes)} minutes before next account...\n`);
      await sleep(delayMinutes * 60 * 1000);
      
      if (Date.now() >= sessionEnd) break;
    }
  }
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ SESSION COMPLETED`);
  console.log(`${'='.repeat(80)}\n`);
}

// ============================================
// MAIN LOOP
// ============================================

async function main() {
  console.log(`🤖 X-Automation Phase 2 System Started`);
  console.log(`📅 Timezone: ${process.env.TZ}`);
  console.log(`📊 Accounts: ${config.accounts.length}\n`);
  
  await initBrowser();
  await loginToHypeFury();
  
  while (true) {
    await runSession();
    
    const pauseDuration = gaussianRandom(15, 60);
    console.log(`\n😴 Pause for ${Math.round(pauseDuration)} minutes...\n`);
    await sleep(pauseDuration * 60 * 1000);
  }
}

// ============================================
// ERROR HANDLING & START
// ============================================

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

main().catch(error => {
  console.error('💥 Fatal Error:', error);
  if (browser) browser.close();
  process.exit(1);
});
