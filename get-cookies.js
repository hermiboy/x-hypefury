const puppeteer = require('puppeteer');
const fs = require('fs');

console.log('🔐 Cookie Extractor (stays open)\n');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,  // SICHTBAR!
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

  console.log('✅ Chrome opened with YOUR proxy');
  console.log('🌐 Going to HypeFury...\n');

  await page.goto('https://app.hypefury.com/feed', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  console.log('⏳ Login now! (X → HypeFury)');
  console.log('⏳ Waiting 90 seconds...\n');

  await page.waitForTimeout(90000);

  console.log('💾 Saving cookies...');

  const cookies = await page.cookies();
  fs.writeFileSync('/root/hypefury-cookies.json', JSON.stringify(cookies, null, 2));

  console.log(`✅ Cookies saved: ${cookies.length} cookies`);
  console.log('✅ File: /root/hypefury-cookies.json');
  console.log('\n🎉 Done! You can close Chrome now.\n');

  // KEIN browser.close()!
  // KEIN process.exit()!
})();
