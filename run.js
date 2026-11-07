const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// سيرفر ويب وهمي للحفاظ على السيرفر نشطاً
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Haxball Bot is alive and running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

(async () => {
  const botScript = fs.readFileSync(path.join(__dirname, 'haxbot-EN.js'), 'utf8');
  const mapData = fs.readFileSync(path.join(__dirname, 'map.hbs'), 'utf8');

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote'
    ]
  });

  const page = await browser.newPage();

  // التقاط رسائل كونسول الصفحة
  page.on('console', msg => console.log('[Haxball]', msg.text()));

  // فتح صفحة الهيدلس الصحيحة
  await page.goto('https://html5.haxball.com/headlessweb', { waitUntil: 'networkidle2' });

  // انتظار تحميل كائن HBInit لتفادي خطأ ReferenceError
  await page.waitForFunction(() => typeof window.HBInit === 'function');

  // تنفيذ كود البوت
  await page.evaluate((script, map) => {
    window.customMapString = map;
    eval(script);
  }, botScript, mapData);

  console.log('Bot is running on Railway!');
})();
