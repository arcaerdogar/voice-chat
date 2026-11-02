'use strict';
// Biri konuşunca müziği kıs: ayarlar penceresinden açılır, oynatıcıya giden ses kısılır ve geri açılır.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3958;

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(() => localStorage.setItem('rv:autoGate', 'false'));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/r/kis`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  return page;
}

test('konuşunca müziği kıs', { timeout: 90000 }, async (t) => {
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
  await B.waitForFunction(() => [...window.__rv.peers.values()].some((p) => p.pc && p.pc.connectionState === 'connected'), null, { timeout: 25000 });
  // B'de çalan bir müzik oynatıcısı yerine ona giden sesi kaydeden bir sahte oynatıcı
  await B.evaluate(() => {
    window.__vols = [];
    window.__rv.musicVol = 60;
    window.__rv.player = { kind: 'test', setVolume: (v) => window.__vols.push(v), setMuted() {}, destroy() {} };
  });

  // Kapalıyken: Ahri konuşsa da ses değişmez
  await B.waitForSelector('.participant.speaking', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await B.evaluate(() => window.__rv.duckFactor), 1);

  // Ayarlardan aç, %20'ye ayarla
  await B.click('#settings-btn');
  assert.equal(await B.isDisabled('#duck-range'), true, 'kapalıyken kaydırıcı devre dışı');
  await B.check('#duck-check');
  await B.evaluate(() => {
    const r = document.querySelector('#duck-range');
    r.value = '20';
    r.dispatchEvent(new Event('input'));
  });
  assert.equal(await B.textContent('#duck-val'), '%20');
  await B.click('#settings-dialog .dialog-actions button');

  // Ahri konuşuyor (sahte mikrofonun bip sesi): müzik 60 × %20 = 12'ye iner
  await B.waitForFunction(() => window.__rv.duckFactor === 0.2, null, { timeout: 10000 });
  assert.ok((await B.evaluate(() => window.__vols)).includes(12), 'oynatıcıya kısılmış ses gitmeli');

  // Ahri susunca kısa bekleyip eski sesine döner
  await A.click('#mute-btn');
  await B.waitForFunction(() => window.__rv.duckFactor === 1, null, { timeout: 10000 });
  assert.equal(await B.evaluate(() => window.__vols[window.__vols.length - 1]), 60);

  // Tercih hatırlanır
  assert.equal(await B.evaluate(() => localStorage.getItem('rv:duck')), 'true');
  assert.equal(await B.evaluate(() => localStorage.getItem('rv:duckPct')), '20');
  for (const p of [A, B]) assert.deepEqual(p.errors, []);
});
