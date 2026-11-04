'use strict';
// Odak: bir kutu (kamera/kişi ya da yayın) büyük, diğerleri altta şeritte.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3957;

async function join(browser, name, camera) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('rv:autoGate', 'false');
    localStorage.setItem('rv:pipOnShare', 'false');
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d');
      let f = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(f++ * 7) % 360} 70% 45%)`;
        g.fillRect(0, 0, c.width, c.height);
      }, 33);
      return c.captureStream(30);
    };
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/r/odak`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  if (camera) await page.click('#cam-btn');
  return page;
}

const names = (page, sel) => page.locator(sel).allTextContents();

test('odak düzeni', { timeout: 120000 }, async (t) => {
  const srv = createServer({ quiet: true, env: {} });
  await new Promise((r) => srv.server.listen(PORT, r));
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close();
    await srv.close();
  });
  const A = await join(browser, 'Ahri');
  const B = await join(browser, 'Bora', true);
  const C = await join(browser, 'Cem');
  for (const p of [A, B, C]) {
    await p.waitForFunction(() => [...window.__rv.peers.values()].filter((x) => x.pc && x.pc.connectionState === 'connected').length === 2, null, { timeout: 25000 });
  }
  await A.click('#share-btn');
  await C.waitForSelector('.screen-tile .watch-btn', { state: 'visible', timeout: 10000 });
  const bora = C.locator('.participant', { has: C.locator('.name', { hasText: 'Bora' }) });
  await C.waitForFunction(() => {
    const v = [...document.querySelectorAll('.participant')].find((x) => x.textContent.includes('Bora'))?.querySelector('.cam-video');
    return v && v.videoWidth > 0 && !v.paused;
  }, null, { timeout: 15000 });
  const order = await names(C, '#participants .participant .name');

  await t.test('kamerayı odakla: büyük görünür, diğerleri şeritte, görüntü durmaz', async () => {
    await bora.hover();
    await bora.locator('.spot-btn').click();
    assert.match(await C.getAttribute('.stage', 'class'), /\bspotlit\b/);
    assert.deepEqual(await names(C, '#spot .participant .name'), ['Bora']);
    assert.deepEqual((await names(C, '#participants .participant .name')).sort(), ['Ahri', 'Cem']);
    assert.equal(await C.locator('.call-strip .screen-tile').count(), 1, 'yayın kutusu da şeritte');
    // Büyük ve 16:9, alana sığıyor
    const sb = await C.locator('#spot').boundingBox();
    const b = await bora.boundingBox();
    // Alana (sohbet altta olduğu için görüşme alanının yüksekliğine) sığan en büyük 16:9 boyut
    const fit = Math.min(sb.width - 32, ((sb.height - 16) * 16) / 9);
    assert.ok(b.width >= fit - 2, `odaktaki kutu alana sığan en büyük boyutta olmalı: ${b.width} / ${fit}`);
    assert.ok(Math.abs(b.width / b.height - 16 / 9) < 0.02 && b.height <= sb.height + 1 && b.width <= sb.width + 1);
    const strip = await C.locator('#participants .participant').first().boundingBox();
    assert.ok(strip.width < 250, 'şeritteki kutular küçük olmalı');
    // Taşıma görüntüyü durdurmamalı
    const t0 = await bora.locator('.cam-video').evaluate((v) => v.currentTime);
    await new Promise((r) => setTimeout(r, 800));
    const v = await bora.locator('.cam-video').evaluate((v) => ({ t: v.currentTime, paused: v.paused }));
    assert.ok(!v.paused && v.t > t0, 'kamera görüntüsü oynamaya devam etmeli');
    assert.equal(await bora.locator('.spot-btn').getAttribute('title'), 'Odaktan çık (Esc)');
  });

  await t.test('şeritten yayına geç: yer değişir, kutular eski sırasına döner', async () => {
    await C.locator('.call-strip .screen-tile').click({ position: { x: 20, y: 20 } });
    assert.equal(await C.locator('#spot .screen-tile').count(), 1);
    assert.deepEqual(await names(C, '#participants .participant .name'), order, 'kişi kutuları eski sırasında');
    // Odaktaki yayında düğmeler çalışır, odak değişmez
    await C.click('#spot .watch-btn');
    await C.waitForFunction(() => document.querySelector('#spot .screen-video').videoWidth > 0, null, { timeout: 15000 });
    assert.equal(await C.locator('#spot .screen-tile.watching').count(), 1);
  });

  await t.test('Esc ile çıkılır; izlenen yayın varken yayın odağı (eski düzen) sürer', async () => {
    await C.keyboard.press('Escape');
    assert.doesNotMatch(await C.getAttribute('.stage', 'class'), /\bspotlit\b/);
    assert.match(await C.getAttribute('.stage', 'class'), /\bfocus\b/);
    assert.equal(await C.locator('#spot').isHidden(), true);
    assert.equal(await C.locator('#screens .screen-tile').count(), 1);
    assert.deepEqual(await names(C, '#participants .participant .name'), order);
  });

  await t.test('kutuya tıklamak da odaklar; odaktaki kişi ayrılınca ızgaraya dönülür', async () => {
    await C.locator('.participant', { has: C.locator('.name', { hasText: 'Ahri' }) }).click({ position: { x: 30, y: 30 } });
    assert.deepEqual(await names(C, '#spot .participant .name'), ['Ahri']);
    await A.click('#leave-btn');
    await C.waitForFunction(() => !document.querySelector('.stage').classList.contains('spotlit'), null, { timeout: 15000 });
    assert.equal(await C.locator('#spot').isHidden(), true);
    assert.deepEqual((await names(C, '#participants .participant .name')).sort(), ['Bora', 'Cem']);
  });

  await t.test('konsolda hata yok', () => {
    for (const p of [A, B, C]) assert.deepEqual(p.errors, []);
  });
});
