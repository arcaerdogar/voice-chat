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
        const timer = setTimeout(() => rej(new Error('mesaj beklenirken zaman aşımı: ' + pred.toString().slice(0, 160))), ms);
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
    assert.match(await home.text(), /Yankı/);
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

test('Müzik: YouTube linki ayrıştırma', () => {
  const { parseYouTubeId } = require('../server');
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    `https://www.youtube.com/watch?v=${id}&list=PL1`,
    `youtu.be/${id}?t=30`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    id,
  ]) {
    assert.equal(parseYouTubeId(u), id, u);
  }
  for (const u of ['https://evil.com/watch?v=' + id, 'merhaba', '', 'https://youtube.com/watch?v=kisa', null]) {
    assert.equal(parseYouTubeId(u), null, String(u));
  }
});

test('Müzik: sıra, çalma, duraklatma, geçme, bitiş ve hatalar', async () => {
  const titles = { aaaaaaaaaaa: 'Şarkı A', bbbbbbbbbbb: 'Şarkı B', ccccccccccc: 'Şarkı C' };
  const srv = await start({
    fetchVideoInfo: async (id) => (id === 'kapalikapal' ? { error: 'Bu video başka sitelerde oynatılmaya kapalı.' } : { title: titles[id] || null, author: 'Sanatçı' }),
  });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'muzik', id: ID_A, name: 'Ali' });
    const wa = await a.wait((m) => m.t === 'welcome');
    assert.deepEqual(wa.music.queue, []);
    assert.equal(wa.music.current, null);
    assert.equal(typeof wa.music.serverNow, 'number');

    a.send({ t: 'music-add', url: 'https://youtu.be/aaaaaaaaaaa' });
    const m1 = await a.wait((m) => m.t === 'music');
    assert.equal(m1.current.title, 'Şarkı A');
    assert.equal(m1.current.by, 'Ali');
    assert.equal(m1.current.pausedAt, null);
    assert.ok(m1.current.startedAt > m1.serverNow, 'şarkı herkes yükleyebilsin diye biraz ileride başlamalı');
    assert.match(m1.event, /çalıyor/);

    // Geç katılan kişi o anki durumu alır
    const b = await client(srv);
    b.send({ t: 'join', room: 'muzik', id: ID_B, name: 'Berk' });
    const wb = await b.wait((m) => m.t === 'welcome');
    assert.equal(wb.music.current.key, m1.current.key);

    b.send({ t: 'music-add', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' });
    const m2 = await a.wait((m) => m.t === 'music' && m.queue.length === 1);
    assert.equal(m2.queue[0].title, 'Şarkı B');
    assert.equal(m2.current.title, 'Şarkı A');
    await b.wait((m) => m.t === 'music');

    // Duraklat / devam
    a.send({ t: 'music-pause' });
    const p = await b.wait((m) => m.t === 'music' && m.current.pausedAt != null);
    assert.ok(p.current.pausedAt >= 0);
    a.send({ t: 'music-pause' }); // ikinci kez: yok sayılır
    a.send({ t: 'music-resume' });
    const r = await b.wait((m) => m.t === 'music' && m.current.pausedAt == null);
    assert.match(r.event, /devam/);

    // Süre bilinmezken erken gelen "bitti" bildirimi yok sayılır (ör. reklam bitişi şarkıyı kesmesin)
    a.send({ t: 'music-ended', key: m1.current.key, duration: 15 });
    // Süre bildirimi: en büyük değer geçerli, küçüğü yok sayılır
    a.send({ t: 'music-duration', key: m1.current.key, duration: 200 });
    const d1 = await b.wait((m) => m.t === 'music' && m.current && m.current.duration === 200);
    assert.equal(d1.event, null);
    b.send({ t: 'music-duration', key: m1.current.key, duration: 15 });
    // Süresi dolmamış şarkı (200 sn) için bitiş yok sayılır
    a.send({ t: 'music-ended', key: m1.current.key });
    a.send({ t: 'ping' });
    await a.wait((m) => m.t === 'pong');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(!b.msgs.some((m) => m.t === 'music' && m.current && m.current.title === 'Şarkı B'), 'erken bitiş kabul edilmemeli');
    assert.ok(!b.msgs.some((m) => m.t === 'music' && m.current && m.current.duration === 15), 'kısa süre uzun olanı ezmemeli');

    // Yanlış anahtarla bitiş yok sayılır
    a.send({ t: 'music-ended', key: 'yanlis' });
    // 200 sn geçmiş gibi yap: süre dolunca bitiş kabul edilir
    srv.musicForTest('muzik').current.startedAt -= 200 * 1000;
    a.send({ t: 'music-ended', key: m1.current.key });
    b.send({ t: 'music-ended', key: m1.current.key }); // ikinci bildirim etkisiz
    const next = await b.wait((m) => m.t === 'music' && m.current && m.current.title === 'Şarkı B');
    assert.equal(next.queue.length, 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(srv.rooms.size, 1);

    // Sıraya ekle + çıkar
    a.send({ t: 'music-add', url: 'ccccccccccc' });
    const withC = await b.wait((m) => m.t === 'music' && m.queue.length === 1);
    b.send({ t: 'music-remove', key: withC.queue[0].key });
    const removed = await a.wait((m) => m.t === 'music' && m.queue.length === 0 && /çıkardı/.test(m.event || ''));
    assert.match(removed.event, /Şarkı C/);

    // Oynatılamama: tek kişide sorun varsa sadece ona uyarı, şarkı herkes için devam eder
    b.send({ t: 'music-failed', key: next.current.key, code: 150 });
    const warn = await b.wait((m) => m.t === 'music-error');
    assert.match(warn.message, /sende oynatılamıyor/);
    assert.match(warn.message, /telif ya da yaş sınırı/);
    assert.equal(srv.musicForTest('muzik').current.title, 'Şarkı B');
    // Çoğunluk (2/2) oynatamıyorsa geçilir
    a.send({ t: 'music-failed', key: next.current.key, code: 150 });
    const failed = await a.wait((m) => m.t === 'music' && m.current === null);
    assert.match(failed.event, /Oynatılamadı, geçildi: Şarkı B \(YouTube bu videonun/);

    // Hatalı / engelli linkler
    a.send({ t: 'music-add', url: 'bu bir link değil' });
    assert.match((await a.wait((m) => m.t === 'music-error')).message, /YouTube linki/);
    a.send({ t: 'music-add', url: 'https://youtu.be/kapalikapal' });
    assert.match((await a.wait((m) => m.t === 'music-error')).message, /kapalı/);

    // Geç + durdur
    // (geçersiz girişler de hız sınırına sayılır; Ali'nin hakkı dolmasın diye ikincisini Berk ekler)
    a.send({ t: 'music-add', url: 'aaaaaaaaaaa' });
    b.send({ t: 'music-add', url: 'bbbbbbbbbbb' });
    await b.wait((m) => m.t === 'music' && m.queue.length === 1);
    b.send({ t: 'music-skip' });
    const skipped = await a.wait((m) => m.t === 'music' && /geçti/.test(m.event || ''));
    assert.equal(skipped.current.title, 'Şarkı B');
    b.send({ t: 'music-stop' });
    const stopped = await a.wait((m) => m.t === 'music' && m.current === null && m.queue.length === 0);
    assert.match(stopped.event, /durdurdu/);

    // Hız sınırı
    for (let i = 0; i < 6; i++) b.send({ t: 'music-add', url: 'aaaaaaaaaaa' });
    assert.match((await b.wait((m) => m.t === 'music-error')).message, /hızlı/);

    // Oda boşalınca müzik durumu silinir
    a.close();
    b.close();
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(srv.rooms.size, 0);
  } finally {
    await srv.close();
  }
});

test('Müzik: şarkının bitişini sunucu yönetir (istemci bildirimi gelmese de), duraklatma zamanlayıcıyı durdurur', async () => {
  const srv = await start({ musicStartDelayMs: 0, musicEndGraceMs: 100, fetchVideoInfo: async (id) => ({ title: id }) });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'zaman', id: ID_A, name: 'Ali' });
    await a.wait((m) => m.t === 'welcome');
    a.send({ t: 'music-add', url: 'aaaaaaaaaaa' });
    const s1 = await a.wait((m) => m.t === 'music' && m.current);
    a.send({ t: 'music-add', url: 'bbbbbbbbbbb' });
    await a.wait((m) => m.t === 'music' && m.queue.length === 1);

    // Süre bilinmeden sunucu kendiliğinden geçmez
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(srv.musicForTest('zaman').current.id, 'aaaaaaaaaaa');

    // Süre 1 sn bildirildi; duraklatılınca geçmemeli
    a.send({ t: 'music-pause' });
    await a.wait((m) => m.t === 'music' && m.current.pausedAt != null);
    a.send({ t: 'music-duration', key: s1.current.key, duration: 1 });
    await a.wait((m) => m.t === 'music' && m.current.duration === 1);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(srv.musicForTest('zaman').current.id, 'aaaaaaaaaaa', 'duraklatılmış şarkı geçilmemeli');

    // Devam edince süre + pay dolunca sunucu kendisi sıradakine geçer
    a.send({ t: 'music-resume' });
    const s2 = await a.wait((m) => m.t === 'music' && m.current && m.current.id === 'bbbbbbbbbbb', 4000);
    assert.equal(s2.event, null);
    assert.equal(s2.current.duration, null, 'yeni şarkının süresi henüz bilinmiyor');
    a.close();
  } finally {
    await srv.close();
  }
});

test('Müzik: önceki şarkı, liste tekrarı, tek şarkı tekrarı ve geçmiş', async () => {
  const srv = await start({ musicStartDelayMs: 0, fetchVideoInfo: async (id) => ({ title: id.slice(0, 1).toUpperCase() }) });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'liste', id: ID_A, name: 'Ali' });
    const w = await a.wait((m) => m.t === 'welcome');
    assert.equal(w.music.loop, 'off');
    assert.deepEqual(w.music.history, []);
    assert.equal(w.music.search, false);

    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) {
      a.send({ t: 'music-add', url: id });
      await a.wait((m) => m.t === 'music' && /ekledi|çalıyor/.test(m.event || ''));
    }
    const M = () => srv.musicForTest('liste');
    const titles = () => ({ cur: M().current && M().current.title, queue: M().queue.map((q) => q.title).join(''), hist: M().history.map((q) => q.title).join('') });
    const finish = async () => {
      // Şarkının süresi dolmuş gibi yapıp bitir
      M().current.startedAt -= 60 * 1000;
      a.send({ t: 'music-ended', key: M().current.key });
      await a.wait((m) => m.t === 'music');
    };
    assert.deepEqual(titles(), { cur: 'A', queue: 'BC', hist: '' });

    await finish();
    assert.deepEqual(titles(), { cur: 'B', queue: 'C', hist: 'A' });

    // Önceki: B sıranın başına döner, A çalar
    a.send({ t: 'music-prev' });
    const prev = await a.wait((m) => m.t === 'music' && /önceki/.test(m.event || ''));
    assert.match(prev.event, /A$/);
    assert.deepEqual(titles(), { cur: 'A', queue: 'BC', hist: '' });
    // Geçmiş boşken "önceki" çalanı baştan başlatır (yeni çalma kimliği)
    const keyBefore = M().current.key;
    a.send({ t: 'music-prev' });
    await a.wait((m) => m.t === 'music');
    assert.equal(M().current.title, 'A');
    assert.notEqual(M().current.key, keyBefore);

    // Tek şarkı tekrarı: bitince aynı şarkı baştan (geçmişe eklenmez); "geç" yine sıradakine geçer
    a.send({ t: 'music-loop', mode: 'one' });
    assert.match((await a.wait((m) => m.t === 'music' && m.loop === 'one')).event, /tek şarkı/);
    const k1 = M().current.key;
    await finish();
    assert.deepEqual(titles(), { cur: 'A', queue: 'BC', hist: '' });
    assert.notEqual(M().current.key, k1, 'tekrar çalarken yeni çalma kimliği almalı');
    a.send({ t: 'music-skip' });
    await a.wait((m) => m.t === 'music' && /geçti/.test(m.event || ''));
    assert.deepEqual(titles(), { cur: 'B', queue: 'C', hist: 'A' });

    // Liste tekrarı: biten şarkı sıranın sonuna eklenir
    a.send({ t: 'music-loop', mode: 'all' });
    await a.wait((m) => m.t === 'music' && m.loop === 'all');
    await finish();
    assert.deepEqual(titles(), { cur: 'C', queue: 'B', hist: 'BA' });
    await finish();
    assert.deepEqual(titles(), { cur: 'B', queue: 'C', hist: 'CBA' });
    // Liste tekrarında "önceki": sıranın sonuna eklenmiş kopya çift olmasın
    a.send({ t: 'music-prev' });
    await a.wait((m) => m.t === 'music' && /önceki/.test(m.event || ''));
    assert.deepEqual(titles(), { cur: 'C', queue: 'B', hist: 'BA' });

    // Geçmişten tekrar sıraya ekleme
    a.send({ t: 'music-requeue', key: M().history[1].key });
    await a.wait((m) => m.t === 'music' && /tekrar sıraya/.test(m.event || ''));
    assert.deepEqual(titles(), { cur: 'C', queue: 'BA', hist: 'BA' });

    // Geçersiz tekrar modu yok sayılır; durdurunca çalan şarkı geçmişe girer
    a.send({ t: 'music-loop', mode: 'saçma' });
    a.send({ t: 'music-stop' });
    await a.wait((m) => m.t === 'music' && /durdurdu/.test(m.event || ''));
    assert.equal(M().loop, 'all');
    assert.deepEqual(titles(), { cur: null, queue: '', hist: 'CBA' });
    a.close();
  } finally {
    await srv.close();
  }
});

test('Müzik: çalarken çoğunlukta oynatılamayan şarkının yerine çalınabilen versiyonu çalınır', async () => {
  const youtube = {
    searchEnabled: true,
    resolve: async (input) => ({ item: { id: 'ORIGINAL123', title: 'Şarkı (Official Video)', author: 'Sanatçı', duration: 200 } }),
    alternativeFor: async (item) => (item.id === 'ORIGINAL123' ? { id: 'TOPICalt123', title: 'Şarkı', author: 'Sanatçı - Topic', duration: 201 } : null),
  };
  const srv = await start({ musicStartDelayMs: 0, youtube });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'alt', id: ID_A, name: 'Ali' });
    const w = await a.wait((m) => m.t === 'welcome');
    assert.equal(w.music.search, true);
    a.send({ t: 'music-add', url: 'şarkı adı' });
    const s1 = await a.wait((m) => m.t === 'music' && m.current);
    assert.equal(s1.current.duration, 200, 'API süresi baştan bilinmeli');
    a.send({ t: 'music-failed', key: s1.current.key, code: 150 });
    const s2 = await a.wait((m) => m.t === 'music' && m.current && m.current.id === 'TOPICalt123');
    assert.match(s2.event, /çalınamadı .*yerine çalınabilen versiyonu: Şarkı/);
    assert.notEqual(s2.current.key, s1.current.key);
    // Alternatif de çalınamazsa geçilir
    a.send({ t: 'music-failed', key: s2.current.key, code: 150 });
    const s3 = await a.wait((m) => m.t === 'music' && m.current === null);
    assert.match(s3.event, /Oynatılamadı, geçildi/);
    a.close();
  } finally {
    await srv.close();
  }
});

test('Müzik: SoundCloud önizleme parçası çoğunlukta oynatılamazsa YouTube versiyonuna geçilir', async () => {
  const youtube = {
    searchEnabled: true,
    resolve: async () => ({ item: { source: 'sc', id: 'https://api.soundcloud.com/tracks/1', title: 'Shape of You', author: 'Ed Sheeran', duration: null } }),
    alternativeFor: async (item) => (item.source === 'sc' ? { id: 'YTVERSION1', title: 'Ed Sheeran - Shape of You (Lyrics)', author: 'X', duration: 234 } : null),
  };
  const srv = await start({ musicStartDelayMs: 0, youtube });
  try {
    const a = await client(srv);
    a.send({ t: 'join', room: 'sc', id: ID_A, name: 'Ali' });
    await a.wait((m) => m.t === 'welcome');
    a.send({ t: 'music-add', url: 'https://soundcloud.com/edsheeran/shape-of-you' });
    const s1 = await a.wait((m) => m.t === 'music' && m.current);
    assert.equal(s1.current.source, 'sc');
    a.send({ t: 'music-failed', key: s1.current.key, code: 'sc-snip' });
    const s2 = await a.wait((m) => m.t === 'music' && m.current && m.current.id === 'YTVERSION1');
    assert.equal(s2.current.source, 'yt');
    assert.match(s2.event, /sadece 30 sn önizlemesini veriyor/);
    // Tanınmayan hata kodları metne karışmaz
    a.send({ t: 'music-failed', key: s2.current.key, code: '<script>' });
    const s3 = await a.wait((m) => m.t === 'music' && m.current === null);
    assert.match(s3.event, /\(YouTube hatası\)$/);
    a.close();
  } finally {
    await srv.close();
  }
});
