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
    const pl = S.player;
    const pos = cur ? (cur.pausedAt != null ? cur.pausedAt : (Date.now() + S.clockOffset - cur.startedAt) / 1000) : null;
    return {
      id: cur && cur.id,
      title: cur && cur.title,
      source: cur && (cur.source || 'yt'),
      queue: S.music.queue.length,
      kind: pl ? pl.kind : null,
      ytState: pl ? pl.state() : null,
      time: pl ? pl.time() : null,
      expected: pos,
      muted: pl ? pl.muted() : null,
      volume: pl ? pl.volume() : null,
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
const PLAYING = 'playing';
const PAUSED = 'paused';
const SC_FULL = 'https://soundcloud.com/forss/flickermood'; // tam çalınabilen parça (3:33)
const SC_SNIP = 'https://soundcloud.com/edsheeran/shape-of-you'; // gömülü oynatıcıda sadece 30 sn önizleme

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

  // Reklam bitişi gibi erken bir "bitti" bildirimi ve tek kişide oynatılamama şarkıyı herkes için kesmemeli
  await A.evaluate(() => {
    const S = window.__rv;
    S.ws.send(JSON.stringify({ t: 'music-ended', key: S.music.current.key, duration: 15 }));
  });
  await B.evaluate(() => {
    const S = window.__rv;
    S.ws.send(JSON.stringify({ t: 'music-failed', key: S.music.current.key, code: 150 }));
  });
  await B.waitForSelector('#toast:not([hidden])');
  assert.match(await B.textContent('#toast'), /sende oynatılamıyor/);
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of pages) {
    const s = await state(p);
    assert.equal(s.id, LONG, 'şarkı kesilmemeliydi');
    assert.equal(s.ytState, PLAYING);
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

  // Geçmiş listesi ve önceki şarkı: herkes bir önceki şarkıya (kısa video) döner
  await until(B, () => true, 1000);
  assert.ok((await B.locator('#music-history li').count()) >= 1, 'son çalınanlar listesi görünmeli');
  await A.click('#m-prev');
  for (const p of pages) await until(p, (s) => s.id === SHORT && s.ytState === PLAYING, 15000, 'önceki şarkı');
  assert.match(await B.textContent('#chat-log'), /Ahri önceki şarkıya döndü/);

  // Tekrar modu herkese yansır (kapalı → liste → tek şarkı)
  await A.click('#m-loop');
  await B.waitForFunction(() => window.__rv.music.loop === 'all');
  const loopClass = await B.getAttribute('#m-loop', 'class');
  assert.ok(loopClass.split(' ').includes('on'), 'tekrar butonu açık görünmeli: ' + loopClass + ' / mod: ' + (await B.evaluate(() => window.__rv.music.loop)));
  await B.click('.side-tab[data-tab=music]');
  await B.click('#m-loop');
  await A.waitForFunction(() => window.__rv.music.loop === 'one');
  assert.equal(await A.textContent('#m-loop'), '🔂');

  // Durdur: müzik herkeste durur
  await A.click('#m-stop');
  for (const p of pages) await until(p, (s) => s.id === null && s.ytState !== PLAYING, 8000, 'durma');
  assert.equal(await B.isHidden('#np-pill'), true);
  for (const l of logs) t.diagnostic(l);
});

async function soundcloudReachable() {
  try {
    const r = await fetch('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(SC_FULL), { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

test('Müzik: SoundCloud (sadece ses), "bende kapat" ve önizleme algılama', { timeout: 180000 }, async (t) => {
  if (!(await soundcloudReachable())) {
    t.skip('SoundCloud erişilemiyor');
    return;
  }
  const srv = createServer({ quiet: true, env: {} });
  await new Promise((r) => srv.server.listen(PORT + 1, r));
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    await srv.close();
  });
  const pages = [];
  const mediaBytes = {};
  for (const name of ['Ahri', 'Brand']) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    mediaBytes[name] = 0;
    // Müzik akışının indirdiği baytlar (SoundCloud ses dosyaları)
    ctx.on('requestfinished', async (req) => {
      if (!/sndcdn.com|soundcloud.cloud/.test(req.url())) return;
      try {
        const s = await req.sizes();
        mediaBytes[name] += s.responseBodySize;
      } catch {}
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (/müzik/.test(m.text())) logs.push(`[${name}] ${m.text()}`);
    });
    await page.goto(`http://localhost:${PORT + 1}/r/sc-e2e`);
    await page.fill('#name-input', name);
    await page.click('#join-btn');
    await page.waitForSelector('#room-view:not([hidden])');
    pages.push(page);
  }
  const [A, B] = pages;

  await A.click('.side-tab[data-tab=music]');
  await A.fill('#music-input', SC_FULL);
  await A.click('#music-form button[type=submit]');
  for (const p of pages) {
    const s = await until(p, (s) => s.source === 'sc' && s.kind === 'sc' && s.ytState === PLAYING && s.time > 1, 30000, 'SoundCloud çalma');
    assert.equal(s.title, 'Flickermood');
  }
  // Süre parça yüklenince bilinir ve sunucuya bildirilir
  await until(A, () => true, 1000);
  assert.ok(Math.abs(srv.musicForTest('sc-e2e').current.duration - 213.9) < 1, 'SoundCloud süresi bildirilmeli');
  // Senkron
  await new Promise((r) => setTimeout(r, 2500));
  for (const p of pages) {
    const s = await state(p);
    assert.ok(Math.abs(s.time - s.expected) < 2.5, `SoundCloud senkron dışı: ${s.time.toFixed(1)} / ${s.expected.toFixed(1)}`);
  }
  // Sadece ses: sayfada YouTube oynatıcısı yok
  assert.equal(await A.locator('#player-box iframe[src*="youtube"]').count(), 0);

  // "Bende kapat": Brand'de oynatıcı tamamen kapanır, internet harcamaz; Ahri'de çalmaya devam eder
  await B.click('.side-tab[data-tab=music]');
  await B.click('#m-off');
  await until(B, (s) => s.kind === null, 5000, 'oynatıcının kapanması');
  assert.match(await B.textContent('#m-off'), /sende kapalı/);
  const before = mediaBytes.Brand;
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(mediaBytes.Brand, before, 'müzik kapalıyken hiç ses verisi indirilmemeli');
  assert.equal((await state(A)).ytState, PLAYING, 'diğerlerinde çalmaya devam etmeli');
  // Tekrar açınca kaldığı yerden (herkesle aynı konumda) başlar
  await B.click('#m-off');
  const back = await until(B, (s) => s.kind === 'sc' && s.ytState === PLAYING && s.time > 5, 20000, 'tekrar açılma');
  assert.ok(Math.abs(back.time - back.expected) < 3, 'tekrar açınca herkesle aynı yerde olmalı');

  // Sadece önizleme veren parça: herkeste algılanır, API anahtarı yoksa açıklamayla geçilir
  await A.fill('#music-input', SC_SNIP);
  await A.click('#music-form button[type=submit]');
  await until(A, (s) => s.queue === 1, 10000, 'sıraya ekleme');
  await A.click('#m-skip');
  await until(A, (s) => s.id === null, 30000, 'önizlemenin geçilmesi');
  assert.match(await B.textContent('#chat-log'), /sadece 30 sn önizlemesini veriyor/);
  for (const l of logs) t.diagnostic(l);
});
