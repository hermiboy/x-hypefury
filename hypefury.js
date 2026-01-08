const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
const STATE_FILE = '/root/automation-state.json';
const LOCK_FILE = '/tmp/hypefury.lock';
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const DRY_RUN = process.env.DRY_RUN === 'true';

// Kill any running Chrome processes
function ensureChromeNotRunning() {
  try {
    const chromeCheck = execSync('pgrep -f "chrome" || echo "0"').toString().trim();
    if (chromeCheck && chromeCheck !== '0') {
      console.log('⚠️ Chrome processes found, killing...');
      execSync('pkill -f "chrome"');
      console.log('✅ Chrome killed');
      // Wait for processes to die
      return new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (e) {
    console.log('ℹ️ No Chrome processes found');
  }
  return Promise.resolve();
}

// Prevent parallel runs
if (fs.existsSync(LOCK_FILE)) {
  console.log('⚠️ Bot already running (lock file exists), exiting');
  process.exit(0);
}

// Clean up Chrome first
console.log('🔍 Checking for Chrome processes...');
ensureChromeNotRunning().then(() => {
  fs.writeFileSync(LOCK_FILE, Date.now().toString());
  console.log('🔒 Lock file created');
  
  // Continue with bot
  if (DRY_RUN) console.log('⚠️ DRY RUN MODE - No actual posts/likes/retweets');
  if (!GROK_API_KEY) console.log('⚠️ WARNING: GROK_API_KEY not set!');
  
  // Start bot
  runSession().then(() => {
    console.log('\n✅ Bot finished');
    process.exit(0);
  }).catch(err => {
    console.error('💥 Fatal:', err);
    process.exit(1);
  });
}).catch(err => {
  console.error('💥 Chrome cleanup failed:', err);
  process.exit(1);
});

// Clean up lock on exit
process.on('exit', () => {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      console.log('🔓 Lock file removed');
    }
  } catch (e) {}
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let grokFailures = 0;
let grokLastFail = 0;

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

function getWeekNumber(createdDate) {
  const created = new Date(createdDate);
  const now = new Date();
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.ceil(diffDays / 7);
}

function getWarmupLimits(weekNumber) {
  const schedule = CONFIG.warmup_schedule;
  if (weekNumber === 1) return schedule.week_1;
  if (weekNumber === 2) return schedule.week_2;
  if (weekNumber === 3) return schedule.week_3;
  if (weekNumber === 4) return schedule.week_4;
  if (weekNumber === 5) return schedule.week_5;
  if (weekNumber === 6) return schedule.week_6;
  if (weekNumber === 7) return schedule.week_7;
  return schedule['week_8+'];
}

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

function isInTimeWindow(startHour, endHour) {
  const hour = new Date().getHours();
  return hour >= startHour && hour <= endHour;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const today = getTodayString();
      if (data.date === today) return data;
    }
  } catch (err) {}
  
  const today = getTodayString();
  const state = {
    date: today,
    accounts: {},
    sessionsToday: 0,
    processedTweetIds: []
  };
  
  for (const account of CONFIG.accounts) {
    const weekNumber = getWeekNumber(account.created_date);
    const limits = getWarmupLimits(weekNumber);
    
    const dayOfMonth = new Date().getDate();
    const lowEnergyDays = [5, 12, 18, 25];
    const isLowDay = lowEnergyDays.includes(dayOfMonth);
    
    let replyTarget = randomInt(limits.min_replies, limits.max_replies);
    let likeTarget = randomInt(limits.min_likes, limits.max_likes);
    
    if (isLowDay) {
      replyTarget = Math.floor(replyTarget * 0.4);
      likeTarget = Math.floor(likeTarget * 0.4);
    }
    
    const retweetTarget = weekNumber >= 4 ? randomInt(0, 2) : 0;
    
    state.accounts[account.twitter_handle] = {
      replyTarget: replyTarget,
      repliesMade: 0,
      likeTarget: likeTarget,
      likesMade: 0,
      retweetTarget: retweetTarget,
      retweetsMade: 0,
      isLowDay: isLowDay,
      repliedAuthors: []
    };
  }
  
  return state;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTweetAge(timestamp) {
  const tweetTime = new Date(timestamp).getTime();
  const now = Date.now();
  return (now - tweetTime) / 60000;
}

function calculateEngagementScore(tweet) {
  const age = getTweetAge(tweet.timestamp);
  const likes = tweet.likes || 0;
  
  const likesPerMinute = likes / Math.max(age, 1);
  
  let ageMultiplier = 1.0;
  if (age < 7.5) ageMultiplier = 3.0;
  else if (age < 15) ageMultiplier = 2.0;
  else if (age < 30) ageMultiplier = 1.5;
  else if (age < 60) ageMultiplier = 1.2;
  else if (age < 120) ageMultiplier = 1.0;
  else if (age < 360) ageMultiplier = 0.5;
  else ageMultiplier = 0.2;
  
  return likesPerMinute * ageMultiplier;
}

async function callGrokAPI(prompt, tweetText, tweetAuthor) {
  if (!GROK_API_KEY) throw new Error('GROK_API_KEY missing');
  
  // Circuit breaker
  if (grokFailures >= 5 && (Date.now() - grokLastFail) < 60*60*1000) {
    throw new Error('Grok circuit breaker active (too many failures)');
  }

  const payload = JSON.stringify({
    model: 'grok-4-1-fast-non-reasoning',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Tweet from ${tweetAuthor}: "${tweetText}"` }
    ],
    temperature: 0.8,
    max_tokens: 100
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 15000
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            grokFailures++;
            grokLastFail = Date.now();
            return reject(new Error(`Grok status ${res.statusCode}: ${body}`));
          }
          const json = JSON.parse(body);
          const reply = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text;
          if (!reply) throw new Error('Empty Grok reply');
          
          grokFailures = 0;
          resolve(String(reply).trim().replace(/^["']|["']$/g, ''));
        } catch (e) {
          grokFailures++;
          grokLastFail = Date.now();
          reject(e);
        }
      });
    });
    
    req.on('timeout', () => {
      req.destroy(new Error('Grok timeout'));
    });
    
    req.on('error', err => {
      grokFailures++;
      grokLastFail = Date.now();
      reject(err);
    });
    
    req.write(payload);
    req.end();
  });
}

async function ensureFeedLoaded(page, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const count = await page.$$eval('[data-cy="new-feed-item"]', els => els.length).catch(() => 0);
    if (count > 0) {
      console.log(`✅ Feed loaded: ${count} items`);
      return true;
    }
    console.log(`⏳ Waiting for feed... (${i+1}/${retries})`);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1000 + Math.random() * 1500);
  }
  console.log('⚠️ Feed not loaded after retries');
  return false;
}

async function findTweetElement(page, tweetSnippet) {
  const items = await page.$$('[data-cy="new-feed-item"]');
  for (const item of items) {
    const text = await page.evaluate(el => {
      const textEl = el.querySelector('[data-cy="new-feed-tweet-text"]');
      return textEl ? textEl.textContent : '';
    }, item);
    
    if (text && text.includes(tweetSnippet.substring(0, Math.min(40, tweetSnippet.length)))) {
      return item;
    }
  }
  return null;
}

async function switchAccount(page, targetHandle) {
  try {
    console.log(`🔄 Switching to ${targetHandle}...`);
    
    // Map handle to display name
    const displayNames = {
      '@onlyrileyreeves': 'Riley',
      '@itsrileyreeves': 'Riley Reeves'
    };
    const targetName = displayNames[targetHandle];
    
    if (!targetName) {
      console.log(`⚠️ Unknown handle: ${targetHandle}`);
      return false;
    }
    
    // Click avatar dropdown button with EXACT selector from inspect
    const clicked = await page.evaluate(() => {
      // Use exact class combo from HTML inspect
      const avatarBtn = document.querySelector('button.btn.btn-custom.px-0');
      if (avatarBtn) {
        avatarBtn.click();
        console.log('[SWITCH] Avatar button clicked');
        return true;
      }
      
      console.log('[SWITCH] Avatar button not found');
      return false;
    });
    
    if (!clicked) {
      console.log('⚠️ Could not find avatar button');
      return false;
    }
    
    console.log('✅ Dropdown opened');
    await sleep(gaussianRandom(1000, 2000));
    
    // Find and click target account in dropdown by name in accessibility
    const accountClicked = await page.evaluate((targetName) => {
      // Search in dropdown buttons (btn-dropdown or dropdown-item)
      const dropdownButtons = Array.from(document.querySelectorAll('button'));
      
      for (const btn of dropdownButtons) {
        const text = btn.textContent.trim();
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const name = btn.getAttribute('name') || '';
        
        // Match by text content, aria-label, or name attribute
        if (text.includes(targetName) || 
            ariaLabel.toLowerCase().includes(targetName.toLowerCase()) ||
            name.toLowerCase().includes(targetName.toLowerCase())) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            // Make sure it's visible and in dropdown
            const isVisible = rect.top >= 0 && rect.left >= 0;
            if (isVisible) {
              btn.click();
              console.log(`[SWITCH] Clicked account: ${targetName}`);
              return true;
            }
          }
        }
      }
      
      console.log(`[SWITCH] Account "${targetName}" not found in dropdown`);
      return false;
    }, targetName);
    
    if (!accountClicked) {
      console.log(`⚠️ Could not find account "${targetName}" in dropdown`);
      return false;
    }
    
    // Wait for UI to update after switch
    console.log(`✅ Clicked ${targetName} - waiting for UI update...`);
    await sleep(gaussianRandom(2000, 3500));
    
    console.log(`✅ Successfully switched to ${targetHandle}`);
    return true;
    
  } catch (err) {
    console.log(`❌ Switch error: ${err.message}`);
    return false;
  }
}

async function doRetweets(page, accountConfig, accountState) {
  if (accountState.retweetsMade >= accountState.retweetTarget) return;
  if (!isInTimeWindow(accountConfig.retweet_time_window.start, accountConfig.retweet_time_window.end)) {
    console.log('⏰ Not in retweet time window');
    return;
  }
  
  console.log('\n🔁 RETWEET MODE');
  
  try {
    const tweets = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[data-cy="new-feed-item"]');
      
      for (const item of items) {
        try {
          const textEl = item.querySelector('[data-cy="new-feed-tweet-text"]');
          const text = textEl ? textEl.textContent.trim() : '';
          
          const likesEl = item.querySelector('[aria-label*="like"], [class*="like"]');
          const likesText = likesEl ? likesEl.textContent.trim() : '0';
          const likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
          
          const timeEl = item.querySelector('time, [datetime]');
          const timestamp = timeEl ? 
            (timeEl.getAttribute('datetime') || new Date().toISOString()) : 
            new Date().toISOString();
          
          if (text.length > 10) {
            results.push({ text, likes, timestamp });
          }
        } catch (e) {}
      }
      
      return results;
    });
    
    const twentyHoursAgo = Date.now() - (20 * 60 * 60 * 1000);
    const recentTweets = tweets.filter(t => new Date(t.timestamp).getTime() > twentyHoursAgo);
    
    recentTweets.sort((a, b) => b.likes - a.likes);
    const topFour = recentTweets.slice(0, 4);
    
    console.log(`📊 Top 4 tweets (last 20h):`);
    topFour.forEach((t, i) => console.log(`  ${i+1}. ${t.likes} likes`));
    
    const retweetsToMake = Math.min(randomInt(0, 2), accountState.retweetTarget - accountState.retweetsMade);
    const selected = shuffle(topFour).slice(0, retweetsToMake);
    
    console.log(`🎲 Selected ${selected.length} for retweet`);
    
    for (const tweet of selected) {
      if (DRY_RUN) {
        console.log('🔁 [DRY RUN] Would retweet');
        accountState.retweetsMade++;
        continue;
      }
      
      await sleep(gaussianRandom(30000, 60000));
      
      const tweetEl = await findTweetElement(page, tweet.text);
      if (tweetEl) {
        const retweetBtn = await tweetEl.$('button[data-cy="retweet"], button[aria-label*="retweet"]');
        if (retweetBtn) {
          await retweetBtn.click();
          await sleep(gaussianRandom(1000, 2000));
          
          const confirmBtn = await page.$('button[data-cy="confirm-retweet"]');
          if (confirmBtn) {
            await confirmBtn.click();
            console.log('🔁 Retweeted!');
            accountState.retweetsMade++;
          }
        }
      }
    }
    
  } catch (err) {
    console.log(`❌ Retweet error: ${err.message}`);
  }
}

async function runSession() {
  const state = loadState();
  console.log('\n🚀 SESSION START');
  console.log('📊 State:', JSON.stringify(state, null, 2));
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/google-chrome',
      userDataDir: '/root/.chrome-hypefury-profile',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--proxy-server=http://${CONFIG.proxy.host}:${CONFIG.proxy.port}`
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.authenticate({
      username: CONFIG.proxy.username,
      password: CONFIG.proxy.password
    });

    console.log('🌐 Loading Feed...');
    await page.goto('https://app.hypefury.com/feed', {
      waitUntil: 'domcontentloaded',
      timeout: 120000
    });
    await sleep(3000);
    
    const feedLoaded = await ensureFeedLoaded(page);
    if (!feedLoaded) {
      console.log('❌ Could not load feed');
      await page.screenshot({ path: '/root/x-hypefury/error-feed-not-loaded.png' });
      await browser.close();
      return;
    }

    for (const accountConfig of CONFIG.accounts) {
      const handle = accountConfig.twitter_handle;
      const accountState = state.accounts[handle];
      
      const switched = await switchAccount(page, handle);
      if (!switched) {
        console.log(`❌ Could not switch to ${handle}`);
        continue;
      }
      
      await sleep(gaussianRandom(2000, 4000));
      
      await doRetweets(page, accountConfig, accountState);
      
      if (accountState.repliesMade >= accountState.replyTarget) {
        console.log(`✅ ${handle}: Target reached`);
        continue;
      }
      
      const remaining = accountState.replyTarget - accountState.repliesMade;
      const sessionTarget = Math.min(randomInt(3, 8), remaining);
      
      console.log(`\n🎯 ${handle}: Target ${sessionTarget} replies`);
      
      console.log('📡 Scraping tweets...');
      await sleep(gaussianRandom(2000, 4000));
      
      const tweets = await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('[data-cy="new-feed-item"]');
        
        console.log(`[EXTRACT] Found ${items.length} feed items`);
        
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const textEl = item.querySelector('[data-cy="new-feed-tweet-text"]');
            const text = textEl ? textEl.textContent.trim() : '';
            
            const authorEl = item.querySelector('[class*="author"], strong, [class*="username"]');
            const author = authorEl ? authorEl.textContent.trim() : 'Unknown';
            
            // Find timestamp - look for "PM · Jan" or "AM · Jan" pattern
            const allText = item.textContent;
            const timeMatch = allText.match(/(\d{1,2}:\d{2}\s(?:AM|PM)\s·\s\w{3}\s\d{1,2},\s\d{4})/);
            let timestamp = new Date().toISOString();
            if (timeMatch) {
              try {
                timestamp = new Date(timeMatch[1]).toISOString();
              } catch (e) {
                console.log('[EXTRACT] Time parse failed:', timeMatch[1]);
              }
            }
            
            // Find likes - look for heart icon (♡) followed by number
            let likes = 0;
            const likeMatch = allText.match(/♡\s*(\d+)/);
            if (likeMatch) {
              likes = parseInt(likeMatch[1]) || 0;
            }
            
            // Find retweets - look for retweet icon (↩) followed by number
            let retweets = 0;
            const retweetMatch = allText.match(/↩\s*(\d+)/);
            if (retweetMatch) {
              retweets = parseInt(retweetMatch[1]) || 0;
            }
            
            if (text.length > 10) {
              // Use index + text hash for unique ID (not author-dependent)
              const textHash = text.substring(0, 100) + timestamp.substring(0, 16);
              const id = `tweet-${i}-${textHash.replace(/[^a-zA-Z0-9]/g, '').substring(0, 40)}`;
              
              console.log(`[EXTRACT] Tweet ${i}: author="${author}", likes=${likes}, retweets=${retweets}, text="${text.substring(0, 60)}..."`);
              results.push({ 
                author, 
                text, 
                timestamp, 
                likes,
                retweets,
                id
              });
            }
          } catch (e) {
            console.log(`[EXTRACT] Error parsing item ${i}:`, e.message);
          }
        }
        
        return results;
      });
      
      console.log(`📨 Extracted ${tweets.length} tweets total`);
      tweets.slice(0, 3).forEach((t, i) => {
        console.log(`  ${i+1}. @${t.author}: "${t.text.substring(0, 60)}..." (${t.likes} likes)`);
      });
      
      const newTweets = tweets.filter(t => !state.processedTweetIds.includes(t.id));
      console.log(`📝 ${newTweets.length} new tweets`);
      
      if (newTweets.length === 0) continue;
      
      const tweetsWithScores = newTweets.map(tweet => ({
        ...tweet,
        score: calculateEngagementScore(tweet)
      }));
      
      tweetsWithScores.sort((a, b) => b.score - a.score);
      
      const topCount = Math.min(sessionTarget + 4, tweetsWithScores.length);
      const topTweets = tweetsWithScores.slice(0, topCount);
      const selectedTweets = shuffle(topTweets).slice(0, Math.min(sessionTarget, topTweets.length));
      
      console.log(`🎲 Selected ${selectedTweets.length} from top ${topCount}`);
      
      const preLikes = randomInt(2, 4);
      console.log(`💙 Pre-session likes: ${preLikes}`);
      for (let i = 0; i < preLikes && accountState.likesMade < accountState.likeTarget; i++) {
        await sleep(gaussianRandom(1000, 3000));
        if (DRY_RUN) {
          console.log('💙 [DRY RUN] Would like');
        }
        accountState.likesMade++;
      }
      
      let repliesThisSession = 0;
      
      for (const tweet of selectedTweets) {
        if (accountState.repliedAuthors.includes(tweet.author)) {
          console.log(`⏭️ Already replied to @${tweet.author}`);
          continue;
        }
        
        const tweetAge = getTweetAge(tweet.timestamp);
        console.log(`\n💭 @${tweet.author} (${Math.round(tweetAge)}min, ${tweet.likes} likes, score: ${tweet.score.toFixed(2)})`);
        console.log(`   "${tweet.text.substring(0, 80)}..."`);
        
        try {
          console.log('🤖 Generating reply...');
          const reply = await callGrokAPI(accountConfig.prompt, tweet.text, tweet.author);
          console.log(`📝 Reply: "${reply}"`);
          
          const timings = accountConfig.reply_timing;
          const speedRoll = Math.random();
          let replyDelay;
          if (speedRoll < timings.fast) {
            replyDelay = gaussianRandom(3000, 8000);
          } else if (speedRoll < timings.fast + timings.medium) {
            replyDelay = gaussianRandom(15000, 45000);
          } else {
            replyDelay = gaussianRandom(60000, 180000);
          }
          
          console.log(`⏱️ Waiting ${Math.round(replyDelay/1000)}s...`);
          await sleep(replyDelay);
          
          if (DRY_RUN) {
            console.log('✅ [DRY RUN] Would post reply');
            accountState.repliesMade++;
            accountState.repliedAuthors.push(tweet.author);
            state.processedTweetIds.push(tweet.id);
            repliesThisSession++;
            continue;
          }
          
          const tweetEl = await findTweetElement(page, tweet.text);
          if (!tweetEl) {
            console.log('⚠️ Tweet element not found');
            continue;
          }
          
          const textareaSelector = 'textarea[data-cy="new-feed-text-area"]';
          await page.waitForSelector(textareaSelector, { timeout: 10000 });
          await page.click(textareaSelector);
          await sleep(gaussianRandom(300, 800));
          
          for (const char of reply.split('')) {
            await page.keyboard.type(char);
            await sleep(gaussianRandom(50, 150));
          }
          
          await sleep(gaussianRandom(1000, 2000));
          
          const replyBtn = await tweetEl.$('button[data-cy="new-feed-reply"]');
          if (replyBtn) {
            await replyBtn.click();
            await sleep(gaussianRandom(2000, 4000));
            
            console.log('✅ Reply posted!');
            accountState.repliesMade++;
            accountState.repliedAuthors.push(tweet.author);
            state.processedTweetIds.push(tweet.id);
            repliesThisSession++;
            
            if (Math.random() < 0.8 && accountState.likesMade < accountState.likeTarget) {
              await sleep(gaussianRandom(500, 3000));
              const likeBtn = await tweetEl.$('button[aria-label*="like"], button[data-cy*="like"]');
              if (likeBtn) {
                await likeBtn.click();
                console.log('💙 Liked');
                accountState.likesMade++;
              }
            }
            
            console.log(`📊 ${accountState.repliesMade}/${accountState.replyTarget} replies, ${accountState.likesMade}/${accountState.likeTarget} likes`);
          }
          
          if (Math.random() < 0.2 && accountState.likesMade < accountState.likeTarget) {
            await sleep(gaussianRandom(2000, 5000));
            accountState.likesMade++;
            console.log('💙 Random like');
          }
          
          await sleep(gaussianRandom(5000, 15000));
          
        } catch (err) {
          console.log(`❌ Error: ${err.message}`);
        }
      }
      
      console.log(`\n✅ ${handle} complete: ${repliesThisSession} replies`);
      await sleep(gaussianRandom(120000, 240000));
    }
    
    state.sessionsToday++;
    saveState(state);
    
    console.log('\n📊 SESSION COMPLETE');
    console.log(JSON.stringify(state, null, 2));
    
    await browser.close();
    
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    if (browser) {
      try {
        await page.screenshot({ path: '/root/x-hypefury/fatal-error.png' });
        console.log('📸 Screenshot saved: fatal-error.png');
      } catch (e) {}
      await browser.close();
    }
  }
}
