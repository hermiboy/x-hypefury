const puppeteer = require('puppeteer');
const fs = require('fs');

console.log('🔐 Cookie Extractor (with Proxy)\n');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--proxy-server=http://isp.decodo.com:10001'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  await page.authenticate({
    username: 'spyh79smmc',
    password: 'DjQmmw+Sl471Dqat2f'
  });

  console.log('✅ Browser opened with YOUR proxy (46.202.223.9)');
  console.log('🌐 Going to HypeFury...\n');

  await page.goto('https://app.hypefury.com/feed', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('⏳ Please login now (X → HypeFury)');
  console.log('⏳ Waiting 60 seconds...\n');

  await page.waitForTimeout(60000);

  console.log('💾 Extracting cookies...');

  const cookies = await page.cookies();
  fs.writeFileSync('/root/hypefury-cookies.json', JSON.stringify(cookies, null, 2));

  console.log(`✅ Cookies saved: /root/hypefury-cookies.json`);
  console.log(`✅ Found ${cookies.length} cookies`);
  console.log('✅ Done!\n');

  await browser.close();
  process.exit(0);
})();
