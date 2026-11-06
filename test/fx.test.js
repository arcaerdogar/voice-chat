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
  const srv = createServer({ quiet: true, env: { SOUNDS_DIR: dir, SOUND_MAX_MB: '1' } });
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
    assert.equal(await A.locator('.sb-btn').count(), 6, 'hazır sesler');
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

  let soundId;
  await t.test('ses eklenir (efektli), herkesin ses tahtasında görünür', async () => {
    await A.click('#sb-add');
    await A.setInputFiles('#sb-file', { name: 'hamam-bocegi.wav', mimeType: 'audio/wav', buffer: wav(3, 330) });
    assert.equal(await A.inputValue('#sb-name'), 'hamam-bocegi');
    await A.fill('#sb-name', 'Hamam böceği');
    await A.fill('#sb-emoji', '🪳');
    await A.selectOption('#sb-effect', 'kalin');
    await A.click('#sb-save');
    const btn = B.locator('.sb-btn', { hasText: 'Hamam böceği' });
    await btn.waitFor({ timeout: 5000 });
    assert.match(await btn.textContent(), /🪳/);
    assert.match(await btn.getAttribute('title'), /çalarken sesin: Kalın/);
    soundId = await btn.getAttribute('data-id');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sounds.json'), 'utf8'))[0].effect, 'kalin');
  });

  await t.test('ses + efekt: çalan kişinin sesi ses bitene kadar kalınlaşır', async () => {
    await A.click(`.sb-btn[data-id="${soundId}"]`);
    // Herkeste çalar; Ahri'nin kutusunda efekt görünür
    for (const p of [A, B]) await p.waitForSelector(`.sb-btn[data-id="${soundId}"].playing`, { timeout: 8000 });
    await aOnB.locator('.i-fx').waitFor({ state: 'visible' });
    assert.equal(await aOnB.locator('.i-fx').getAttribute('title'), 'Ses efekti: Kalın');
    assert.match(await A.textContent('#fx-cur'), /Kalın \(ses tahtası\)/);
    // Bitince normale döner
    await aOnB.locator('.i-fx').waitFor({ state: 'hidden', timeout: 8000 });
    assert.equal(await A.evaluate(() => window.__rv.fx.temp), null);
  });

  await t.test('başkası durdurunca ses ve efekt biter', async () => {
    await A.click(`.sb-btn[data-id="${soundId}"]`);
    await aOnB.locator('.i-fx').waitFor({ state: 'visible' });
    await B.click('#sb-stop');
    await aOnB.locator('.i-fx').waitFor({ state: 'hidden', timeout: 3000 });
    await A.waitForFunction(() => window.__rv.sb.playing.size === 0);
  });

  await t.test('silinir; güvenlik kontrolleri', async () => {
    const token = await A.evaluate(() => window.__rv.streamToken);
    // Anahtarsız indirme yok; ses olmayan dosya reddedilir; sınır uygulanır
    assert.equal((await fetch(`${BASE}/sounds/${soundId}`)).status, 403);
    assert.equal((await fetch(`${BASE}/sounds/${soundId}?k=${token}`)).status, 200);
    let r = await fetch(`${BASE}/sound?k=${token}&name=x&duration=2`, { method: 'POST', body: '<html>merhaba</html>' });
    assert.equal(r.status, 415);
    r = await fetch(`${BASE}/sound?k=${token}&name=x&duration=2`, { method: 'POST', body: Buffer.alloc(1.5 * 1048576) });
    assert.equal(r.status, 413);
    r = await fetch(`${BASE}/sound?k=yanlis&name=x&duration=2`, { method: 'POST', body: wav(1, 440) });
    assert.equal(r.status, 403);
    // Sil
    A.once('dialog', (d) => d.accept());
    await A.locator(`.sb-btn[data-id="${soundId}"]`).hover();
    await A.click(`.sb-btn[data-id="${soundId}"] .sb-del`);
    await B.locator(`.sb-btn[data-id="${soundId}"]`).waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 0);
  });

  await t.test('konsolda hata yok', () => {
    for (const p of [A, B]) assert.deepEqual(p.errors, []);
  });
});
