'use strict';
// Müzik uçtan uca testi: gerçek YouTube oynatıcısı, iki Chrome. YouTube'a erişilemiyorsa atlanır.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3986;
const SHORT = 'jNQXAC9IVRw'; // "Me at the zoo", 19 sn: bitince sıradakine geçişi test etmek için
const LONG = 'aqz-KE-bpKQ'; // Big Buck Bunny

async function youtubeReachable() {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=' + SHORT, {
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const state = (page) =>
  page.evaluate(() => {
    const S = window.__rv;
    const cur = S.music.current;
    const yt = S.yt;
    const pos = cur ? (cur.pausedAt != null ? cur.pausedAt : (Date.now() + S.clockOffset - cur.startedAt) / 1000) : null;
    return {
      id: cur && cur.id,
      title: cur && cur.title,
      queue: S.music.queue.length,
      ytState: yt ? yt.getPlayerState() : null,
      time: yt ? yt.getCurrentTime() : null,
      expected: pos,
      muted: yt ? yt.isMuted() : null,
      volume: yt ? yt.getVolume() : null,
    };
  });

async function until(page, pred, timeout = 20000, label = 'koşul') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await state(page);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  const chat = await page.textContent('#chat-log').catch(() => '');
  console.log(logs.join(String.fromCharCode(10)));
  throw new Error(`${label} gerçekleşmedi: ${JSON.stringify(last)}
sohbet: ${chat}`);
}

const logs = [];
const PLAYING = 1;
const PAUSED = 2;

test('Müzik: herkes aynı şarkıyı aynı anda çalar, kontroller herkese yansır', { timeout: 180000 }, async (t) => {
  if (!(await youtubeReachable())) {
    t.skip('YouTube erişilemiyor');
    return;
  }
  const srv = createServer({ quiet: true, env: {} });
  await new Promise((r) => srv.server.listen(PORT, r));
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    await srv.close();
  });

  const pages = [];
  for (const name of ['Ahri', 'Brand']) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (/müzik|YouTube/.test(m.text())) logs.push(`[${name}] ${m.text()}`);
    });
    await page.goto(`http://localhost:${PORT}/r/muzik-e2e`);
    await page.fill('#name-input', name);
    await page.click('#join-btn');
    await page.waitForSelector('#room-view:not([hidden])');
    pages.push(page);
  }
  const [A, B] = pages;

  // Ahri müzik sekmesinden ekler
  await A.click('.side-tab[data-tab=music]');
  await A.fill('#music-input', `https://www.youtube.com/watch?v=${LONG}`);
  await A.click('#music-form button[type=submit]');

  for (const p of pages) {
    const s = await until(p, (s) => s.id === LONG && s.ytState === PLAYING, 25000, 'çalma');
    assert.match(s.title, /Big Buck Bunny/);
  }
  // Brand'in sohbetinde bilgi mesajı ve üst çubukta şarkı adı
  assert.match(await B.textContent('#chat-log'), /Ahri çalıyor: Big Buck Bunny/);
  assert.match(await B.textContent('#np-pill'), /Big Buck Bunny/);

  // Senkron: herkes beklenen konumda (±2.5 sn)
  await new Promise((r) => setTimeout(r, 2000));
  for (const p of pages) {
    const s = await state(p);
    assert.ok(Math.abs(s.time - s.expected) < 2.5, `senkron dışı: çalınan ${s.time.toFixed(1)} sn, beklenen ${s.expected.toFixed(1)} sn`);
  }

  // Kulaklık kapatma müziği de susturur; müzik sesi kişiseldir
  await B.click('#deafen-btn');
  await until(B, (s) => s.muted === true, 5000, 'sağırlaştırınca müzik susması');
  await B.click('#deafen-btn');
  await until(B, (s) => s.muted === false, 5000, 'müziğin geri gelmesi');
  await B.evaluate(() => {
    const r = document.querySelector('#m-vol');
    r.value = '10';
    r.dispatchEvent(new Event('input'));
  });
  await until(B, (s) => s.volume === 10, 5000, 'ses seviyesi');
  assert.notEqual((await state(A)).volume, 10, 'müzik sesi sadece o kişiyi etkilemeli');

  // Duraklat / devam herkese yansır
  await A.click('#m-pause');
  await until(B, (s) => s.ytState === PAUSED, 8000, 'duraklama');
  await B.click('.side-tab[data-tab=music]');
  await B.click('#m-pause');
  await until(A, (s) => s.ytState === PLAYING, 8000, 'devam');

  // Sohbet komutuyla sıraya ekleme, sonra geçme
  await B.click('.side-tab[data-tab=chat]');
  await B.fill('#chat-input', `/play https://youtu.be/${SHORT}`);
  await B.press('#chat-input', 'Enter');
  await until(A, (s) => s.queue === 1, 10000, 'sıraya ekleme');
  assert.equal(await A.locator('#music-queue li').count(), 1);
  await A.click('.side-tab[data-tab=music]');
  await A.click('#m-skip');
  for (const p of pages) await until(p, (s) => s.id === SHORT, 10000, 'geçme');

  // Kısa şarkı (19 sn) bitince herkes otomatik olarak sıradakine geçer
  await B.fill('#chat-input', `/play https://youtu.be/${LONG}`);
  await B.press('#chat-input', 'Enter');
  await until(A, (s) => s.queue === 1, 10000, 'sıraya ekleme');
  for (const p of pages) await until(p, (s) => s.id === LONG && s.ytState === PLAYING, 60000, 'bitince sıradakine geçiş');

  // Geç: sıra boş olduğu için müzik durur
  await A.click('#m-skip');
  for (const p of pages) await until(p, (s) => s.id === null && s.ytState !== PLAYING, 8000, 'durma');
  assert.equal(await B.isHidden('#np-pill'), true);
  for (const l of logs) t.diagnostic(l);
});
