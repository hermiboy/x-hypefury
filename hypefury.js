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

function ensureChromeNotRunning() {
  try {
    const chromeCheck = execSync('pgrep -f "chrome" || echo "0"').toString().trim();
    if (chromeCheck && chromeCheck !== '0') {
      console.log('⚠️ Chrome processes found, killing...');
      execSync('pkill -f "chrome"');
      console.log('✅ Chrome killed');
      return new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (e) {
    console.log('ℹ️ No Chrome processes found');
  }
  return Promise.resolve();
}

if (fs.existsSync(LOCK_FILE)) {
  console.log('⚠️ Bot already running (lock file exists), exiting');
  process.exit(0);
}

console.log('🔍 Checking for Chrome processes...');
ensureChromeNotRunning().then(() => {
  fs.writeFileSync(LOCK_FILE, Date.now().toString());
  console.log('🔒 Lock file created');
  
  if (DRY_RUN) console.log('⚠️ DRY RUN MODE - No actual posts/likes/retweets');
  if (!GROK_API_KEY) {
    console.log('⚠️ WARNING: GROK_API_KEY not set!');
    console.log('💡 SSH to server and run: export GROK_API_KEY="xai-YOUR-KEY-HERE"');
  }
  
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
      const reduction = 0.2 + Math.random() * 0.4; // 20-60% reduction
      replyTarget = Math.floor(replyTarget * reduction);
      likeTarget = Math.floor(likeTarget * reduction);
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
  try {
    const tweetTime = new Date(timestamp).getTime();
    const now = Date.now();
    
    if (isNaN(tweetTime)) {
      console.log('[TWEET AGE] Invalid timestamp:', timestamp);
      return 999999; // Very old if invalid
    }
    
    const ageMs = now - tweetTime;
    const ageMinutes = ageMs / 60000;
    
    // Sanity check: if tweet appears to be from future or super old (>7 days), log it
    if (ageMinutes < 0) {
      console.log('[TWEET AGE] Tweet from future?', timestamp, 'age:', ageMinutes);
      return 0;
    }
    
    if (ageMinutes > 10080) { // 7 days
      console.log('[TWEET AGE] Very old tweet:', timestamp, 'age:', Math.round(ageMinutes / 60), 'hours');
    }
    
    return ageMinutes;
  } catch (e) {
    console.log('[TWEET AGE ERROR]', e.message);
    return 999999;
  }
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

async function findTweetElement(page, tweetId) {
  try {
    const items = await page.$$('[data-cy="new-feed-item"]');
    for (const item of items) {
      const itemId = await page.evaluate(el => {
        const parent = el.closest('[role="listitem"]');
        if (parent) {
          const innerDiv = parent.querySelector('[id]');
          return innerDiv ? innerDiv.id : null;
        }
        return null;
      }, item);
      
      if (itemId === tweetId) {
        return item;
      }
    }
    return null;
  } catch (err) {
    console.log(`❌ Error finding tweet: ${err.message}`);
    return null;
  }
}

async function clickThreeDotsMenu(page, tweetEl) {
  try {
    const threeDotsClicked = await page.evaluate((el) => {
      const svgs = el.querySelectorAll('svg');
      for (const svg of svgs) {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const circles = svg.querySelectorAll('circle');
          if (circles.length === 3) {
            const button = svg.closest('button');
            if (button) {
              button.click();
              return true;
            }
          }
        }
      }
      
      const buttons = el.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (text === '...' || text === '•••' || ariaLabel.includes('more')) {
          btn.click();
          return true;
        }
      }
      
      return false;
    }, tweetEl);
    
    if (threeDotsClicked) {
      await sleep(gaussianRandom(800, 1500));
      return true;
    }
    
    return false;
  } catch (err) {
    console.log(`❌ 3-dots menu error: ${err.message}`);
    return false;
  }
}

async function switchAccount(page, targetHandle) {
  try {
    console.log(`🔄 Switching to ${targetHandle}...`);
    
    const displayNames = {
      '@onlyrileyreeves': 'Riley',
      '@itsrileyreeves': 'Riley Reeves'
    };
    const targetName = displayNames[targetHandle];
    
    if (!targetName) {
      console.log(`⚠️ Unknown handle: ${targetHandle}`);
      return false;
    }
    
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const img = btn.querySelector('img.h-6.w-6, img[class*="avatar"]');
        if (img) {
          const classes = btn.className.toLowerCase();
          if (classes.includes('btn') || classes.includes('profile')) {
            btn.click();
            return true;
          }
        }
      }
      
      const avatarBtn = document.querySelector('button.btn.btn-custom.px-0');
      if (avatarBtn) {
        avatarBtn.click();
        return true;
      }
      
      return false;
    });
    
    if (!clicked) {
      console.log('⚠️ Could not find avatar button');
      return false;
    }
    
    console.log('✅ Dropdown opened');
    await sleep(gaussianRandom(1500, 2500));
    
    // Find account button using btn-dropdown class with EXACT text match
    const accountClicked = await page.evaluate((targetName) => {
      const dropdownButtons = document.querySelectorAll('button.btn-dropdown');
      
      for (const btn of dropdownButtons) {
        const text = btn.textContent.trim();
        
        // EXACT match only - no includes!
        if (text === targetName) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            console.log('[BROWSER] Clicked account button:', text);
            return true;
          }
        }
      }
      
      console.log('[BROWSER] Account button not found. Available buttons:');
      Array.from(dropdownButtons).forEach(btn => {
        console.log('[BROWSER]  -', btn.textContent.trim());
      });
      
      return false;
    }, targetName);
    
    if (!accountClicked) {
      console.log(`⚠️ Could not find account "${targetName}" in dropdown`);
      return false;
    }
    
    await sleep(gaussianRandom(2000, 3500));
    console.log(`✅ Successfully switched to ${targetHandle}`);
    return true;
    
  } catch (err) {
    console.log(`❌ Switch error: ${err.message}`);
    return false;
  }
}

async function doLike(page, tweetEl, accountState) {
  if (accountState.likesMade >= accountState.likeTarget) return false;
  
  try {
    console.log('🔍 DEBUG: Attempting to like...');
    const opened = await clickThreeDotsMenu(page, tweetEl);
    if (!opened) {
      console.log('⚠️ DEBUG: Could not open 3-dots menu for like');
      return false;
    }
    console.log('✅ DEBUG: 3-dots menu opened');
    
    await sleep(1500); // Wait for menu to appear
    
    const likeResult = await page.evaluate(() => {
      const likeBtn = document.querySelector('button[data-cy="new-feed-like"]');
      console.log('[BROWSER] Like button found:', !!likeBtn);
      
      if (!likeBtn) return { success: false, reason: 'button_not_found' };
      if (likeBtn.disabled) return { success: false, reason: 'button_disabled' };
      
      console.log('[BROWSER] Clicking Like button...');
      likeBtn.click();
      
      // Wait for success alert to appear
      return new Promise((resolve) => {
        setTimeout(() => {
          // Check for success alert
          const successAlert = document.querySelector('.alert-success, [role="alert"]');
          
          if (successAlert && successAlert.textContent.includes('Liked')) {
            console.log('[BROWSER] Success alert found!');
            resolve({ success: true, method: 'alert_check' });
          } else {
            console.log('[BROWSER] No success alert found');
            resolve({ success: false, reason: 'no_alert' });
          }
        }, 1200);
      });
    });
    
    console.log(`🔍 DEBUG: Like result:`, JSON.stringify(likeResult));
    
    if (likeResult.success) {
      await sleep(gaussianRandom(500, 1000));
      accountState.likesMade++;
      console.log('💙 Liked! (verified via success alert)');
      return true;
    } else {
      console.log(`⚠️ Like failed: ${likeResult.reason}`);
      return false;
    }
    
  } catch (err) {
    console.log(`❌ Like error: ${err.message}`);
    return false;
  }
}

async function doRetweets(page, accountConfig, accountState, tweets) {
  if (accountState.retweetsMade >= accountState.retweetTarget) return;
  if (!isInTimeWindow(accountConfig.retweet_time_window.start, accountConfig.retweet_time_window.end)) {
    console.log('⏰ Not in retweet time window');
    return;
  }
  
  console.log('\n🔁 RETWEET MODE');
  
  try {
    const twentyHoursAgo = Date.now() - (20 * 60 * 60 * 1000);
    const recentTweets = tweets.filter(t => new Date(t.timestamp).getTime() > twentyHoursAgo);
    
    recentTweets.sort((a, b) => b.likes - a.likes);
    const topFour = recentTweets.slice(0, 4);
    
    console.log(`📊 Top 4 tweets (last 20h):`);
    topFour.forEach((t, i) => console.log(`  ${i+1}. ${t.likes} likes - ${t.author}`));
    
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
      
      const tweetEl = await findTweetElement(page, tweet.id);
      if (!tweetEl) {
        console.log('⚠️ Tweet element not found for retweet');
        continue;
      }
      
      const opened = await clickThreeDotsMenu(page, tweetEl);
      if (!opened) {
        console.log('⚠️ Could not open 3-dots menu for retweet');
        continue;
      }
      
      const retweetClicked = await page.evaluate(() => {
        const retweetBtn = document.querySelector('button[name="Retweet"]');
        if (retweetBtn) {
          retweetBtn.click();
          return true;
        }
        return false;
      });
      
      if (retweetClicked) {
        await sleep(gaussianRandom(1000, 2000));
        console.log('🔁 Retweeted!');
        accountState.retweetsMade++;
      } else {
        console.log('⚠️ Retweet button not found');
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
      
      console.log(`⏳ Waiting 5s for account switch to complete...`);
      await sleep(5000);
      
      // DEBUG: Verify which account is actually active
      const activeAccount = await page.evaluate(() => {
        // Try to find account name in header/avatar
        const accountElements = document.querySelectorAll('button, a, span');
        for (const el of accountElements) {
          const text = el.textContent?.trim() || '';
          if (text.includes('Riley') || text.includes('@')) {
            const classes = el.className || '';
            if (classes.includes('avatar') || classes.includes('profile') || classes.includes('account')) {
              return text;
            }
          }
        }
        return 'Unknown';
      });
      console.log(`🔍 DEBUG: Active account appears to be: "${activeAccount}"`);
      
      // DEBUG: Check what tweets are visible
      const visibleAuthors = await page.evaluate(() => {
        const items = document.querySelectorAll('[data-cy="new-feed-item"]');
        const authors = [];
        for (let i = 0; i < Math.min(5, items.length); i++) {
          const usernameLink = items[i].querySelector('a.avatar-username');
          if (usernameLink) {
            authors.push(usernameLink.textContent.trim());
          }
        }
        return authors;
      });
      console.log(`🔍 DEBUG: First 5 visible tweet authors: ${visibleAuthors.join(', ')}`);
      
      await sleep(gaussianRandom(2000, 4000));
      
      if (accountState.repliesMade >= accountState.replyTarget) {
        console.log(`✅ ${handle}: Reply target reached`);
        continue;
      }
      
      const remaining = accountState.replyTarget - accountState.repliesMade;
      const expectedSessions = 3;
      const idealPerSession = Math.ceil(accountState.replyTarget / expectedSessions);
      const sessionTarget = Math.min(randomInt(1, idealPerSession + 1), remaining);
      
      console.log(`\n🎯 ${handle}: Target ${sessionTarget} replies (${accountState.repliesMade}/${accountState.replyTarget} today)`);
      console.log(`📊 Likes: ${accountState.likesMade}/${accountState.likeTarget}`);
      
      console.log('📡 Scraping tweets...');
      await sleep(gaussianRandom(2000, 4000));
      
      const tweets = await page.evaluate(() => {
        const results = [];
        const items = document.querySelectorAll('[data-cy="new-feed-item"]');
        
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const textEl = item.querySelector('[data-cy="new-feed-tweet-text"]');
            const text = textEl ? textEl.textContent.trim() : '';
            
            let author = 'Unknown';
            const usernameLink = item.querySelector('a.avatar-username');
            if (usernameLink) {
              author = usernameLink.textContent.trim();
            }
            
            const parent = item.closest('[role="listitem"]');
            let id = null;
            if (parent) {
              const innerDiv = parent.querySelector('[id]');
              if (innerDiv) {
                id = innerDiv.id;
              }
            }
            
            const timeLink = item.querySelector('a[href*="/status/"]');
            let timestamp = new Date().toISOString();
            if (timeLink) {
              const timeText = timeLink.textContent.trim();
              try {
                // Parse "7:00 AM · Jan 09, 2026" format
                // Remove " · " and parse
                const cleanText = timeText.replace(' · ', ' ');
                const parsed = new Date(cleanText);
                
                if (!isNaN(parsed.getTime())) {
                  timestamp = parsed.toISOString();
                } else {
                  console.error('[TIME PARSE] Invalid date:', timeText);
                }
              } catch (e) {
                console.error('[TIME PARSE ERROR]', timeText, e.message);
              }
            } else {
              console.error('[TIME PARSE] No time link found for tweet');
            }
            
            let likes = 0;
            const likeSpan = item.querySelector('span[data-cy="dm-reply-count"]');
            if (likeSpan) {
              const likeText = likeSpan.textContent.trim();
              const match = likeText.match(/([\d.]+)([KMB]?)/i);
              if (match) {
                let num = parseFloat(match[1]);
                const suffix = match[2].toUpperCase();
                if (suffix === 'K') num *= 1000;
                else if (suffix === 'M') num *= 1000000;
                else if (suffix === 'B') num *= 1000000000;
                likes = Math.floor(num);
              }
            }
            
            let retweets = 0;
            const retweetSpan = item.querySelector('span[data-cy="dm-retweet-count"]');
            if (retweetSpan) {
              const rtText = retweetSpan.textContent.trim();
              const match = rtText.match(/([\d.]+)([KMB]?)/i);
              if (match) {
                let num = parseFloat(match[1]);
                const suffix = match[2].toUpperCase();
                if (suffix === 'K') num *= 1000;
                else if (suffix === 'M') num *= 1000000;
                else if (suffix === 'B') num *= 1000000000;
                retweets = Math.floor(num);
              }
            }
            
            if (text.length > 10 && id) {
              results.push({ 
                id,
                author, 
                text, 
                timestamp, 
                likes,
                retweets
              });
            }
          } catch (e) {
            console.error('[SCRAPE ERROR]', e.message);
          }
        }
        
        return results;
      });
      
      console.log(`📨 Extracted ${tweets.length} tweets total`);
      tweets.slice(0, 3).forEach((t, i) => {
        console.log(`  ${i+1}. ${t.author}: "${t.text.substring(0, 60)}..." (${t.likes} likes, ${t.retweets} retweets)`);
      });
      
      const newTweets = tweets.filter(t => !state.processedTweetIds.includes(t.id));
      console.log(`📝 ${newTweets.length} new tweets (filtered ${tweets.length - newTweets.length} already processed)`);
      
      if (newTweets.length === 0) {
        console.log('⏭️ No new tweets to process');
        continue;
      }
      
      await doRetweets(page, accountConfig, accountState, newTweets);
      
      const tweetsWithScores = newTweets.map(tweet => ({
        ...tweet,
        score: calculateEngagementScore(tweet)
      }));
      
      tweetsWithScores.sort((a, b) => b.score - a.score);
      
      const topCount = Math.min(sessionTarget + 4, tweetsWithScores.length);
      const topTweets = tweetsWithScores.slice(0, topCount);
      const selectedTweets = shuffle(topTweets).slice(0, Math.min(sessionTarget, topTweets.length));
      
      console.log(`🎲 Selected ${selectedTweets.length} from top ${topCount}`);
      
      const preLikes = randomInt(1, 5);
      console.log(`💙 Pre-session likes: ${preLikes}`);
      let actualLikesMade = 0;
      for (let i = 0; i < preLikes && actualLikesMade < accountState.likeTarget; i++) {
        await sleep(gaussianRandom(2000, 15000)); // 2-15s between likes
        
        if (DRY_RUN) {
          console.log('💙 [DRY RUN] Would like random tweet');
          actualLikesMade++;
        } else {
          const randomTweet = newTweets[randomInt(0, newTweets.length - 1)];
          const tweetEl = await findTweetElement(page, randomTweet.id);
          if (tweetEl) {
            const liked = await doLike(page, tweetEl, accountState);
            if (liked) actualLikesMade++;
          }
        }
      }
      console.log(`💙 Pre-session likes completed: ${actualLikesMade} successful`);
      
      let repliesThisSession = 0;
      
      for (const tweet of selectedTweets) {
        if (accountState.repliedAuthors.includes(tweet.author)) {
          console.log(`⏭️ Already replied to ${tweet.author} today`);
          continue;
        }
        
        const tweetAge = getTweetAge(tweet.timestamp);
        console.log(`\n💭 ${tweet.author} (${Math.round(tweetAge)}min, ${tweet.likes} likes, ${tweet.retweets} retweets, score: ${tweet.score.toFixed(2)})`);
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
          
          const tweetEl = await findTweetElement(page, tweet.id);
          if (!tweetEl) {
            console.log('⚠️ Tweet element not found');
            continue;
          }
          
          const textareaSelector = 'textarea[placeholder*="What would you like"]';
          try {
            console.log('🔍 DEBUG: Finding tweet element for reply...');
            const tweetEl = await findTweetElement(page, tweet.id);
            if (!tweetEl) {
              console.log('⚠️ Tweet element not found');
              continue;
            }
            console.log('✅ DEBUG: Tweet element found');
            
            // Scroll tweet into view
            await page.evaluate((el) => {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, tweetEl);
            await sleep(gaussianRandom(800, 1500));
            
            // Find VISIBLE textarea within this tweet's context
            console.log('🔍 DEBUG: Looking for VISIBLE textarea...');
            const textareaResult = await page.evaluate((el, selector) => {
              const textareas = el.querySelectorAll(selector);
              
              // Find visible one
              for (const ta of textareas) {
                const rect = ta.getBoundingClientRect();
                const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0;
                
                if (isVisible) {
                  console.log('[BROWSER] Found visible textarea');
                  ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  ta.click();
                  ta.focus();
                  return true;
                }
              }
              
              console.log('[BROWSER] No visible textarea found');
              return false;
            }, tweetEl, textareaSelector);
            
            if (!textareaResult) {
              console.log('⚠️ No visible textarea found in tweet');
              continue;
            }
            console.log('✅ DEBUG: Visible textarea clicked and focused');
            
            await sleep(gaussianRandom(400, 900));
            
            // Type the reply
            console.log('🔍 DEBUG: Typing reply text...');
            await page.keyboard.type(reply, { delay: gaussianRandom(50, 150) });
            console.log('✅ DEBUG: Reply text typed');
            
            // CRITICAL: Manually trigger BOTH input and change events
            await page.evaluate((el, selector) => {
              const textareas = el.querySelectorAll(selector);
              for (const ta of textareas) {
                const rect = ta.getBoundingClientRect();
                const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0;
                if (isVisible) {
                  ta.dispatchEvent(new Event('input', { bubbles: true }));
                  ta.dispatchEvent(new Event('change', { bubbles: true }));
                  console.log('[BROWSER] Input and change events triggered');
                  break;
                }
              }
            }, tweetEl, textareaSelector);
            
            // Wait for button to enable
            await sleep(gaussianRandom(2000, 3000));
            
            // Click Reply button - find ENABLED button with RETRY
            console.log('🔍 DEBUG: Looking for Reply button (try 1)...');
            let replyClicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button[data-cy="new-feed-reply"]'));
              
              const enabledBtn = buttons.find(btn => {
                const rect = btn.getBoundingClientRect();
                const isVisible = rect.width > 0 && rect.height > 0 && 
                                 rect.top >= 0 && rect.bottom <= window.innerHeight;
                return isVisible && !btn.disabled;
              });
              
              if (enabledBtn) {
                console.log('[BROWSER] Found enabled button on try 1, clicking...');
                enabledBtn.click();
                return true;
              }
              
              console.log('[BROWSER] No enabled button on try 1');
              return false;
            });
            
            // RETRY if failed
            if (!replyClicked) {
              console.log('🔄 DEBUG: Retry after 1.5s...');
              await sleep(1500);
              
              replyClicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button[data-cy="new-feed-reply"]'));
                
                const enabledBtn = buttons.find(btn => {
                  const rect = btn.getBoundingClientRect();
                  const isVisible = rect.width > 0 && rect.height > 0 && 
                                   rect.top >= 0 && rect.bottom <= window.innerHeight;
                  return isVisible && !btn.disabled;
                });
                
                if (enabledBtn) {
                  console.log('[BROWSER] Found enabled button on try 2, clicking...');
                  enabledBtn.click();
                  return true;
                }
                
                console.log('[BROWSER] No enabled button on try 2 either');
                return false;
              });
            }
            
            if (replyClicked) {
              await sleep(gaussianRandom(2000, 4000));
              
              console.log('✅ Reply posted!');
              accountState.repliesMade++;
              accountState.repliedAuthors.push(tweet.author);
              state.processedTweetIds.push(tweet.id);
              repliesThisSession++;
              
              // Like after reply - VARIABLE 60-90% instead of fixed 80%
              const likeChance = 0.6 + Math.random() * 0.3; // 60-90%
              if (Math.random() < likeChance && accountState.likesMade < accountState.likeTarget) {
                await sleep(gaussianRandom(2000, 8000)); // Longer wait
                const tweetElAfter = await findTweetElement(page, tweet.id);
                if (tweetElAfter) {
                  await doLike(page, tweetElAfter, accountState);
                }
              }
              
              console.log(`📊 ${accountState.repliesMade}/${accountState.replyTarget} replies, ${accountState.likesMade}/${accountState.likeTarget} likes`);
            } else {
              console.log('⚠️ Reply button not found or not clickable (after 2 tries)');
            }
            
          } catch (err) {
            console.log(`❌ Reply error: ${err.message}`);
          }
          
          if (Math.random() < 0.2 && accountState.likesMade < accountState.likeTarget) {
            await sleep(gaussianRandom(2000, 5000));
            const randomTweet = newTweets[randomInt(0, newTweets.length - 1)];
            const randomTweetEl = await findTweetElement(page, randomTweet.id);
            if (randomTweetEl) {
              await doLike(page, randomTweetEl, accountState);
            }
          }
          
          await sleep(gaussianRandom(5000, 15000));
          
        } catch (err) {
          console.log(`❌ Error: ${err.message}`);
        }
      }
      
      console.log(`\n✅ ${handle} complete: ${repliesThisSession} replies this session`);
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
