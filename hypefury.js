const puppeteer = require('puppeteer');
const fs = require('fs');

const COOKIES_FILE = '/root/hypefury-cookies.json';
const STATE_FILE = '/root/automation-state.json';

const ACCOUNTS = {
  '@onlyrileyreeves': { dailyTarget: 23, replies: 0 },
  '@itsrileyreeves': { dailyTarget: 17, replies: 0 }
};

const AI_STYLES = [
  "That's a game-changer! 🔥",
  "This hits different 💯",
  "Absolutely love this perspective!",
  "This is exactly what I needed to hear today 🙌",
  "Golden advice right here ✨"
];

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const today = new Date().toDateString();
      if (data.date === today) return data;
    }
  } catch (err) {}
  return {
    date: new Date().toDateString(),
    accounts: ACCOUNTS,
    sessionsToday: 0
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getRandomReply() {
  return AI_STYLES[Math.floor(Math.random() * AI_STYLES.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runSession() {
  const state = loadState();
  console.log('\n🚀 SESSION START');
  console.log('📊 State:', JSON.stringify(state, null, 2));

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--proxy-server=http://isp.decodo.com:10001'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    await page.authenticate({
      username: 'spyh79smmc',
      password: 'DjQmmw+Sl471Dqat2f'
    });

    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      await page.setCookie(...cookies);
      console.log('✅ Cookies loaded');
    }

    console.log('🌐 Loading Engagement Builder...');
    await page.goto('https://hypefury.com/engagement-builder', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(3000);

    const currentAccount = await page.evaluate(() => {
      const dropdown = document.querySelector('button.btn-dropdown.btn-highlight');
      return dropdown ? dropdown.textContent.trim() : null;
    });
    console.log(`📍 Current account: ${currentAccount || 'unknown'}`);

    let targetAccount = null;
    for (const [handle, data] of Object.entries(state.accounts)) {
      if (data.replies < data.dailyTarget) {
        targetAccount = handle;
        break;
      }
    }

    if (!targetAccount) {
      console.log('✅ All daily targets met!');
      await browser.close();
      return;
    }

    console.log(`🎯 Target account: ${targetAccount}`);

    if (currentAccount && currentAccount.includes && !currentAccount.includes(targetAccount.replace('@', ''))) {
      console.log('🔄 Switching accounts...');
      await page.click('button.btn-dropdown.btn-highlight');
      await sleep(1000);

      const switched = await page.evaluate((target) => {
        const buttons = Array.from(document.querySelectorAll('button.btn-dropdown:not(.btn-highlight)'));
        const targetBtn = buttons.find(btn => btn.textContent.includes(target.replace('@', '')));
        if (targetBtn) {
          targetBtn.click();
          return true;
        }
        return false;
      }, targetAccount);

      if (switched) {
        console.log('✅ Account switched!');
        await sleep(3000);
      }
    }

    console.log('⏳ Waiting for tweets...');
    await page.waitForSelector('article, div[data-testid="tweet"], .tweet-card', {
      timeout: 15000
    });
    await sleep(2000);

    console.log('🔍 Finding tweets...');
    const tweetSelectors = ['article', 'div[data-testid="tweet"]', '.tweet-card', 'div[class*="tweet"]'];
    
    let tweets = [];
    for (const selector of tweetSelectors) {
      tweets = await page.$$(selector);
      if (tweets.length > 0) {
        console.log(`✅ Found ${tweets.length} tweets with: ${selector}`);
        break;
      }
    }

    if (tweets.length === 0) {
      console.log('❌ No tweets found');
      await browser.close();
      return;
    }

    const tweetsToProcess = Math.min(2, tweets.length);
    console.log(`📝 Processing ${tweetsToProcess} tweets...`);

    for (let i = 0; i < tweetsToProcess; i++) {
      try {
        console.log(`\n--- Tweet ${i + 1}/${tweetsToProcess} ---`);

        await tweets[i].click();
        await sleep(1500);

        const replyButtonSelectors = [
          'button[data-testid="reply"]',
          'button[aria-label*="Reply"]',
          'div[data-testid="reply"]',
          'button[class*="reply"]'
        ];

        let replyClicked = false;
        for (const selector of replyButtonSelectors) {
          const replyBtn = await page.$(selector);
          if (replyBtn) {
            console.log(`🎯 Found reply button: ${selector}`);
            await replyBtn.click();
            replyClicked = true;
            break;
          }
        }

        if (!replyClicked) {
          console.log('⚠️  Reply button not found, skipping...');
          continue;
        }

        await sleep(2000);

        const textareaSelectors = [
          'textarea[placeholder*="reply"]',
          'textarea[data-testid="tweetTextarea"]',
          'div[contenteditable="true"]',
          'textarea'
        ];

        let textInput = null;
        for (const selector of textareaSelectors) {
          textInput = await page.$(selector);
          if (textInput) {
            console.log(`✅ Found text input: ${selector}`);
            break;
          }
        }

        if (!textInput) {
          console.log('⚠️  Text input not found, skipping...');
          continue;
        }

        const reply = getRandomReply();
        console.log(`💬 Typing: "${reply}"`);
        await textInput.type(reply, { delay: 100 });
        await sleep(1000);

        const sendButtonSelectors = [
          'button[data-testid="tweetButton"]',
          'button[data-testid="tweetButtonInline"]',
          'button[aria-label*="Reply"]',
          'button[type="submit"]'
        ];

        let sendClicked = false;
        for (const selector of sendButtonSelectors) {
          const sendBtn = await page.$(selector);
          if (sendBtn) {
            console.log(`📤 Found send button: ${selector}`);
            await sendBtn.click();
            sendClicked = true;
            break;
          }
        }

        if (sendClicked) {
          console.log('✅ Reply sent!');
          state.accounts[targetAccount].replies++;
          await sleep(2000);
        }

      } catch (err) {
        console.log(`❌ Error on tweet ${i + 1}:`, err.message);
      }
    }

    state.sessionsToday++;
    saveState(state);

    console.log('\n📊 SESSION COMPLETE');
    console.log('Updated state:', JSON.stringify(state, null, 2));

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
