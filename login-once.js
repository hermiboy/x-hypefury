const puppeteer = require('puppeteer');

console.log('🔐 One-Time Login Setup\n');
console.log('This will open Chrome with your persistent profile.');
console.log('Login to X, then HypeFury, then close Chrome manually.\n');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    userDataDir: '/root/.chrome-hypefury-profile',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--proxy-server=http://isp.decodo.com:10001',
      '--start-maximized'
    ]
  });

  const page = await browser.newPage();
  
  await page.authenticate({
    username: 'spyh79smmc',
    password: 'DjQmmw+Sl471Dqat2f'
  });
  
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('✅ Chrome opened with proxy');
  console.log('🌐 Going to HypeFury...\n');

  await page.goto('https://app.hypefury.com/feed', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('⏳ Login now!');
  console.log('1. Login to X (Twitter)');
  console.log('2. Complete HypeFury login');
  console.log('3. Wait until you see the feed');
  console.log('4. Close this Chrome window');
  console.log('\nChrome will stay open - you can close it manually when done.\n');

  // Keep alive - user closes manually
})();
