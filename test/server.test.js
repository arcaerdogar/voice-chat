'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createServer, buildIceServers } = require('../server');

function start(opts = {}) {
  const srv = createServer({ quiet: true, graceMs: 300, env: {}, ...opts });
  return new Promise((resolve) => {
    srv.server.listen(0, '127.0.0.1', () => {
      srv.port = srv.server.address().port;
      srv.base = `http://127.0.0.1:${srv.port}`;
      resolve(srv);
    });
  });
}

function client(srv) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const c = { ws, msgs: [], waiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      for (const w of [...c.waiters]) {
        if (w.pred(m)) {
          c.waiters.splice(c.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    c.send = (m) => ws.send(JSON.stringify(m));
    c.wait = (pred, ms = 2000) => {
      const found = c.msgs.find(pred);
      if (found) {
        c.msgs.splice(c.msgs.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
        c.waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            c.msgs.splice(c.msgs.indexOf(m), 1);
            res(m);
          },
        });
      });
    };
    c.close = () => ws.close();
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const ID_C = 'cccccccccccc';

test('HTTP: sağlık, ana sayfa, oda linki, 404 ve dizin dışına çıkma engeli', async () => {
  const srv = await start();
  try {
    const h = await fetch(srv.base + '/healthz').then((r) => r.json());
    assert.equal(h.ok, true);
    const home = await fetch(srv.base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /RiftVoice/);
    const room = await fetch(srv.base + '/r/baron-takimi');
    assert.equal(room.status, 200);
    assert.match(room.headers.get('content-type'), /text\/html/);
    const js = await fetch(srv.base + '/app.js');
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(srv.base + '/yok.txt')).status, 404);
    const trav = await fetch(srv.base + '/..%2fserver.js');
    assert.ok([403, 404].includes(trav.status));
    assert.equal((await fetch(srv.base + '/', { method: 'POST' })).status, 405);
  } finally {
    await srv.close();
  }
});

test('Katılma, eş listesi, sinyal iletimi ve durum yayını', async () => {
  const srv = await start();
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'Test-Oda', id: ID_A, name: 'Ali' });
    const wa = await a.wait((m) => m.t === 'welcome');
    assert.equal(wa.room, 'test-oda');
    assert.deepEqual(wa.peers, []);
    assert.ok(Array.isArray(wa.iceServers) && wa.iceServers.length > 0);

    const b = await client(srv);
    b.send({ t: 'join', room: 'test-oda', id: ID_B, name: 'Berk', muted: true });
    const wb = await b.wait((m) => m.t === 'welcome');
    assert.equal(wb.peers.length, 1);
    assert.equal(wb.peers[0].id, ID_A);
    const pj = await a.wait((m) => m.t === 'peer-joined');
    assert.equal(pj.peer.id, ID_B);
    assert.equal(pj.peer.muted, true);

    b.send({ t: 'signal', to: ID_A, data: { sid: 'x', description: { type: 'offer', sdp: 'v=0' } } });
    const sig = await a.wait((m) => m.t === 'signal');
    assert.equal(sig.from, ID_B);
    assert.equal(sig.data.description.type, 'offer');

    a.send({ t: 'state', muted: true, deafened: true });
    const st = await b.wait((m) => m.t === 'peer-state');
    assert.equal(st.id, ID_A);
    assert.equal(st.deafened, true);

    a.send({ t: 'chat', text: '  gank geliyor  ' });
    const ch = await b.wait((m) => m.t === 'chat');
    assert.equal(ch.text, 'gank geliyor');
    assert.equal(ch.name, 'Ali');

    // Başka odadaki birine sinyal gitmemeli
    const c = await client(srv);
    c.send({ t: 'join', room: 'baska-oda', id: ID_C, name: 'Can' });
    await c.wait((m) => m.t === 'welcome');
    c.send({ t: 'signal', to: ID_A, data: { x: 1 } });
    await sleep(100);
    assert.ok(!a.msgs.some((m) => m.t === 'signal' && m.from === ID_C));

    b.send({ t: 'leave' });
    const left = await a.wait((m) => m.t === 'peer-left');
    assert.equal(left.id, ID_B);
    a.close();
    b.close();
    c.close();
  } finally {
    await srv.close();
  }
});

test('Geçersiz katılma ve dolu oda reddedilir', async () => {
  const srv = await start({ maxRoomSize: 2 });
  try {
    const x = await client(srv);
    x.send({ t: 'join', room: 'kötü oda!', id: ID_A, name: 'x' });
    assert.equal((await x.wait((m) => m.t === 'error')).code, 'bad-join');
    x.send({ t: 'join', room: 'oda', id: 'kisa', name: 'x' });
    assert.equal((await x.wait((m) => m.t === 'error')).code, 'bad-join');
    x.send({ t: 'join', room: 'oda', id: ID_A, name: '   ' });
    assert.equal((await x.wait((m) => m.t === 'error')).code, 'bad-join');
    // bozuk JSON sunucuyu düşürmemeli
    x.ws.send('{bozuk');
    x.send({ t: 'ping' });
    await x.wait((m) => m.t === 'pong');

    const a = await client(srv);
    a.send({ t: 'join', room: 'oda', id: ID_A, name: 'A' });
    await a.wait((m) => m.t === 'welcome');
    const b = await client(srv);
    b.send({ t: 'join', room: 'oda', id: ID_B, name: 'B' });
    await b.wait((m) => m.t === 'welcome');
    const c = await client(srv);
    c.send({ t: 'join', room: 'oda', id: ID_C, name: 'C' });
    assert.equal((await c.wait((m) => m.t === 'error')).code, 'room-full');
    [x, a, b, c].forEach((k) => k.close());
  } finally {
    await srv.close();
  }
});

test('Kısa kopmada odadan atılmaz, aynı kimlikle geri dönülür; süre dolunca atılır', async () => {
  const srv = await start({ graceMs: 400 });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'oda', id: ID_A, name: 'A' });
    await a.wait((m) => m.t === 'welcome');
    let b = await client(srv);
    b.send({ t: 'join', room: 'oda', id: ID_B, name: 'B' });
    await b.wait((m) => m.t === 'welcome');
    await a.wait((m) => m.t === 'peer-joined');

    // B'nin bağlantısı kopuyor
    b.ws.terminate();
    const off = await a.wait((m) => m.t === 'peer-state' && m.id === ID_B);
    assert.equal(off.online, false);

    // Süre dolmadan geri dönüyor
    b = await client(srv);
    b.send({ t: 'join', room: 'oda', id: ID_B, name: 'B' });
    const wb = await b.wait((m) => m.t === 'welcome');
    assert.equal(wb.peers[0].id, ID_A);
    const on = await a.wait((m) => m.t === 'peer-state' && m.id === ID_B);
    assert.equal(on.online, true);
    await sleep(600);
    assert.ok(!a.msgs.some((m) => m.t === 'peer-left'), 'geri dönen eş atılmamalı');
    assert.ok(!a.msgs.some((m) => m.t === 'peer-joined'), 'geri dönüş yeni katılım sayılmamalı');

    // Aynı kimlikle ikinci soket eskisini devralır
    const b2 = await client(srv);
    b2.send({ t: 'join', room: 'oda', id: ID_B, name: 'B' });
    await b2.wait((m) => m.t === 'welcome');
    await sleep(100);
    assert.equal(b.ws.readyState, WebSocket.CLOSED);
    assert.ok(!a.msgs.some((m) => m.t === 'peer-left'));

    // Bu sefer geri dönmüyor
    b2.ws.terminate();
    const left = await a.wait((m) => m.t === 'peer-left', 2000);
    assert.equal(left.id, ID_B);
    assert.equal(srv.rooms.get('oda').size, 1);
    a.close();
    await sleep(600);
    assert.equal(srv.rooms.size, 0, 'boş oda temizlenmeli');
  } finally {
    await srv.close();
  }
});

test('TURN ayarları ortam değişkenlerinden okunur', () => {
  const plain = buildIceServers({ TURN_URLS: 'turn:t.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.deepEqual(plain[1], { urls: ['turn:t.example.com:3478'], username: 'u', credential: 'p' });
  const rest = buildIceServers({ TURN_URLS: 'turn:a,turns:b', TURN_SECRET: 's3cret' });
  assert.equal(rest[1].urls.length, 2);
  assert.match(rest[1].username, /^\d+:riftvoice$/);
  assert.ok(rest[1].credential.length > 10);
  assert.equal(buildIceServers({}).length, 1);
});
