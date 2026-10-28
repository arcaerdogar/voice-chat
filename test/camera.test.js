'use strict';
// Kamera uçtan uca testi: üç Chrome, sahte kamera (--use-fake-device-for-media-stream).
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3966;

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(() => {
    localStorage.setItem('rv:autoGate', 'false');
    // Ekran paylaşımı için sahte kaynak (kamera ile birlikte çalıştığını görmek için)
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
      return c.captureStream(30);
    };
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/r/kamera`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  page.userName = name;
  return page;
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

/** Paylaşanın, adı verilen kişiye gönderdiği baytlar (kanal sırası: 0 mikrofon, 1 ekran, 3 kamera) */
function sent(page, toName, index) {
  return page.evaluate(
    async ({ toName, index }) => {
      const p = [...window.__rv.peers.values()].find((x) => x.name === toName);
      const tx = p && p.pc && p.pc.getTransceivers()[index];
      if (!tx) return 0;
      let n = 0;
      (await tx.sender.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp') n += r.bytesSent;
      });
      return n;
    },
    { toName, index }
  );
}
const sentDelta = async (page, to, index, ms = 2000) => {
  const a = await sent(page, to, index);
  await new Promise((r) => setTimeout(r, ms));
  return (await sent(page, to, index)) - a;
};

/** Bu sayfada, adı verilen kişinin kutusundaki kamera görüntüsü oynuyor mu */
const camPlaying = (page, name) =>
  page.waitForFunction(
    (name) => {
      const tile = [...document.querySelectorAll('.participant')].find((el) => el.querySelector('.name').textContent === name);
      const v = tile && tile.querySelector('.cam-video');
      return tile && tile.classList.contains('has-cam') && v.videoWidth > 0 && v.currentTime > 0.3 && !v.paused;
    },
    name,
    { timeout: 25000 }
  );

test('Kamera: herkese gider, ekran paylaşımıyla birlikte çalışır, yeniden bağlanınca döner', { timeout: 180000 }, async (t) => {
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

  // Kamera kapalıyken hiç görüntü gitmez
  assert.equal(await sentDelta(A, 'Deniz', 3), 0);

  // Arca kamerasını açar: kendi kutusunda ayna önizleme, diğerlerinde görüntü
  await A.click('#cam-btn');
  await A.waitForFunction(() => !!window.__rv.cam);
  assert.ok(await A.evaluate(() => document.querySelector('#cam-btn').classList.contains('on')));
  await camPlaying(A, 'Arca');
  assert.ok(await A.evaluate(() => document.querySelector('.participant.self .cam-video').classList.contains('mirror')));
  await camPlaying(B, 'Arca');
  await camPlaying(C, 'Arca');
  const rate = ((await sentDelta(A, 'Deniz', 3)) * 8) / 2 / 1000;
  t.diagnostic(`kamera: kişi başı ${rate.toFixed(0)} kbit/sn`);
  assert.ok(rate > 50 && rate < 700, 'kamera makul bant genişliğinde gitmeli: ' + rate);
  assert.ok((await sentDelta(A, 'Deniz', 0)) > 1000, 'sesli sohbet sürmeli');

  // Deniz de kamerasını açar
  await B.click('#cam-btn');
  await camPlaying(A, 'Deniz');
  await camPlaying(C, 'Deniz');

  // Kamera açıkken ekran paylaşımı: iki görüntü de doğru kanallardan akar
  await A.click('#share-btn');
  await B.waitForSelector('.screen-tile .watch-btn', { state: 'visible' });
  await B.click('.screen-tile .watch-btn');
  await B.waitForFunction(() => {
    const v = document.querySelector('.screen-tile.watching video');
    return v && v.videoWidth >= 640;
  }, null, { timeout: 25000 });
  const dims = await B.evaluate(() => {
    const tile = [...document.querySelectorAll('.participant')].find((el) => el.querySelector('.name').textContent === 'Arca');
    return { cam: tile.querySelector('.cam-video').videoWidth, screen: document.querySelector('.screen-tile.watching video').videoWidth };
  });
  t.diagnostic(`aynı anda: kamera ${dims.cam}px, ekran ${dims.screen}px genişlik`);
  assert.ok(dims.cam > 0 && dims.cam <= 640, 'kamera kendi kanalında (en fazla 640 genişlik)');
  assert.ok(dims.screen >= 640, 'ekran kendi kanalında');
  assert.equal(await sentDelta(A, 'Elif', 1), 0, 'ekranı izlemeyene ekran görüntüsü gitmemeli');
  assert.ok((await sentDelta(A, 'Elif', 3)) > 5000, 'kamera izlemeyene de gitmeli');
  await A.click('#share-btn');

  // Arca ile Elif arasındaki bağlantı kopar ve yeniden kurulur: kamera görüntüsü geri gelir
  await C.evaluate(() => [...window.__rv.peers.values()].find((x) => x.name === 'Arca').pc.close());
  await waitConnected([C], 2);
  await camPlaying(C, 'Arca');

  // Arca kamerasını kapatır: görüntü kalkar, gönderim durur
  await A.click('#cam-btn');
  for (const p of [B, C]) {
    await p.waitForFunction(() => {
      const tile = [...document.querySelectorAll('.participant')].find((el) => el.querySelector('.name').textContent === 'Arca');
      return !tile.classList.contains('has-cam');
    }, null, { timeout: 10000 });
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await sentDelta(A, 'Deniz', 3), 0, 'kamera kapanınca görüntü gitmemeli');
  assert.equal(await A.evaluate(() => window.__rv.cam), null);
  // Deniz'in kamerası hâlâ açık
  await camPlaying(A, 'Deniz');
  for (const p of [A, B, C]) assert.deepEqual(p.errors, [], p.userName + ' sayfasında hata');
});
