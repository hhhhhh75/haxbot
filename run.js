const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// The old https://www.haxball.com/headlessweb endpoint now returns 404.
// The headless client lives at /headless and exposes HBInit on the top window.
const HEADLESS_URL = 'https://www.haxball.com/headless';

// Never commit the room token. Set HAXBALL_TOKEN in Railway -> Variables.
// Be forgiving about copy/paste mistakes such as "HAXBALL_TOKEN = thr1..." or quotes.
function normalizeToken(raw) {
  if (!raw) return '';
  let token = String(raw).trim();
  token = token.replace(/^HAXBALL_TOKEN\s*=\s*/i, '');
  token = token.replace(/^['"]|['"]$/g, '');
  return token.trim();
}

const HAXBALL_TOKEN = normalizeToken(process.env.HAXBALL_TOKEN);

const RETRY_BASE_MS = 15000;
const RETRY_MAX_MS = 120000;
const ROOM_LINK_TIMEOUT_MS = 45000;

const botScript = fs.readFileSync(path.join(__dirname, 'haxbot-EN.js'), 'utf8');
const mapData = fs.readFileSync(path.join(__dirname, 'map.hbs'), 'utf8');

// ---- Health check server (Railway needs an open port) ----
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Haxball Bot is alive and running!');
});
server.listen(PORT, () => {
  console.log(`Web server listening on port ${PORT}`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertToken() {
  if (!HAXBALL_TOKEN) {
    throw new Error(
      'HAXBALL_TOKEN is not set. Add it in Railway -> Variables and redeploy.'
    );
  }
  if (!HAXBALL_TOKEN.startsWith('thr1.')) {
    throw new Error(
      `HAXBALL_TOKEN looks invalid: it must be the token only (starting with "thr1."), ` +
        `got a value of length ${HAXBALL_TOKEN.length}. ` +
        'Remove any "HAXBALL_TOKEN =" prefix, quotes or spaces.'
    );
  }
  console.log(`Token loaded (${HAXBALL_TOKEN.length} chars, starts with thr1.).`);
}

async function waitForRoomLink(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = await page.evaluate(() => window.__roomLink || null);
    if (link) return link;
    await sleep(1000);
  }
  return null;
}

async function startBot() {
  assertToken();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    page.on('console', (msg) => {
      console.log('[Haxball]', msg.text());
    });
    page.on('pageerror', (err) => {
      console.error('[Haxball pageerror]', err.message);
    });

    console.log('Navigating to', HEADLESS_URL);
    const response = await page.goto(HEADLESS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });
    console.log('HTTP status:', response ? response.status() : '(no response)');

    // The headless client is loaded in an iframe but publishes HBInit on
    // window.parent, so it must be awaited on the main page.
    await page.waitForFunction(() => typeof window.HBInit === 'function', {
      timeout: 90000
    });
    console.log('HBInit is ready.');

    const injected = await page.evaluate(
      (script, map, token) => {
        window.customMapString = map;
        window.__HAXBALL_TOKEN = token;
        window.__roomLink = null;
        window.__room = null;

        // Capture the room instance so we can observe its real status.
        const originalHBInit = window.HBInit;
        window.HBInit = function (config) {
          const room = originalHBInit.call(this, config);
          window.__room = room;
          return room;
        };

        try {
          eval(script);
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }

        // The bot script installs an empty onRoomLink; replace it so the
        // real link (proof the room is registered on HaxBall) is logged.
        if (window.__room) {
          try {
            window.__room.onRoomLink = (url) => {
              window.__roomLink = url;
              console.log('ROOM_LINK ' + url);
            };
          } catch (e) {
            // ignore
          }
        }

        return { ok: true, hasRoom: Boolean(window.__room) };
      },
      botScript,
      mapData,
      HAXBALL_TOKEN
    );

    if (!injected || !injected.ok) {
      throw new Error('Bot script threw during injection: ' + (injected && injected.error));
    }
    if (!injected.hasRoom) {
      throw new Error('HBInit did not return a room instance.');
    }
    console.log('Bot script injected, waiting for the room link...');

    const link = await waitForRoomLink(page, ROOM_LINK_TIMEOUT_MS);
    if (!link) {
      throw new Error(
        `Room did not register (no room link after ${ROOM_LINK_TIMEOUT_MS / 1000}s). ` +
          'HaxBall rejected the token (check HAXBALL_TOKEN) or the connection is blocked.'
      );
    }
    console.log('Room is live:', link);

    // Stay alive until the page or browser dies, then let the retry loop
    // restart everything.
    await new Promise((resolve, reject) => {
      browser.once('disconnected', () => reject(new Error('Browser disconnected')));
      page.once('close', () => reject(new Error('Page closed')));
      page.once('error', (err) => reject(new Error('Page crashed: ' + err.message)));
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`[attempt ${attempt}] Starting HaxBall bot...`);
      await startBot();
    } catch (err) {
      console.error(`[attempt ${attempt}] Failed:`, (err && err.stack) || err);
      const delay = Math.min(RETRY_BASE_MS * attempt, RETRY_MAX_MS);
      console.log(`Retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
    }
  }
})();

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
