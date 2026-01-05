import dotenv from 'dotenv';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'timers/promises';
import fs from 'fs';

dotenv.config();

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const db = new Database('automation.db');

const grok = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

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
    success BOOLEAN DEFAULT 1,
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

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isWithinActiveHours() {
  const now = new Date();
  const hour = now.getHours();
  const { start, end } = config.schedule.active_hours;
  return hour >= start && hour < end;
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
// MOCK DATA (Phase 1)
// ============================================

async function fetchTweetsFromHypeFury(accountConfig) {
  console.log(`📡 [MOCK] Fetching tweets for ${accountConfig.twitter_handle}`);
  
  return [
    {
      id: 'tweet_' + Date.now(),
      author: accountConfig.target_accounts[0],
      text: 'Hot take: Most dating advice is completely wrong for modern relationships.',
      likes: 2500,
      imageUrls: []
    }
  ];
}

// ============================================
// ACCOUNT PROCESSING
// ============================================

async function processTweetsForAccount(accountConfig) {
  const accountHandle = accountConfig.twitter_handle;
  const weekNumber = getWeekNumber(accountConfig.created_date);
  const warmupLimits = getWarmupLimits(weekNumber);
  const todayReplies = getTodayRepliesCount(accountHandle);
  
  console.log(`\n🎯 Processing ${accountHandle}`);
  console.log(`📅 Week ${weekNumber} - Limit: ${warmupLimits.min_replies}-${warmupLimits.max_replies} replies`);
  console.log(`📊 Today's replies: ${todayReplies}/${warmupLimits.max_replies}`);
  
  if (todayReplies >= warmupLimits.max_replies) {
    console.log(`✋ Max replies reached for today`);
    return;
  }
  
  const tweets = await fetchTweetsFromHypeFury(accountConfig);
  console.log(`📨 Found ${tweets.length} potential tweets`);
  
  for (const tweet of tweets) {
    if (!isWithinActiveHours()) {
      console.log(`⏰ Outside active hours (${config.schedule.active_hours.start}-${config.schedule.active_hours.end})`);
      break;
    }
    
    const currentReplies = getTodayRepliesCount(accountHandle);
    if (currentReplies >= warmupLimits.max_replies) {
      console.log(`✋ Max replies reached during session`);
      break;
    }
    
    if (hasRepliedToTweet(accountHandle, tweet.id)) {
      console.log(`⏭️  Already replied to ${tweet.id}`);
      continue;
    }
    
    console.log(`\n💭 Generating reply for tweet from ${tweet.author}`);
    console.log(`📝 Tweet: "${tweet.text.substring(0, 100)}..."`);
    
    try {
      const reply = await generateReply(
        accountConfig,
        tweet.text,
        tweet.author
      );
      
      console.log(`✅ Generated reply: "${reply}"`);
      console.log(`🚀 [MOCK] Would post reply now...`);
      
      db.prepare(`
        INSERT INTO replies (account_handle, tweet_id, tweet_author, tweet_text, reply_text, success)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(accountHandle, tweet.id, tweet.author, tweet.text, reply, 1);
      
      incrementTodayReplies(accountHandle);
      
      console.log(`✅ Reply logged to database`);
      
      const delaySeconds = randomDelay(30, 300);
      console.log(`⏳ Waiting ${delaySeconds}s before next action...`);
      await sleep(delaySeconds * 1000);
      
    } catch (error) {
      console.error(`❌ Error processing tweet:`, error.message);
    }
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

async function runSession() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 SESSION STARTED - ${new Date().toLocaleString()}`);
  console.log(`${'='.repeat(60)}`);
  
  for (const account of config.accounts) {
    try {
      await processTweetsForAccount(account);
    } catch (error) {
      console.error(`❌ Error processing ${account.twitter_handle}:`, error.message);
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ SESSION COMPLETED - ${new Date().toLocaleString()}`);
  console.log(`${'='.repeat(60)}\n`);
}

async function scheduler() {
  console.log(`🤖 X-Automation System Started`);
  console.log(`📅 Timezone: ${process.env.TZ}`);
  console.log(`⏰ Active Hours: ${config.schedule.active_hours.start}:00 - ${config.schedule.active_hours.end}:00`);
  console.log(`📊 Accounts: ${config.accounts.map(a => a.twitter_handle).join(', ')}`);
  
  while (true) {
    if (isWithinActiveHours()) {
      await runSession();
      
      const waitHours = randomDelay(config.schedule.min_session_gap_hours, config.schedule.min_session_gap_hours + 2);
      console.log(`😴 Next session in ${waitHours} hours...`);
      await sleep(waitHours * 60 * 60 * 1000);
    } else {
      console.log(`😴 Outside active hours. Checking again in 30 minutes...`);
      await sleep(30 * 60 * 1000);
    }
  }
}

scheduler().catch(error => {
  console.error('💥 Fatal Error:', error);
  process.exit(1);
});
