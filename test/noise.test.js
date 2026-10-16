'use strict';
// Yapay zekâ gürültü engelleme testi.
// Chrome'un sahte mikrofonuna önce oyun efektleri (patlama, vuruş, rüzgâr, klavye),
// sonra konuşma kaydı verilir. Karşı tarafta ölçülen ses seviyesi, gürültü engelleme
// açıkken ve kapalıyken karşılaştırılır.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3995;

/**
 * Gerçekçi oyun efekti sesi üret (30 sn, tekrar etmeyen): ortam/rüzgâr, rastgele
 * patlama-vuruş-büyü efektleri ve klavye/fare tıkırtıları. Hoparlörden mikrofona
 * giren oyun sesini temsil eder.
 */
function makeGameSfxWav(file, seconds = 30, rate = 48000) {
  const n = seconds * rate;
  const out = new Float32Array(n);
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const w = () => rnd() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.02 * (w() - lp);
    out[i] += 0.25 * lp * (0.6 + 0.4 * Math.sin((i / rate) * 0.7));
  }
  let t = 0.2;
  while (t < seconds - 1) {
    const dur = 0.05 + rnd() * 0.5;
    const amp = 0.2 + rnd() * 0.6;
    const cut = 0.05 + rnd() * 0.6;
    let y = 0;
    const s0 = Math.floor(t * rate);
    const len = Math.floor(dur * rate);
    for (let k = 0; k < len && s0 + k < n; k++) {
      y += cut * (w() - y);
      out[s0 + k] += amp * y * Math.exp((-4 * k) / len);
    }
    t += 0.15 + rnd() * 0.9;
  }
  t = 0.1;
  while (t < seconds) {
    const s0 = Math.floor(t * rate);
    for (let k = 0; k < 240 && s0 + k < n; k++) out[s0 + k] += 0.5 * w() * Math.exp(-k / 30);
    t += 0.08 + rnd() * 0.35;
  }
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * 0.8 * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

async function launchWithAudio(wav) {
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {}
  }
  return chromium.launch({ headless: true, args });
}

async function joinPage(browser, name, room, aiNs) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript((v) => localStorage.setItem('rv:aiNs', JSON.stringify(v)), aiNs);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/r/${room}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])');
  return page;
}

/** Konuşanın ses gönderdiği zaman oranı (eşik/susturma açık mı) */
async function sendingRatio(speaker, ms = 5000) {
  return speaker.evaluate(async (ms) => {
    let on = 0;
    let n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (window.__rv.transmitting) on++;
      n++;
      await new Promise((r) => setTimeout(r, 20));
    }
    return on / n;
  }, ms);
}

/** Dinleyicinin duyduğu ortalama seviye (dB), birkaç saniye boyunca */
async function heardLevel(listener, ms = 5000) {
  return listener.evaluate(async (ms) => {
    const p = [...window.__rv.peers.values()][0];
    let sum = 0;
    let n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      sum += Math.pow(10, p.levelDb / 10); // güç ortalaması
      n++;
      await new Promise((r) => setTimeout(r, 50));
    }
    return 10 * Math.log10(sum / n);
  }, ms);
}

async function measure(wav, label) {
  const browser = await launchWithAudio(wav);
  try {
    const room = 'noise-' + label;
    const speaker = await joinPage(browser, 'Konusan', room, true);
    await speaker.waitForFunction(() => window.__rv.aiActive === true, null, { timeout: 10000 });
    const listener = await joinPage(browser, 'Dinleyen', room, false);
    await listener.waitForFunction(() => {
      const p = [...window.__rv.peers.values()][0];
      return p && p.pc && p.pc.connectionState === 'connected';
    }, null, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2000));
    const [on, onTx] = await Promise.all([heardLevel(listener), sendingRatio(speaker)]);

    // Ayarlardan kapat (çalışırken değiştirme de test edilmiş olur). Otomatik eşik de
    // sadece yapay zekâ gürültü engelleme açıkken devrede olduğu için birlikte kapanır.
    await speaker.click('#settings-btn');
    await speaker.uncheck('#ai-ns-check');
    await speaker.click('#settings-dialog button[value=close]');
    await speaker.waitForFunction(() => window.__rv.aiActive === false);
    await new Promise((r) => setTimeout(r, 3000));
    const off = await heardLevel(listener);
    return { on, off, onTx };
  } finally {
    await browser.close();
  }
}

test('Yapay zekâ gürültü engelleme + otomatik eşik: oyun sesini keser, konuşmayı korur', { timeout: 240000 }, async (t) => {
  const srv = createServer({ quiet: true, env: {} });
  await new Promise((r) => srv.server.listen(PORT, r));
  t.after(() => srv.close());

  const noiseWav = path.join(os.tmpdir(), 'riftvoice-game-sfx.wav');
  makeGameSfxWav(noiseWav);
  const speechWav = path.join(__dirname, 'fixtures', 'speech.wav');

  const noise = await measure(noiseWav, 'oyun');
  const speech = await measure(speechWav, 'konusma');
  const fmt = (x) => x.toFixed(1) + ' dB';
  t.diagnostic(`oyun sesi  -> açık: ${fmt(noise.on)}, kapalı: ${fmt(noise.off)}, fark: ${fmt(noise.off - noise.on)}, gönderim oranı: %${(noise.onTx * 100).toFixed(0)}`);
  t.diagnostic(`konuşma    -> açık: ${fmt(speech.on)}, kapalı: ${fmt(speech.off)}, fark: ${fmt(speech.off - speech.on)}, gönderim oranı: %${(speech.onTx * 100).toFixed(0)}`);

  assert.ok(noise.off > -60, 'gürültü kapalıyken duyulabilmeli (test düzeneği kontrolü)');
  assert.ok(noise.onTx <= 0.05, `sadece oyun sesi varken mikrofon kapalı kalmalı (gönderim: %${(noise.onTx * 100).toFixed(0)})`);
  assert.ok(noise.off - noise.on >= 25, `oyun sesi en az 25 dB bastırılmalı (fark: ${fmt(noise.off - noise.on)})`);
  assert.ok(speech.onTx >= 0.75, `konuşurken mikrofon açık olmalı (gönderim: %${(speech.onTx * 100).toFixed(0)})`);
  assert.ok(speech.off - speech.on <= 6, `konuşma en fazla 6 dB kısılmalı (fark: ${fmt(speech.off - speech.on)})`);
  assert.ok(speech.on > noise.on + 15, 'gürültü engelleme açıkken konuşma, oyun sesinden çok daha yüksek duyulmalı');
});
