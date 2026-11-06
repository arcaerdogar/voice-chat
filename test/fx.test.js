'use strict';
// Efektler: ses efektleri (ton kaydırma ölçülür), ses tahtası (hazır + yüklenen), ses + efekt kombinasyonu.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3955;
const BASE = `http://localhost:${PORT}`;

/** 48 kHz mono 16 bit sinüs WAV */
function wav(seconds, freq) {
  const rate = 48000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2);
  return buf;
}

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1400, height: 900 } });
  // Testte gürültü engelleme kapalı: sahte mikrofonun tonu silinmesin (efekt zinciri yine kurulur)
  await ctx.addInitScript(() => {
    localStorage.setItem('rv:autoGate', 'false');
    localStorage.setItem('rv:aiNs', 'false');
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`${BASE}/r/efekt`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  return page;
}

/** B'nin A'dan duyduğu sesin baskın frekansı (Hz); birkaç ölçümün en güçlüsü */
function peakFreq(page, fromName) {
  return page.evaluate(async (fromName) => {
    const S = window.__rv;
    const p = [...S.peers.values()].find((x) => x.name === fromName);
    const stream = p.audio.srcObject;
    const src = S.ctx.createMediaStreamSource(stream);
    const an = S.ctx.createAnalyser();
    an.fftSize = 16384;
    src.connect(an);
    const data = new Float32Array(an.frequencyBinCount);
    let best = { db: -Infinity, f: 0 };
    for (let k = 0; k < 30; k++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatFrequencyData(data);
      for (let i = 5; i < data.length; i++) if (data[i] > best.db) best = { db: data[i], f: (i * S.ctx.sampleRate) / an.fftSize };
    }
    src.disconnect();
    return best;
  }, fromName);
}

test('efektler ve ses tahtası', { timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanki-sounds-'));
  // Sunucuya sonradan eklenen ses: 3 sn ton, çalarken robot efekti
  fs.writeFileSync(path.join(dir, 'bip.wav'), wav(3, 330));
  fs.writeFileSync(path.join(dir, 'sounds.json'), JSON.stringify([{ file: 'bip.wav', name: 'Bip', emoji: '🤖', effect: 'robot' }, { file: 'yok.mp3', name: 'Eksik' }]));
  const srv = createServer({ quiet: true, env: { SOUNDS_DIR: dir } });
  await new Promise((r) => srv.server.listen(PORT, r));
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  t.after(async () => {
    await browser.close();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const A = await join(browser, 'Ahri');
  const B = await join(browser, 'Bora');
  for (const p of [A, B]) {
    await p.waitForFunction(() => [...window.__rv.peers.values()].some((x) => x.pc && x.pc.connectionState === 'connected' && x.audio), null, { timeout: 25000 });
  }
  const aOnB = B.locator('.participant', { has: B.locator('.name', { hasText: 'Ahri' }) });

  await t.test('sekmeler: efektler açılır, müzik bölümü yaşamaya devam eder', async () => {
    await A.click('#tab-fx');
    assert.equal(await A.isVisible('#mp-fx'), true);
    assert.equal(await A.isVisible('#mp-music'), false);
    assert.equal(await A.locator('#mp-music').count(), 1, 'müzik bölümü DOM\'da kalmalı (oynatıcı durmasın)');
    assert.equal(await A.locator('.fx-chip').count(), 9);
    assert.equal(await A.locator('.sb-btn').count(), 8, '6 hazır + Hamam böceği + sunucuya eklenen');
  });

  await t.test('kalın ses: karşı tarafın duyduğu ton ~0,75 kat düşer', async () => {
    const before = await peakFreq(B, 'Ahri');
    await A.click('.fx-chip[data-id=kalin]');
    await A.waitForFunction(() => window.__rv.viaGraph && window.__rv.fxChain);
    await aOnB.locator('.i-fx').waitFor({ state: 'visible' });
    assert.equal(await aOnB.locator('.i-fx').getAttribute('title'), 'Ses efekti: Kalın');
    await new Promise((r) => setTimeout(r, 500));
    const after = await peakFreq(B, 'Ahri');
    const ratio = after.f / before.f;
    t.diagnostic(`ton: ${before.f.toFixed(0)} Hz → ${after.f.toFixed(0)} Hz (oran ${ratio.toFixed(3)}, beklenen 0.749)`);
    assert.ok(Math.abs(ratio - Math.pow(2, -5 / 12)) < 0.04, 'ton beklenen oranda düşmeli: ' + ratio);
    // Ton kaydırıcısı: +5 (ince)
    await A.evaluate(() => {
      const r = document.querySelector('#fx-pitch');
      r.value = '5';
      r.dispatchEvent(new Event('input'));
    });
    await new Promise((r) => setTimeout(r, 500));
    const up = await peakFreq(B, 'Ahri');
    t.diagnostic(`ton +5: ${up.f.toFixed(0)} Hz (oran ${(up.f / before.f).toFixed(3)}, beklenen 1.335)`);
    assert.ok(Math.abs(up.f / before.f - Math.pow(2, 5 / 12)) < 0.06);
    assert.equal(await A.textContent('#fx-cur'), 'Özel');
    // Diğer efektler hatasız kurulur
    for (const id of ['robot', 'telsiz', 'magara', 'iblis']) {
      await A.click(`.fx-chip[data-id=${id}]`);
      await A.waitForFunction(() => window.__rv.fxChain);
    }
    await A.click('.fx-chip[data-id=off]');
    await aOnB.locator('.i-fx').waitFor({ state: 'hidden' });
    const off = await peakFreq(B, 'Ahri');
    assert.ok(Math.abs(off.f / before.f - 1) < 0.03, 'kapatınca ton eski haline dönmeli');
  });

  await t.test('hazır ses herkeste çalar', async () => {
    await B.click('#tab-fx');
    await A.click('.sb-btn[data-id=korna]');
    for (const p of [A, B]) await p.waitForSelector('.sb-btn[data-id=korna].playing', { timeout: 5000 });
    assert.match(await B.textContent('.sb-btn[data-id=korna] .sb-meta'), /Ahri/);
    await B.waitForSelector('.sb-btn[data-id=korna]:not(.playing)', { timeout: 5000 });
  });

  await t.test('sabit sesler: uygulamadaki Hamam böceği ve sunucuya eklenen ses; ekleme/silme yok', async () => {
    const hamam = B.locator('.sb-btn[data-id=hamam-bocegi]');
    await hamam.waitFor();
    assert.match(await hamam.textContent(), /🪳.*Hamam böceği/);
    assert.match(await hamam.getAttribute('title'), /çalarken sesin: Kalın/);
    assert.match(await B.locator('.sb-btn[data-id=bip]').getAttribute('title'), /Robot/);
    assert.equal(await B.locator('.sb-btn', { hasText: 'Eksik' }).count(), 0, 'dosyası olmayan girdi atlanmalı');
    assert.equal(await B.locator('.sb-btn').count(), 8);
    assert.equal(await A.locator('#sb-add, .sb-del, #sb-form').count(), 0, 'arayüzde ekleme/silme olmamalı');
    const token = await A.evaluate(() => window.__rv.streamToken);
    assert.notEqual((await fetch(`${BASE}/sound?k=${token}&name=x&duration=2`, { method: 'POST', body: wav(1, 440) })).status, 200);
    assert.equal((await fetch(`${BASE}/sounds/hamam-bocegi`)).status, 403, 'anahtarsız indirilemez');
    const r = await fetch(`${BASE}/sounds/hamam-bocegi?k=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  });

  await t.test('Hamam böceği: müzik herkeste çalar, çalanın sesi kalınlaşır; durdurunca ikisi de biter', async () => {
    await B.waitForFunction(() => window.__rv.sb.buffers.has('hamam-bocegi'), null, { timeout: 15000 });
    await A.click('.sb-btn[data-id=hamam-bocegi]');
    for (const p of [A, B]) await p.waitForSelector('.sb-btn[data-id=hamam-bocegi].playing', { timeout: 15000 });
    await aOnB.locator('.i-fx').waitFor({ state: 'visible' });
    assert.equal(await aOnB.locator('.i-fx').getAttribute('title'), 'Ses efekti: Kalın');
    assert.match(await A.textContent('#fx-cur'), /Kalın \(ses tahtası\)/);
    assert.equal(await A.evaluate(() => window.__rv.fx.temp.preset), 'kalin');
    // Başkası durdurur
    await B.click('#sb-stop');
    await aOnB.locator('.i-fx').waitFor({ state: 'hidden', timeout: 3000 });
    await A.waitForFunction(() => window.__rv.sb.playing.size === 0 && window.__rv.fx.temp === null);
  });

  await t.test('efektli ses kendiliğinden bitince efekt de biter', async () => {
    await B.click('.sb-btn[data-id=bip]');
    const bOnA = A.locator('.participant', { has: A.locator('.name', { hasText: 'Bora' }) });
    await bOnA.locator('.i-fx').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await bOnA.locator('.i-fx').getAttribute('title'), 'Ses efekti: Robot');
    await bOnA.locator('.i-fx').waitFor({ state: 'hidden', timeout: 8000 });
    assert.equal(await B.evaluate(() => window.__rv.fx.temp), null);
  });

  await t.test('konsolda hata yok', () => {
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  });
});
