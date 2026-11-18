const http = require('http');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Some hosts (Botkeep, Pterodactyl-style panels) write the configured variables
// to a .env file next to the code instead of exporting them to the process.
// Load it before anything reads process.env.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
})();

const PORT = process.env.PORT || 3000;

// The old https://www.haxball.com/headlessweb endpoint now returns 404.
// The headless client lives at /headless and exposes HBInit on the top window.
const HEADLESS_URL = 'https://www.haxball.com/headless';

// Never commit the room token. Set HAXBALL_TOKEN in the host environment
// (Botkeep -> Environment, Railway -> Variables, or /etc/haxbot.env).
// Be forgiving about copy/paste mistakes such as "HAXBALL_TOKEN = thr1..." or quotes.
function normalizeToken(raw) {
  if (!raw) return '';
  let token = String(raw).trim();
  token = token.replace(/^HAXBALL_TOKEN\s*=\s*/i, '');
  token = token.replace(/^['"]|['"]$/g, '');
  return token.trim();
}

const HAXBALL_TOKEN = normalizeToken(process.env.HAXBALL_TOKEN);

// Optional room geolocation, e.g. GEO_CODE=MA GEO_LAT=33.5731 GEO_LON=-7.5898.
// Leave GEO_CODE empty to let HaxBall pick the default.
const GEO_CODE = (process.env.GEO_CODE || '').trim();
const GEO = GEO_CODE
  ? {
      code: GEO_CODE.toUpperCase(),
      lat: Number(process.env.GEO_LAT || 33.5731),
      lon: Number(process.env.GEO_LON || -7.5898)
    }
  : undefined;

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
      'HAXBALL_TOKEN is not set. Add it to the environment ' +
        '(Botkeep -> Environment, Railway -> Variables, or /etc/haxbot.env) and restart.'
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
  console.log(GEO ? `Geo: ${GEO.code} (${GEO.lat}, ${GEO.lon})` : 'Geo: not set');

  const browser = await puppeteer.launch({
    headless: 'new',
    // Small VMs (Fly.io shared-cpu) can take longer than the 180 s default to
    // answer the first CDP calls; without this Chrome "times out" and the bot
    // restarts in a loop.
    protocolTimeout: 300000,
    // Use a system Chromium when provided (needed on ARM, where the bundled
    // Chrome for Testing build does not exist).
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // HaxBall's docs: on a VPS, Chrome >= 78 hides the local IP behind mDNS,
      // which breaks hosting (room created but nobody can join).
      '--disable-features=WebRtcHideLocalIpsWithMdns'
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

    // Why the room never registers is invisible from Node: the failure happens
    // inside the page (captcha, WebSocket handshake, token rejection). Keep a
    // minimal trace for `fly logs`.
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (!/haxball|hbserver|webrtc/i.test(url)) return;
      const failure = req.failure();
      console.log('[net] failed:', url, (failure && failure.errorText) || '?');
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
      (script, map, token, geo) => {
        window.customMapString = map;
        window.__HAXBALL_TOKEN = token;
        window.__HAXBALL_GEO = geo;
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
      HAXBALL_TOKEN,
      GEO
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
      // HaxBall asks for a captcha whenever the token is missing, invalid or
      // expired (tokens from /headlesstoken only live a few minutes). Detect
      // the widget so the logs say exactly what to do instead of "unknown".
      const captcha = await page
        .evaluate(() => {
          const hasWidget = (doc) => {
            const el = doc.getElementById && doc.getElementById('recaptcha');
            return Boolean(el && el.childElementCount > 0);
          };
          if (hasWidget(document)) return true;
          for (const frame of Array.from(document.querySelectorAll('iframe'))) {
            try {
              if (frame.contentDocument && hasWidget(frame.contentDocument)) return true;
            } catch (e) {
              // cross-origin frame, ignore
            }
          }
          return false;
        })
        .catch(() => false);

      if (captcha) {
        throw new Error(
          'HaxBall displayed a CAPTCHA instead of the room link: HAXBALL_TOKEN is ' +
            'missing, invalid or expired. Tokens from https://www.haxball.com/headlesstoken ' +
            'expire after a few minutes, so a fresh one must be set right before the bot starts.'
        );
      }

      throw new Error(
        `Room did not register (no room link after ${ROOM_LINK_TIMEOUT_MS / 1000}s) ` +
          'and no captcha was shown: the connection to HaxBall failed.'
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
