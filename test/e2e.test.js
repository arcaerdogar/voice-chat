'use strict';
// Uçtan uca test: gerçek Chrome örnekleri, sahte mikrofonla aynı odaya girer.
// Çalıştırma: npm run test:e2e   (Chrome veya Edge kurulu olmalı)
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const ROOM = 'e2e-oda';

function startServer() {
  const srv = createServer({ quiet: true, graceMs: 5000, env: {} });
  return new Promise((resolve) => srv.server.listen(PORT, () => resolve(srv)));
}

async function launch() {
  const args = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch (err) {
      if (channel === undefined) throw err;
    }
  }
}

async function join(browser, name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  // Bu testler bağlantıyı sınar; sahte mikrofonun bip sesi otomatik eşiği açıp kapatmasın.
  await ctx.addInitScript(() => localStorage.setItem('rv:autoGate', 'false'));
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') page.errors.push(m.text());
  });
  await page.goto(`${BASE}/r/${ROOM}`);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  // İlk Chrome açılışı yavaş olabilir
  await page.waitForSelector('#room-view:not([hidden])', { timeout: 20000 });
  page.userName = name;
  return page;
}

/** Sayfanın gördüğü eşlerin özeti */
function peers(page) {
  return page.evaluate(() =>
    [...window.__rv.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      muted: p.muted,
      online: p.online,
      state: p.pc ? p.pc.connectionState : 'none',
      sid: p.sid,
    }))
  );
}

async function waitConnected(pages, expectedPeers, timeout = 25000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = true;
    const report = [];
    for (const pg of pages) {
      const ps = await peers(pg);
      report.push(`${pg.userName}: ${ps.map((p) => `${p.name}=${p.state}`).join(', ')}`);
      if (ps.length !== expectedPeers || ps.some((p) => p.state !== 'connected')) ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error('Bağlantı kurulamadı:\n' + report.join('\n'));
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Her eşten alınan ses baytları */
function bytesIn(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const p of window.__rv.peers.values()) {
      out[p.name] = 0;
      if (!p.pc) continue;
      const stats = await p.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out[p.name] += r.bytesReceived || 0;
      });
    }
    return out;
  });
}

async function assertAudioFlowing(page) {
  const a = await bytesIn(page);
  await new Promise((r) => setTimeout(r, 1500));
  const b = await bytesIn(page);
  for (const name of Object.keys(b)) {
    assert.ok(b[name] > (a[name] || 0), `${page.userName}, ${name} kişisinden ses almıyor (${a[name]} -> ${b[name]})`);
  }
}

const pcIds = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const p of window.__rv.peers.values()) out[p.name] = p.sid;
    return out;
  });

test('uçtan uca: ses, susturma, yeniden bağlanma ve dayanıklılık', { timeout: 240000 }, async (t) => {
  let srv = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  });

  const A = await join(browser, 'Ahri');
  const B = await join(browser, 'Brand');

  await t.test('iki kişi bağlanır ve ses akar', async () => {
    await waitConnected([A, B], 1);
    await assertAudioFlowing(A);
    await assertAudioFlowing(B);
    // Konuşma göstergesi için seviye ölçülüyor mu (sahte mikrofon bip sesi üretir)
    let maxDb = -100;
    for (let i = 0; i < 30; i++) {
      const lv = await B.evaluate(() => [...window.__rv.peers.values()][0].levelDb);
      maxDb = Math.max(maxDb, lv);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(maxDb > -70, `uzak ses seviyesi çok düşük: ${maxDb} dB`);
    assert.equal(await A.textContent('#member-count'), '2 kişi');
  });

  await t.test('susturma diğerlerine yansır ve iz kapanır', async () => {
    await A.click('#mute-btn');
    await B.waitForFunction(() => [...window.__rv.peers.values()][0].muted === true);
    assert.equal(await A.evaluate(() => window.__rv.track.enabled), false);
    await A.keyboard.press('m'); // kısayol ile geri aç
    await B.waitForFunction(() => [...window.__rv.peers.values()][0].muted === false);
    assert.equal(await A.evaluate(() => window.__rv.track.enabled), true);

    await B.click('#deafen-btn');
    assert.equal(await B.evaluate(() => [...window.__rv.peers.values()][0].audio.muted), true);
    assert.equal(await B.evaluate(() => window.__rv.track.enabled), false);
    await B.click('#deafen-btn');
    assert.equal(await B.evaluate(() => [...window.__rv.peers.values()][0].audio.muted), false);
  });

  await t.test('bas-konuş ve ses eşiği', async () => {
    await A.click('#settings-btn');
    await A.check('input[name=mode][value=ptt]');
    await A.click('#settings-dialog button[value=close]');
    assert.equal(await A.evaluate(() => window.__rv.track.enabled), false, 'tuşa basılmadan mikrofon kapalı olmalı');
    await A.keyboard.down('KeyV');
    assert.equal(await A.evaluate(() => window.__rv.track.enabled), true, 'tuşa basılıyken açık olmalı');
    await A.keyboard.up('KeyV');
    assert.equal(await A.evaluate(() => window.__rv.track.enabled), false);

    await A.click('#settings-btn');
    await A.check('input[name=mode][value=vad]');
    // Eşiği en yükseğe çek: sahte mikrofonun sessiz anlarında iletim kesilmeli
    await A.evaluate(() => {
      const r = document.querySelector('#gate-range');
      r.value = '-20';
      r.dispatchEvent(new Event('input'));
    });
    await A.click('#settings-dialog button[value=close]');
    let closedSeen = false;
    for (let i = 0; i < 40 && !closedSeen; i++) {
      closedSeen = await A.evaluate(() => window.__rv.track.enabled === false);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(closedSeen, 'ses eşiği iletimi kesmeli');
    await A.evaluate(() => {
      const r = document.querySelector('#gate-range');
      r.value = '-80';
      r.dispatchEvent(new Event('input'));
    });
    await A.waitForFunction(() => window.__rv.track.enabled === true);
  });

  await t.test('kişi sesi %200 e kadar yükseltilir, sayısal gösterge güncellenir', async () => {
    // Ses seviyesi soldaki listedeki ⋯ menüsünden ayarlanır
    await B.hover('.side-member:not(:first-child)');
    await B.click('.side-member:not(:first-child) .sm-more');
    await B.waitForSelector('#member-menu:not([hidden])');
    assert.equal(await B.textContent('#member-menu .mm-title'), 'Ahri');
    const setVol = (v) =>
      B.evaluate((v) => {
        const r = document.querySelector('#member-menu .vol');
        r.value = String(v);
        r.dispatchEvent(new Event('input'));
      }, v);
    const peerState = () =>
      B.evaluate(() => {
        const p = [...window.__rv.peers.values()][0];
        return {
          boosted: p.boosted,
          gain: p.boostGain ? p.boostGain.gain.value : null,
          audioMuted: p.audio.muted,
          audioVolume: p.audio.volume,
          label: document.querySelector('#member-menu .vol-val').textContent,
          labelBoost: document.querySelector('#member-menu .vol-val').classList.contains('boost'),
          sideLabel: p.el.side.querySelector('.sm-vol').hidden ? null : p.el.side.querySelector('.sm-vol').textContent,
        };
      });

    await setVol(200);
    await new Promise((r) => setTimeout(r, 300));
    let s = await peerState();
    assert.equal(s.label, '200%');
    assert.equal(s.labelBoost, true);
    assert.equal(s.sideLabel, '200%', 'soldaki listede farklı ses ayarı görünmeli');
    assert.equal(s.boosted, true);
    assert.ok(Math.abs(s.gain - 2) < 0.05, 'kazanç 2 olmalı: ' + s.gain);
    assert.equal(s.audioMuted, true, '%100 üstünde ses güçlendiriciden çalmalı');

    // Ses güçlendirme zincirinden gerçekten geçiyor mu (sınırlayıcının çıkışını ölç)
    const db = await B.evaluate(async () => {
      const S = window.__rv;
      const p = [...S.peers.values()][0];
      const an = S.ctx.createAnalyser();
      an.fftSize = 2048;
      p.boostLimiter.connect(an);
      const buf = new Float32Array(an.fftSize);
      let max = -200;
      for (let i = 0; i < 30; i++) {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        max = Math.max(max, 10 * Math.log10(sum / buf.length + 1e-12));
        await new Promise((r) => setTimeout(r, 100));
      }
      p.boostLimiter.disconnect(an);
      return max;
    });
    assert.ok(db > -60, 'güçlendirilmiş ses duyulmalı: ' + db.toFixed(1) + ' dB');

    // Kulaklık kapatma güçlendirilmiş sesi de susturur
    await B.click('#deafen-btn');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await peerState()).gain < 0.01);
    await B.click('#deafen-btn');
    // Menünün dışına tıklamak (kulaklık düğmesi) menüyü kapatır; tekrar aç
    assert.equal(await B.isHidden('#member-menu'), true);
    await B.hover('.side-member:not(:first-child)');
    await B.click('.side-member:not(:first-child) .sm-more');

    // %50: normal yol, güçlendirici sessiz
    await setVol(50);
    await new Promise((r) => setTimeout(r, 300));
    s = await peerState();
    assert.equal(s.label, '50%');
    assert.equal(s.labelBoost, false);
    assert.equal(s.boosted, false);
    assert.equal(s.audioMuted, false);
    assert.equal(s.audioVolume, 0.5);
    assert.ok(s.gain < 0.01);
    await setVol(100);
    assert.equal((await peerState()).sideLabel, null, '%100 iken etiket gizli');
    // Bende sustur menüden
    await B.click('#member-menu .local-mute');
    assert.equal(await B.evaluate(() => [...window.__rv.peers.values()][0].audio.muted), true);
    assert.equal((await peerState()).sideLabel, 'susturuldu');
    await B.click('#member-menu .local-mute');
    assert.equal(await B.evaluate(() => [...window.__rv.peers.values()][0].audio.muted), false);
    await B.keyboard.press('Escape');
    assert.equal(await B.isHidden('#member-menu'), true);
  });

  await t.test('sohbet mesajı iletilir', async () => {
    await A.fill('#chat-input', 'drake 30 sn');
    await A.press('#chat-input', 'Enter');
    await B.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('drake 30 sn'));
  });

  const C = await join(browser, 'Caitlyn');

  await t.test('üçüncü kişi katılır, herkes herkese bağlanır', async () => {
    await waitConnected([A, B, C], 2);
    await assertAudioFlowing(C);
    await assertAudioFlowing(A);
  });

  await t.test('WebSocket koparsa ses kesilmeden yeniden bağlanır', async () => {
    const before = await pcIds(A);
    await A.evaluate(() => window.__rv.ws.close());
    await A.waitForFunction(() => window.__rv.ws && window.__rv.ws.readyState === 1 && document.querySelector('#conn-status').textContent.includes('Bağlı'), null, { timeout: 15000 });
    await waitConnected([A, B, C], 2);
    assert.deepEqual(await pcIds(A), before, 'P2P bağlantılar yeniden kurulmamalıydı');
    await assertAudioFlowing(A);
  });

  await t.test('sunucu çöküp yeniden başlasa bile ses devam eder ve oda toparlanır', async () => {
    const before = await pcIds(B);
    await srv.close();
    await new Promise((r) => setTimeout(r, 1500));
    // Sunucu kapalıyken de ses akmaya devam etmeli
    await assertAudioFlowing(B);
    srv = await startServer();
    for (const pg of [A, B, C]) {
      await pg.waitForFunction(() => window.__rv.ws && window.__rv.ws.readyState === 1 && document.querySelector('#conn-status').textContent.includes('Bağlı'), null, { timeout: 20000 });
    }
    await waitConnected([A, B, C], 2);
    assert.deepEqual(await pcIds(B), before, 'P2P bağlantılar korunmalıydı');
    // Sunucu herkesi tekrar tanıyor mu
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(srv.rooms.get(ROOM).size, 3);
    for (const pg of [A, B, C]) {
      const ps = await peers(pg);
      assert.ok(ps.every((p) => p.online), `${pg.userName} herkesi çevrimiçi görmeli`);
    }
  });

  await t.test('P2P bağlantı koparsa otomatik yeniden kurulur', async () => {
    const idA = await A.evaluate(() => window.__rv.id);
    // B tarafında A ile olan bağlantıyı zorla kapat
    await B.evaluate((id) => window.__rv.peers.get(id).pc.close(), idA);
    await waitConnected([A, B, C], 2, 30000);
    await assertAudioFlowing(B);
    await assertAudioFlowing(A);
  });

  await t.test('ayrılan kişi diğerlerinden hemen düşer', async () => {
    await C.click('#leave-btn');
    await A.waitForFunction(() => window.__rv.peers.size === 1, null, { timeout: 5000 });
    await B.waitForFunction(() => window.__rv.peers.size === 1, null, { timeout: 5000 });
    assert.equal(await C.isVisible('#join-view'), true);
    // Aynı sayfadan tekrar katılabilmeli
    await C.click('#join-btn');
    await C.waitForSelector('#room-view:not([hidden])');
    await waitConnected([A, B, C], 2);
  });

  await t.test('sayfa yenilenince temiz şekilde geri katılır', async () => {
    await B.reload();
    await B.click('#join-btn');
    await B.waitForSelector('#room-view:not([hidden])');
    await waitConnected([A, B, C], 2);
    await assertAudioFlowing(B);
    // eski B kaydı kalmamalı
    assert.equal((await peers(A)).length, 2);
  });

  await t.test('konsolda hata yok', async () => {
    for (const pg of [A, B, C]) {
      const errs = pg.errors.filter((e) => !/ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
      assert.deepEqual(errs, [], `${pg.userName} sayfasında hata`);
    }
  });
});
