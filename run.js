const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// سيرفر ويب باش يبقى ريلواي مخليه خدام وما يطفيهش
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

  // تحديد User-Agent باش Haxball ما يبلوكيهش
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // عرض كونسول اللعبة مباشرة فـ Railway
  page.on('console', msg => console.log('[Haxball]', msg.text()));

  // فتح الرابط الرسمي الصحيح
  await page.goto('https://www.haxball.com/headlessweb', { 
    waitUntil: 'domcontentloaded' 
  });

  // تسنى حتى تكمل دالة HBInit (عطيناه 60 ثانية باش ما يوقعش Timeout)
  await page.waitForFunction(() => typeof window.HBInit === 'function', { timeout: 60000 });

  // حقن الماب وتشغيل السكربت
  await page.evaluate((script, map) => {
    window.customMapString = map;
    eval(script);
  }, botScript, mapData);

  console.log('Bot is running on Railway!');
})();
