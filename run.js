const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// سيرفر ويب وهمي للحفاظ على اتصال السيرفر السحابي
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Haxball Bot is alive and running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

(async () => {
  // قراءة كود البوت وكود الماب
  const botScript = fs.readFileSync(path.join(__dirname, 'haxbot-EN.js'), 'utf8');
  const mapData = fs.readFileSync(path.join(__dirname, 'map.hbs'), 'utf8');

  // إعداد وتشغيل متصفح Puppeteer
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

  // طباعة رسائل كونسول المتصفح (رابط الروم والرسائل) في سجلات السيرفر
  page.on('console', msg => console.log('[Haxball]', msg.text()));

  await page.goto('https://www.haxball.com/headlessweb', { waitUntil: 'networkidle2' });

  // تمرير المتغيرات وتنفيذ السكربت داخل صفحة Haxball
  await page.evaluate((script, map) => {
    window.customMapString = map;
    eval(script);
  }, botScript, mapData);

  console.log('Bot is running on Railway!');
})();
