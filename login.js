const puppeteer = require('puppeteer');
const fs = require('fs');

const COOKIES_FILE = '/root/hypefury-cookies.json';

console.log('🔐 HypeFury Login Script (with Proxy)');
console.log('Browser opens in 3 seconds...');
console.log('You have 90 seconds to login manually\n');

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

  console.log('⏳ Please login now...');
  console.log('⏳ Waiting 90 seconds...\n');

  await new Promise(resolve => setTimeout(resolve, 90000));

  console.log('💾 Saving cookies...');

  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));

  console.log(`✅ Cookies saved to: ${COOKIES_FILE}`);
  console.log('✅ Login complete!\n');

  await browser.close();
  process.exit(0);
}

login().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
