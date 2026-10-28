'use strict';
// Ekran paylaşımı uçtan uca testi: üç Chrome. Ekran seçme penceresi otomatik testte açılamadığı için
// getDisplayMedia, hareketli bir tuval + ses tonu döndüren sahte bir kaynakla değiştirilir.
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3969;

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    localStorage.setItem('rv:autoGate', 'false');
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 720;
      const g = c.getContext('2d');
      let f = 0;
      setInterval(() => {
        f++;
        g.fillStyle = `hsl(${(f * 7) % 360} 70% 45%)`;
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#fff';
        g.font = 'bold 96px sans-serif';
        g.fillText('EKRAN ' + f, 80, 360);
      }, 33);
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/r/ekran`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])');
  page.userName = name;
  return page;
}

/** Bu sayfanın, adı verilen kişiden aldığı baytlar: mikrofon, ekran görüntüsü, ekran sesi */
function received(page, fromName) {
  return page.evaluate(async (fromName) => {
    const p = [...window.__rv.peers.values()].find((x) => x.name === fromName);
    const out = { mic: 0, video: 0, screenAudio: 0 };
    if (!p || !p.pc) return out;
    const tx = p.pc.getTransceivers();
    const ids = [tx[0], tx[1], tx[2]].map((t) => t && t.receiver.track.id);
    const stats = await p.pc.getStats();
    stats.forEach((r) => {
      if (r.type !== 'inbound-rtp') return;
      const i = ids.indexOf(r.trackIdentifier);
      if (i === 0) out.mic += r.bytesReceived;
      if (i === 1) out.video += r.bytesReceived;
      if (i === 2) out.screenAudio += r.bytesReceived;
    });
    return out;
  }, fromName);
}

async function waitConnected(pages, n) {
  for (const p of pages) {
    await p.waitForFunction(
      (n) => {
        const ps = [...window.__rv.peers.values()];
        return ps.length === n && ps.every((x) => x.pc && x.pc.connectionState === 'connected');
      },
      n,
      { timeout: 25000 }
    );
  }
}

/** Paylaşanın, adı verilen kişiye gönderdiği ekran görüntüsü baytları (gerçekte ne gittiğinin kesin ölçüsü) */
function sentVideo(page, toName) {
  return page.evaluate(async (toName) => {
    const p = [...window.__rv.peers.values()].find((x) => x.name === toName);
    const tx = p && p.pc && p.pc.getTransceivers()[1];
    if (!tx) return 0;
    let n = 0;
    (await tx.sender.getStats()).forEach((r) => {
      if (r.type === 'outbound-rtp') n += r.bytesSent;
    });
    return n;
  }, toName);
}
const sentDelta = async (page, to, ms = 2000) => {
  const a = await sentVideo(page, to);
  await new Promise((r) => setTimeout(r, ms));
  return (await sentVideo(page, to)) - a;
};

const delta = async (page, from, ms = 2000) => {
  const a = await received(page, from);
  await new Promise((r) => setTimeout(r, ms));
  const b = await received(page, from);
  return { mic: b.mic - a.mic, video: b.video - a.video, screenAudio: b.screenAudio - a.screenAudio };
};

test('Ekran paylaşımı: sadece izleyene gider, ses kesilmez, yeniden bağlanınca devam eder', { timeout: 180000 }, async (t) => {
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

  const A = await join(browser, 'Arca');
  const B = await join(browser, 'Deniz');
  const C = await join(browser, 'Elif');
  await waitConnected([A, B, C], 2);
  assert.equal(await A.isVisible('#share-btn'), true);

  // Arca paylaşır
  await A.click('#share-btn');
  await A.waitForFunction(() => !!window.__rv.screen);
  assert.match(await A.textContent('#share-btn'), /Durdur/);
  for (const p of [B, C]) {
    await p.waitForSelector('.screen-tile .watch-btn', { state: 'visible', timeout: 10000 });
    assert.match(await p.textContent('.screen-tile .screen-msg'), /Arca ekranını paylaşıyor/);
    await p.waitForSelector('.side-member.live');
  }
  assert.match(await A.textContent('.screen-tile.self .screen-name'), /henüz izleyen yok/);

  // Henüz kimse izlemiyor: paylaşan kimseye görüntü göndermez
  for (const name of ['Deniz', 'Elif']) assert.equal(await sentDelta(A, name), 0, 'izlemeyene görüntü gitmemeli');

  // Deniz izler
  await B.click('.screen-tile .watch-btn');
  await B.waitForFunction(() => {
    const v = document.querySelector('.screen-tile.watching video');
    return v && v.videoWidth > 0 && v.currentTime > 0.5;
  }, null, { timeout: 20000 });
  const dB = await delta(B, 'Arca');
  const dC = await delta(C, 'Arca');
  t.diagnostic(`izleyen: görüntü ${((dB.video * 8) / 2 / 1000).toFixed(0)} kbit/sn, yayın sesi ${((dB.screenAudio * 8) / 2 / 1000).toFixed(0)} kbit/sn; izlemeyen: ${dC.video} bayt`);
  assert.ok(dB.video > 50000, 'izleyene görüntü akmalı');
  assert.ok(dB.screenAudio > 2000, 'izleyene yayın sesi akmalı');
  assert.ok(dC.video < 5000, 'izlemeyene görüntü gitmemeli');
  assert.equal(await sentDelta(A, 'Elif'), 0, 'paylaşan, izlemeyene hiç görüntü göndermemeli');
  assert.ok(dB.mic > 1000, 'paylaşım sırasında sesli sohbet sürmeli');
  await A.waitForFunction(() => /1 kişi izliyor/.test(document.querySelector('.screen-tile.self .screen-name').textContent));
  // WebRTC düşük bant genişliğiyle başlayıp birkaç saniyede yükseltir; çözünürlüğün artmasını bekle
  const t0 = Date.now();
  await B.waitForFunction(() => document.querySelector('.screen-tile.watching video').videoWidth >= 1280, null, { timeout: 30000 });
  t.diagnostic(`1280 genişliğe ${((Date.now() - t0) / 1000).toFixed(1)} sn'de ulaştı`);
  assert.ok(await B.evaluate(() => document.querySelector('.stage').classList.contains('focus')));

  // İzlemeyi bırakınca akış durur (önce paylaşan tarafın bunu öğrendiğini doğrula, sonra ölç)
  await B.click('.screen-tile.watching .stop-btn');
  await A.waitForFunction(() => /henüz izleyen yok/.test(document.querySelector('.screen-tile.self .screen-name').textContent));
  await new Promise((r) => setTimeout(r, 500));
  const after = await sentDelta(A, 'Deniz');
  t.diagnostic(`izlemeyi bıraktıktan sonra 2 sn'de gönderilen görüntü: ${after} bayt`);
  assert.equal(after, 0, 'izlemeyi bırakınca paylaşan görüntü göndermeyi bırakmalı');

  // Elif izler; Arca ile Elif arasındaki bağlantı kopar ve yeniden kurulur → izleme kendiliğinden devam eder
  await C.click('.screen-tile .watch-btn');
  await C.waitForFunction(() => {
    const v = document.querySelector('.screen-tile.watching video');
    return v && v.videoWidth > 0;
  }, null, { timeout: 20000 });
  await C.evaluate(() => [...window.__rv.peers.values()].find((x) => x.name === 'Arca').pc.close());
  await waitConnected([C], 2);
  await C.waitForFunction(() => {
    const v = document.querySelector('.screen-tile.watching video');
    return v && v.videoWidth > 0 && !v.paused;
  }, null, { timeout: 25000 });
  assert.ok((await delta(C, 'Arca')).video > 50000, 'yeniden bağlanınca yayın devam etmeli');

  // Paylaşım durur: kartlar ve CANLI etiketi kalkar
  await A.click('#share-btn');
  for (const p of [B, C]) {
    await p.waitForFunction(() => !document.querySelector('.screen-tile') && !document.querySelector('.side-member.live'), null, { timeout: 10000 });
    assert.equal(await p.evaluate(() => document.querySelector('.stage').classList.contains('has-screens')), false);
  }
  assert.equal(await A.evaluate(() => window.__rv.screen), null);
  for (const p of [A, B, C]) assert.deepEqual(p.errors, [], p.userName + ' sayfasında hata');
});
