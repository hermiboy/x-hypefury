const puppeteer = require('puppeteer');
const fs = require('fs');

const COOKIES_FILE = '/root/hypefury-cookies.json';
const USERNAME = 'spyh79smmc';
const PASSWORD = 'DjQmmw+Sl471Dqat2f';

console.log('🔐 HypeFury Auto-Login (with Proxy)\n');

async function login() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--proxy-server=http://p.webshare.io:80'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  await page.authenticate({
    username: 'pkmfcjoz-rotate',
    password: 't6m6ifjsrlh3'
  });

  console.log('✅ Browser opened with proxy');
  console.log('🌐 Going to HypeFury...\n');

  await page.goto('https://hypefury.com/login', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('📝 Entering credentials...');

  // Find and fill username
  await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="mail"]', {timeout: 10000});
  await page.type('input[type="email"], input[name="email"], input[placeholder*="mail"]', USERNAME);

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Find and fill password
  await page.type('input[type="password"]', PASSWORD);

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('🔐 Logging in...\n');

  // Click login button
  await page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');

  console.log('⏳ Waiting for login...\n');
  await new Promise(resolve => setTimeout(resolve, 15000));

  console.log('💾 Saving cookies...');

  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));

  console.log(`✅ Cookies saved to: ${COOKIES_FILE}`);
  console.log('✅ Login complete!\n');

  await new Promise(resolve => setTimeout(resolve, 3000));

  await browser.close();
  process.exit(0);
}

login().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
