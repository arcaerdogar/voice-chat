'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const { createServer } = require('../server');

const USER = 'yonetici';
const PASS = 'cok-gizli-sifre-123';

function start(env) {
  const srv = createServer({ quiet: true, graceMs: 300, env: { ...env } });
  return new Promise((r) => srv.server.listen(0, '127.0.0.1', () => r(Object.assign(srv, { base: `http://127.0.0.1:${srv.server.address().port}` }))));
}

/** WebSocket istemcisi (isteğe bağlı başlıklarla) */
function client(srv, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.base.replace('http', 'ws') + '/ws', { headers });
    const c = { ws, msgs: [], waiters: [], closeCode: null };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const w = c.waiters.find((x) => x.pred(m));
      if (w) {
        c.waiters.splice(c.waiters.indexOf(w), 1);
        w.resolve(m);
      } else c.msgs.push(m);
    });
    ws.on('close', (code) => (c.closeCode = code));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 3000) => {
      const i = c.msgs.findIndex(pred);
      if (i >= 0) return Promise.resolve(c.msgs.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('zaman aşımı: ' + pred.toString().slice(0, 120))), ms);
        c.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), res(m)) });
      });
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

async function join(srv, room, id, name, headers) {
  const c = await client(srv, headers);
  c.send({ t: 'join', room, id, name });
  await c.wait((m) => m.t === 'welcome');
  return c;
}

/** Panel API istemcisi (çerezi hatırlar) */
function adminApi(srv, origin = srv.base) {
  let cookie = '';
  return {
    async call(path, body, extra = {}) {
      const res = await fetch(srv.base + '/admin/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, data, setCookie: set };
    },
    get cookie() {
      return cookie;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Yönetici: şifre tanımsız ya da kısa ise panel tamamen kapalı', async () => {
  for (const env of [{}, { ADMIN_USER: 'a', ADMIN_PASSWORD: 'kisa' }]) {
    const srv = await start(env);
    try {
      assert.equal((await fetch(srv.base + '/admin')).status, 404);
      assert.equal((await fetch(srv.base + '/admin/api/state')).status, 404);
    } finally {
      await srv.close();
    }
  }
});

test('Yönetici: giriş, oturum, kaba kuvvet kilidi, CSRF ve çıkış', async () => {
  const srv = await start({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS });
  try {
    const page = await fetch(srv.base + '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    assert.match(await page.text(), /Yönetim paneli/);
    // Uygulamada panele link yok
    assert.doesNotMatch(await (await fetch(srv.base + '/')).text(), /\/admin/);
    assert.doesNotMatch(await (await fetch(srv.base + '/app.js')).text(), /\/admin/);

    const a = adminApi(srv);
    assert.equal((await a.call('state')).status, 401, 'giriş yapmadan veri yok');
    // Başka siteden giriş denemesi (CSRF)
    assert.equal((await adminApi(srv, 'https://kotu.example').call('login', { user: USER, pass: PASS })).status, 403);

    // Yanlış şifre
    const bad = await a.call('login', { user: USER, pass: 'yanlis' });
    assert.equal(bad.status, 401);
    assert.equal(bad.setCookie, null);

    // Doğru giriş: güvenli çerez
    const ok = await a.call('login', { user: USER, pass: PASS });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie, /HttpOnly/);
    assert.match(ok.setCookie, /SameSite=Strict/);
    assert.match(ok.setCookie, /Path=\/admin/);
    const st = await a.call('state');
    assert.equal(st.status, 200);
    assert.equal(st.data.user, USER);
    assert.ok(st.data.events.some((e) => /Yönetici girişi/.test(e.text)));

    // İşlem isteği: Origin yoksa ya da başka siteyse reddedilir
    const csrf = await fetch(srv.base + '/admin/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie, Origin: 'https://kotu.example' },
      body: JSON.stringify({ action: 'announce', text: 'x' }),
    });
    assert.equal(csrf.status, 403);

    // Çıkış: oturum geçersiz olur
    const old = a.cookie;
    await a.call('logout', {});
    assert.equal((await fetch(srv.base + '/admin/api/state', { headers: { Cookie: old } })).status, 401);

    // Kaba kuvvet: 5 yanlış denemeden sonra doğru şifre de 15 dk reddedilir
    const b = adminApi(srv);
    for (let i = 0; i < 5; i++) await b.call('login', { user: USER, pass: 'yanlis' + i });
    const locked = await b.call('login', { user: USER, pass: PASS });
    assert.equal(locked.status, 429);
    assert.match(locked.data.error, /dk sonra/);
  } finally {
    await srv.close();
  }
});

test('Yönetici: kanallar, IP/ülke/cihaz, bağlantı kalitesi ve tüm işlemler', async () => {
  const srv = await start({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS });
  try {
    // Cloudflare + nginx arkasındaki gibi: yerel bağlantı + CF başlıkları
    const cf = { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'TR', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
    const A = await join(srv, 'oda', 'aaaaaaaaaaaa', 'Ali', cf);
    const B = await join(srv, 'oda', 'bbbbbbbbbbbb', 'Berk', { 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1' });
    const C = await join(srv, 'diger', 'cccccccccccc', 'Can');
    await A.wait((m) => m.t === 'peer-joined');
    A.send({ t: 'chat', text: 'selam' });
    A.send({ t: 'stats', peers: [{ id: 'bbbbbbbbbbbb', state: 'connected', rtt: 23, relay: true }] });
    await sleep(100);

    const a = adminApi(srv);
    await a.call('login', { user: USER, pass: PASS });
    let st = (await a.call('state')).data;
    assert.equal(st.server.rooms, 2);
    assert.equal(st.server.members, 3);
    const oda = st.rooms.find((r) => r.name === 'oda');
    const ali = oda.members.find((m) => m.name === 'Ali');
    assert.equal(ali.ip, '203.0.113.7');
    assert.equal(ali.country, 'TR');
    assert.deepEqual(ali.device, { browser: 'Chrome 130', os: 'Windows 10/11', mobile: false });
    assert.equal(ali.chatCount, 1);
    assert.deepEqual(ali.peers, [{ id: 'bbbbbbbbbbbb', state: 'connected', rtt: 23, relay: true, name: 'Berk' }]);
    const berk = oda.members.find((m) => m.name === 'Berk');
    assert.equal(berk.device.os, 'iOS');
    assert.equal(berk.device.mobile, true);

    // Susturma
    assert.equal((await a.call('action', { action: 'mute', room: 'oda', id: 'aaaaaaaaaaaa' })).status, 200);
    await A.wait((m) => m.t === 'admin-mute');
    assert.equal((await B.wait((m) => m.t === 'peer-state' && m.id === 'aaaaaaaaaaaa')).muted, true);

    // Duyuru (tek kanal)
    await a.call('action', { action: 'announce', room: 'oda', text: 'Sunucu 5 dk sonra yeniden başlayacak' });
    const ann = await B.wait((m) => m.t === 'chat' && m.admin);
    assert.equal(ann.text, 'Sunucu 5 dk sonra yeniden başlayacak');
    await sleep(50);
    assert.ok(!C.msgs.some((m) => m.t === 'chat' && m.admin), 'başka kanala gitmemeli');

    // Kilit: yeni kişi giremez, içerideki geri bağlanabilir
    await a.call('action', { action: 'lock', room: 'oda', locked: true });
    const D = await client(srv);
    D.send({ t: 'join', room: 'oda', id: 'dddddddddddd', name: 'Deniz' });
    assert.equal((await D.wait((m) => m.t === 'error')).code, 'room-locked');
    B.ws.terminate();
    const B2 = await join(srv, 'oda', 'bbbbbbbbbbbb', 'Berk');
    await a.call('action', { action: 'lock', room: 'oda', locked: false });
    D.send({ t: 'join', room: 'oda', id: 'dddddddddddd', name: 'Deniz' });
    await D.wait((m) => m.t === 'welcome');

    // Atma: sebep mesajı + 4001 ile kapanır, diğerleri hemen "ayrıldı" görür
    await a.call('action', { action: 'kick', room: 'oda', id: 'dddddddddddd' });
    assert.match((await D.wait((m) => m.t === 'kicked')).message, /çıkarıldın/);
    await sleep(150);
    assert.equal(D.closeCode, 4001);
    await A.wait((m) => m.t === 'peer-left' && m.id === 'dddddddddddd');

    // Yasaklama: IP'deki herkes çıkar, tekrar giremez; kaldırınca girer
    const ban = await a.call('action', { action: 'ban', room: 'oda', id: 'aaaaaaaaaaaa', minutes: 60, reason: 'test' });
    assert.equal(ban.data.result.kicked, 1);
    await A.wait((m) => m.t === 'kicked');
    const A2 = await client(srv, cf);
    A2.send({ t: 'join', room: 'oda', id: 'aaaaaaaaaaaa', name: 'Ali' });
    assert.equal((await A2.wait((m) => m.t === 'error')).code, 'banned');
    st = (await a.call('state')).data;
    assert.equal(st.bans.length, 1);
    assert.equal(st.bans[0].ip, '203.0.113.7');
    assert.equal(st.bans[0].reason, 'test');
    await a.call('action', { action: 'unban', ip: '203.0.113.7' });
    await join(srv, 'oda', 'aaaaaaaaaaaa', 'Ali', cf);

    // Kanalı kapat: herkes çıkar
    const close = await a.call('action', { action: 'close-room', room: 'oda' });
    assert.ok(close.data.result.kicked >= 2);
    await B2.wait((m) => m.t === 'kicked');
    st = (await a.call('state')).data;
    assert.ok(!st.rooms.some((r) => r.name === 'oda'));
    assert.ok(st.events.some((e) => e.type === 'admin' && /kapatıldı/.test(e.text)));

    // Geçersiz işlemler anlaşılır hata döner
    assert.equal((await a.call('action', { action: 'kick', room: 'yok', id: 'x' })).status, 400);
    assert.equal((await a.call('action', { action: 'saçma' })).status, 400);
    for (const c of [A, C, D, A2]) c.ws.close();
  } finally {
    await srv.close();
  }
});

test('Yönetici: dışarıdan gelen sahte IP başlıkları kabul edilmez', async () => {
  // Bağlantı yerel ağdan gelmiyormuş gibi (TRUST_PROXY=none): başlık yok sayılır, soket adresi kullanılır
  const srv = await start({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS, TRUST_PROXY: 'none' });
  try {
    const X = await join(srv, 'oda', 'xxxxxxxxxxxx', 'X', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' });
    const a = adminApi(srv);
    await a.call('login', { user: USER, pass: PASS });
    const ip = (await a.call('state')).data.rooms[0].members[0].ip;
    assert.equal(ip, '127.0.0.1');
    X.ws.close();
  } finally {
    await srv.close();
  }
});

test('Yönetici paneli arayüzü: giriş, canlı liste, atma (atılan kişinin ekranı)', { timeout: 120000 }, async () => {
  const srv = await start({ ADMIN_USER: USER, ADMIN_PASSWORD: PASS });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const userCtx = await browser.newContext({ permissions: ['microphone'] });
    const U = await userCtx.newPage();
    await U.goto(srv.base + '/r/panel-test');
    await U.fill('#name-input', 'Deniz');
    await U.click('#join-btn');
    await U.waitForSelector('#room-view:not([hidden])');

    const P = await (await browser.newContext()).newPage();
    await P.goto(srv.base + '/admin');
    await P.fill('#l-user', USER);
    await P.fill('#l-pass', 'yanlis');
    await P.click('#login-form button[type=submit]');
    await P.waitForSelector('#login-error:not([hidden])');
    await P.fill('#l-pass', PASS);
    await P.click('#login-form button[type=submit]');
    await P.waitForSelector('#app-view:not([hidden])');
    await P.waitForSelector('.room[data-room="panel-test"] tr[data-id]');
    assert.match(await P.textContent('.room[data-room="panel-test"]'), /Deniz/);
    assert.match(await P.textContent('.room[data-room="panel-test"]'), /127\.0\.0\.1/);

    // Kullanıcı ismine HTML yazsa bile panelde çalışmaz (düz metin)
    const evil = await client(srv);
    evil.send({ t: 'join', room: 'panel-test', id: 'eeeeeeeeeeee', name: '<img src=x onerror=alert(1)>' });
    await evil.wait((m) => m.t === 'welcome');
    await P.waitForFunction(() => /<img src=x/.test(document.querySelector('.room[data-room="panel-test"]').textContent));
    assert.equal(await P.locator('.room img').count(), 0, 'isim HTML olarak yorumlanmamalı');
    evil.ws.close();

    // At
    P.once('dialog', (d) => d.accept());
    const row = P.locator('.room[data-room="panel-test"] tr', { hasText: 'Deniz' });
    await row.locator('button', { hasText: 'At' }).click();
    await U.waitForSelector('#join-view:not([hidden])', { timeout: 10000 });
    assert.match(await U.textContent('#join-error'), /Yönetici tarafından kanaldan çıkarıldın/);
    // Otomatik geri bağlanmaz
    await sleep(3000);
    assert.equal(await U.isVisible('#join-view'), true);
    await P.waitForFunction(() => !document.querySelector('.room[data-room="panel-test"] tr[data-id]') || ![...document.querySelectorAll('tr')].some((t) => /Deniz/.test(t.textContent)));
  } finally {
    await browser.close();
    await srv.close();
  }
});
