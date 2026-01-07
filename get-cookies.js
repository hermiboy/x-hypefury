const puppeteer = require('puppeteer');
const fs = require('fs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

console.log('🔐 Cookie Extractor\n');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--proxy-server=http://isp.decodo.com:10001',
      '--window-size=1920,1080'
    ]
  });

  const page = await browser.newPage();
  
  await page.authenticate({
    username: 'spyh79smmc',
    password: 'DjQmmw+Sl471Dqat2f'
  });
  
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('✅ Chrome opened with YOUR proxy');
  console.log('🌐 Going to HypeFury...\n');

  await page.goto('https://app.hypefury.com/feed', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('⏳ Login now! (X → HypeFury)');
  console.log('⏳ Waiting 90 seconds...\n');

  await sleep(90000);

  console.log('💾 Saving cookies...');

  const cookies = await page.cookies();
  fs.writeFileSync('/root/hypefury-cookies.json', JSON.stringify(cookies, null, 2));

  console.log(`✅ Cookies saved: ${cookies.length} cookies`);
  console.log('✅ File: /root/hypefury-cookies.json\n');
  console.log('Chrome stays open - you can close it manually.\n');

  // NO browser.close()
  // NO process.exit()
})();
