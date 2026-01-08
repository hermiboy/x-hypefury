const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const https = require('https');

const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const STATE_FILE = '/root/automation-state.json';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    
    state.accounts[account.twitter_handle] = {
      replyTarget: replyTarget,
      repliesMade: 0,
      likeTarget: likeTarget,
      likesMade: 0,
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
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'grok-beta',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Tweet from ${tweetAuthor}: "${tweetText}"` }
      ],
      temperature: 0.8,
      max_tokens: 100
    });
    
    const options = {
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
        'Content-Length': data.length
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const reply = json.choices[0].message.content.trim();
          resolve(reply.replace(/^["']|["']$/g, ''));
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await sleep(3000);

    for (const accountConfig of CONFIG.accounts) {
      const handle = accountConfig.twitter_handle;
      const accountState = state.accounts[handle];
      
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
        
        for (const item of items) {
          try {
            const textEl = item.querySelector('[data-cy="new-feed-tweet-text"]');
            const text = textEl ? textEl.textContent.trim() : '';
            
            const authorEl = item.querySelector('[class*="author"], strong');
            const author = authorEl ? authorEl.textContent.trim() : 'Unknown';
            
            const timeEl = item.querySelector('time, [datetime]');
            const timestamp = timeEl ? 
              (timeEl.getAttribute('datetime') || new Date().toISOString()) : 
              new Date().toISOString();
            
            const likesEl = item.querySelector('[aria-label*="like"], [class*="like"]');
            const likesText = likesEl ? likesEl.textContent.trim() : '0';
            const likes = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
            
            if (text.length > 10) {
              results.push({ 
                author, 
                text, 
                timestamp, 
                likes,
                id: `${author}-${text.substring(0, 50)}`
              });
            }
          } catch (e) {}
        }
        
        return results;
      });
      
      console.log(`📨 Found ${tweets.length} tweets`);
      
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
      
      console.log(`🎲 Selected ${selectedTweets.length} tweets from top ${topCount}`);
      
      const preLikes = randomInt(2, 4);
      console.log(`💙 Pre-session likes: ${preLikes}`);
      for (let i = 0; i < preLikes && accountState.likesMade < accountState.likeTarget; i++) {
        await sleep(gaussianRandom(1000, 3000));
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
          
          const textareaSelector = 'textarea[data-cy="new-feed-text-area"]';
          await page.waitForSelector(textareaSelector, { timeout: 10000 });
          await page.click(textareaSelector);
          await sleep(gaussianRandom(300, 800));
          
          for (const char of reply.split('')) {
            await page.keyboard.type(char);
            await sleep(gaussianRandom(50, 150));
          }
          
          await sleep(gaussianRandom(1000, 2000));
          
          const replyBtn = await page.$('button[data-cy="new-feed-reply"]');
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
              const likeBtn = await page.$('button[aria-label*="like"], button[data-cy*="like"]');
              if (likeBtn) {
                await likeBtn.click();
                console.log('💙 Liked');
                accountState.likesMade++;
              }
            }
            
            console.log(`📊 Progress: ${accountState.repliesMade}/${accountState.replyTarget} replies, ${accountState.likesMade}/${accountState.likeTarget} likes`);
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
      
      console.log(`\n✅ ${handle} session complete: ${repliesThisSession} replies`);
      await sleep(gaussianRandom(120000, 240000));
    }
    
    state.sessionsToday++;
    saveState(state);
    
    console.log('\n📊 SESSION COMPLETE');
    console.log(JSON.stringify(state, null, 2));
    
    await browser.close();
    
  } catch (err) {
    console.error('❌ Session error:', err.message);
    if (browser) await browser.close();
  }
}

runSession().then(() => {
  console.log('\n✅ Bot finished');
  process.exit(0);
}).catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
