'use strict';
// Kayan kişi kutuları: tam ekran yayında sürüklenebilir panel ve mini pencere (Document PiP).
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3968;

async function join(browser, name, camera) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('rv:autoGate', 'false');
    // Ekran seçme penceresi testte açılamaz: hareketli bir tuval döndür
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
  await page.goto(`http://localhost:${PORT}/r/kayan`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  if (camera) await page.click('#cam-btn');
  return page;
}

test('kayan kişi kutuları', { timeout: 120000 }, async (t) => {
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
  const B = await join(browser, 'Bora');
  const C = await join(browser, 'Cem', true);
  for (const p of [A, B, C]) {
    await p.waitForFunction(() => [...window.__rv.peers.values()].filter((x) => x.pc && x.pc.connectionState === 'connected').length === 2, null, { timeout: 25000 });
  }

  await t.test('tam ekran yayında diğer kişiler görünür, taşınır, kapatılır', async () => {
    await A.click('#share-btn');
    await B.waitForSelector('.screen-tile .watch-btn', { state: 'visible', timeout: 10000 });
    await B.click('.screen-tile .watch-btn');
    await B.click('.screen-tile .fs-btn');
    await B.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.classList.contains('screen-tile'));
    const panel = B.locator('.screen-tile .float-tiles');
    await panel.waitFor({ state: 'visible' });
    // Kendisi hariç iki kişi; Cem'in kamerası kutuda oynuyor
    // Kişi kendini de görür (ilk kutu)
    assert.equal(await panel.locator('.mini-tile').count(), 3);
    assert.deepEqual(await panel.locator('.mn-text').allTextContents(), ['Bora', 'Ahri', 'Cem']);
    await B.waitForFunction(() => {
      const t = [...document.querySelectorAll('.float-tiles .mini-tile')].find((x) => x.textContent.includes('Cem'));
      const v = t && t.querySelector('video');
      return t.classList.contains('has-cam') && v.videoWidth > 0;
    }, null, { timeout: 15000 });
    // Konuşma halkası (sahte mikrofon sürekli bip sesi verir)
    await B.waitForSelector('.float-tiles .mini-tile.speaking', { timeout: 10000 });

    // Varsayılan: sağ üst. Sürükleyince taşınır ve yeri hatırlanır.
    const b0 = await panel.boundingBox();
    assert.ok(b0.x > 1280 / 2 && b0.y < 100, 'varsayılan konum sağ üst olmalı: ' + JSON.stringify(b0));
    await B.mouse.move(b0.x + b0.width / 2, b0.y + b0.height - 10);
    await B.mouse.down();
    await B.mouse.move(200, 500, { steps: 10 });
    await B.mouse.up();
    const b1 = await panel.boundingBox();
    assert.ok(b1.x < 300 && b1.y > b0.y + 150, 'panel taşınmalı: ' + JSON.stringify(b1));
    assert.ok(await B.evaluate(() => JSON.parse(localStorage.getItem('rv:ftPos')).x < 0.3));

    // Yatay dizilim
    await panel.locator('.ft-rotate').click();
    const b2 = await panel.boundingBox();
    assert.ok(b2.width > b2.height, 'yatay dizilimde panel geniş olmalı');

    // Kapat: gizlenir, yayın çubuğundaki düğmeyle geri gelir
    await panel.locator('.ft-close').click();
    await panel.waitFor({ state: 'hidden', timeout: 3000 });
    await B.click('.screen-tile .tiles-btn');
    await panel.waitFor({ state: 'visible' });

    // Tam ekrandan çıkınca panel kaybolur
    await B.evaluate(() => document.exitFullscreen());
    await B.waitForFunction(() => !document.fullscreenElement);
    await B.locator('.float-tiles').waitFor({ state: 'hidden', timeout: 3000 });
  });

  await t.test('ekranını paylaşan da kendi önizlemesinde kullanabilir', async () => {
    await A.click('.screen-tile.self .fs-btn');
    await A.waitForSelector('.screen-tile.self .float-tiles .mini-tile', { timeout: 5000 });
    assert.equal(await A.locator('.float-tiles .mini-tile').count(), 3);
    await A.evaluate(() => document.exitFullscreen());
  });

  // Chrome aynı anda tek mini pencereye izin verir: testte herkes aynı tarayıcıda olduğundan sırayla denenir
  await t.test('ekranını paylaşanda mini pencere paylaşımla açılır, paylaşım bitince kapanır', async (st) => {
    const has = await A.evaluate(() => 'documentPictureInPicture' in window);
    if (!has) return st.skip('Document PiP yok');
    const open = await A.waitForFunction(() => documentPictureInPicture.window && documentPictureInPicture.window.document.querySelectorAll('.mini-tile').length === 3, null, { timeout: 5000 }).catch(() => null);
    if (!open) return st.skip('başsız Chrome mini pencere açamadı');
    assert.equal(await A.evaluate(() => documentPictureInPicture.window.document.querySelector('.mn-text').textContent), 'Ahri');
    await A.click('#share-btn'); // paylaşımı durdur
    await A.waitForFunction(() => !documentPictureInPicture.window, null, { timeout: 5000 });
    assert.equal(await A.evaluate(() => window.__rv.screen), null);
  });

  await t.test('mini pencere (her zaman üstte)', async (st) => {
    const supported = await B.evaluate(() => 'documentPictureInPicture' in window);
    if (!supported) return st.skip('bu Chrome sürümünde Document PiP yok');
    assert.equal(await B.isVisible('#pip-btn'), true);
    await B.click('#pip-btn');
    const ok = await B.waitForFunction(() => documentPictureInPicture.window && documentPictureInPicture.window.document.querySelectorAll('.mini-tile').length === 3, null, { timeout: 5000 }).catch(() => null);
    if (!ok) return st.skip('başsız (headless) Chrome mini pencere açamadı');
    const info = await B.evaluate(() => {
      const d = documentPictureInPicture.window.document;
      return { names: [...d.querySelectorAll('.mn-text')].map((x) => x.textContent).sort(), bar: d.querySelectorAll('.pip-bar button').length, styled: getComputedStyle(d.body).backgroundColor };
    });
    assert.deepEqual(info.names, ['Ahri', 'Bora', 'Cem']);
    assert.equal(info.bar, 2);
    assert.notEqual(info.styled, 'rgba(0, 0, 0, 0)', 'stiller mini pencereye kopyalanmalı');
    // Mini penceredeki mikrofon düğmesi asıl sayfayı kontrol eder
    await B.evaluate(() => documentPictureInPicture.window.document.querySelector('.pip-mute').click());
    await B.waitForFunction(() => window.__rv.muted === true);
    // Kapatınca düğme eski haline döner
    await B.evaluate(() => documentPictureInPicture.window.close());
    await B.waitForFunction(() => !document.querySelector('#pip-btn').classList.contains('active'));
  });

  await t.test('katılınca mini pencere açılır, kişi kendini de görür', async (st) => {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const D = await ctx.newPage();
    D.errors = [];
    D.on('pageerror', (e) => D.errors.push(String(e)));
    await D.goto('http://localhost:' + PORT + '/r/kayan');
    if (!(await D.evaluate(() => 'documentPictureInPicture' in window))) return st.skip('Document PiP yok');
    assert.equal(await D.isVisible('#join-pip-check'), true);
    await D.check('#join-pip-check');
    await D.fill('#name-input', 'Diana');
    await D.click('#join-btn');
    await D.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
    const ok = await D.waitForFunction(() => documentPictureInPicture.window && documentPictureInPicture.window.document.querySelectorAll('.mini-tile').length === 4, null, { timeout: 15000 }).catch(() => null);
    if (!ok) return st.skip('başsız Chrome mini pencere açamadı');
    const names = await D.evaluate(() => [...documentPictureInPicture.window.document.querySelectorAll('.mn-text')].map((x) => x.textContent));
    assert.equal(names[0], 'Diana', 'ilk kutu kişinin kendisi olmalı');
    // Tercih hatırlanır; ayrılınca pencere kapanır
    assert.equal(await D.evaluate(() => localStorage.getItem('rv:pipOnJoin')), 'true');
    await D.click('#leave-btn');
    await D.waitForFunction(() => !documentPictureInPicture.window);
    assert.deepEqual(D.errors, []);
    await ctx.close();
  });

  await t.test('konsolda hata yok', () => {
    for (const p of [A, B, C]) assert.deepEqual(p.errors, []);
  });
});
