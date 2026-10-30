'use strict';
// Sunucu ses akışı (yt-dlp) uçtan uca testi: iki Chrome, gerçek YouTube.
// yt-dlp yoksa (YTDLP_BIN ya da PATH) test atlanır.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3973;
const BIN = process.env.YTDLP_BIN || 'yt-dlp';

function ytdlpOk() {
  try {
    execFileSync(BIN, ['--version'], { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

const state = (page) =>
  page.evaluate(() => {
    const S = window.__rv;
    const cur = S.music.current;
    const pl = S.player;
    return {
      id: cur && cur.id,
      title: cur && cur.title,
      kind: pl ? pl.kind : null,
      st: pl ? pl.state() : null,
      time: pl ? pl.time() : null,
      expected: cur ? (cur.pausedAt != null ? cur.pausedAt : (Date.now() + S.clockOffset - cur.startedAt) / 1000) : null,
      queue: S.music.queue.length,
    };
  });

async function until(page, pred, timeout, label) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await state(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} gerçekleşmedi: ${JSON.stringify(last)}\nsohbet: ${await page.textContent('#chat-log')}`);
}

test('Müzik akışı (yt-dlp): isimle arama, sadece ses, senkron, yetki ve veri kullanımı', { timeout: 240000, skip: !ytdlpOk() && 'yt-dlp yok' }, async (t) => {
  const srv = createServer({ quiet: true, env: { YTDLP_BIN: BIN } });
  await new Promise((r) => srv.server.listen(PORT, r));
  assert.equal(await srv.streamReady, true, 'yt-dlp bulunmalı');
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    await srv.close();
  });

  const pages = [];
  const net = {};
  for (const name of ['Ahri', 'Brand']) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    net[name] = { audioBytes: 0, youtube: 0 };
    ctx.on('request', (req) => {
      // Kapak görselleri (i.ytimg.com, ~10 KB) beklenen; video/oynatıcı trafiği olmamalı
      if (/youtube\.com|googlevideo\.com/.test(req.url())) net[name].youtube++;
    });
    ctx.on('requestfinished', async (req) => {
      if (!req.url().includes('/music/audio/')) return;
      try {
        net[name].audioBytes += (await req.sizes()).responseBodySize;
      } catch {}
    });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${PORT}/r/akis`);
    await page.fill('#name-input', name);
    await page.click('#join-btn');
    await page.waitForSelector('#room-view:not([hidden])');
    pages.push(page);
  }
  const [A, B] = pages;
  await A.waitForFunction(() => window.__rv.music.stream === true);
  assert.match(await A.getAttribute('#music-input', 'placeholder'), /Şarkı ara/);

  // Şarkı adıyla ara (API anahtarı yok): sonuç listesi gelir, ilki seçilir
  await A.fill('#music-input', 'sezen aksu firuze');
  await A.click('#music-form button[type=submit]');
  await A.waitForSelector('#music-results button.mp-result', { timeout: 30000 });
  assert.ok((await A.locator('#music-results button.mp-result').count()) >= 3, 'birkaç sonuç listelenmeli');
  assert.match(await A.textContent('#music-results'), /firuze/i);
  await A.click('#music-results button.mp-result >> nth=0');
  assert.equal(await A.isHidden('#music-results'), true);
  let s;
  for (const p of pages) s = await until(p, (s) => s.kind === 'stream' && s.st === 'playing' && s.time > 1, 45000, 'akıştan çalma');
  assert.match(s.title, /Firuze/i);
  assert.ok(srv.musicForTest('akis').current.duration > 200, 'süre baştan bilinmeli');
  assert.match(await B.textContent('#np-sub'), /sadece ses/);

  // Senkron
  await new Promise((r) => setTimeout(r, 2500));
  for (const p of pages) {
    const x = await state(p);
    assert.ok(Math.abs(x.time - x.expected) < 2.5, `senkron dışı: ${x.time.toFixed(1)} / ${x.expected.toFixed(1)}`);
  }
  // Tarayıcı YouTube'a hiç bağlanmıyor, video yok
  assert.equal(net.Ahri.youtube + net.Brand.youtube, 0, 'tarayıcı YouTube’a bağlanmamalı');
  assert.equal(await A.locator('#player-box iframe').count(), 0);

  // Duraklat / devam
  await A.click('#m-pause');
  await until(B, (s) => s.st === 'paused', 8000, 'duraklama');
  await A.click('#m-pause');
  await until(B, (s) => s.st === 'playing', 8000, 'devam');

  // Yetki: yanlış anahtar ve odada olmayan şarkı reddedilir
  const id = (await state(A)).id;
  const token = await A.evaluate(() => window.__rv.streamToken);
  const status = (path) => fetch(`http://localhost:${PORT}${path}`, { headers: { Range: 'bytes=0-10' } }).then((r) => r.status);
  assert.equal(await status(`/music/audio/${id}?k=yanlis`), 403);
  assert.equal(await status(`/music/audio/dQw4w9WgXcQ?k=${token}`), 403, 'odada olmayan şarkı akıtılmamalı');
  assert.equal(await status(`/music/audio/${id}?k=${token}`), 206, 'sarma (Range) desteklenmeli');

  // Veri kullanımı (sunucunun Brand'e gönderdiği ses baytları) ve "bende kapat"
  const brandId = await B.evaluate(() => window.__rv.id);
  const served = () => srv.rooms.get('akis').get(brandId).audioBytes || 0;
  const t0 = Date.now();
  const s0 = served();
  await new Promise((r) => setTimeout(r, 10000));
  const rate = ((served() - s0) * 8) / ((Date.now() - t0) / 1000) / 1000;
  t.diagnostic(`Brand toplam ses verisi: ${(served() / 1e6).toFixed(2)} MB; son 10 sn: ${rate.toFixed(0)} kbit/sn`);
  assert.ok(served() > 200000, 'ses gerçekten sunucudan akmalı');
  await B.click('#m-off');
  await until(B, (s) => s.kind === null, 5000, 'oynatıcının kapanması');
  await new Promise((r) => setTimeout(r, 1000));
  const s1 = served();
  await new Promise((r) => setTimeout(r, 5000));
  assert.ok(served() - s1 < 2000, 'müzik kapalıyken ses indirilmemeli: ' + (served() - s1) + ' bayt');
  await B.click('#m-off');
  await until(B, (s) => s.kind === 'stream' && s.st === 'playing', 20000, 'tekrar açılma');

  // Önceki şarkı yok → çalan şarkıyı baştan başlatır (sarma)
  await A.click('#m-prev');
  for (const p of pages) await until(p, (s) => s.st === 'playing' && s.time < 8 && s.expected < 8, 20000, 'baştan başlama');
});
