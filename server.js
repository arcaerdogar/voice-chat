'use strict';

// RiftVoice sinyal sunucusu.
// Ses verisi bu sunucudan GEÇMEZ: oyuncular WebRTC ile doğrudan (P2P) bağlanır.
// Sunucu sadece odaları ve bağlantı kurulum mesajlarını (SDP/ICE) taşır.
// Bu yüzden sunucu yeniden başlasa bile devam eden konuşmalar kesilmez;
// istemciler otomatik olarak yeniden bağlanıp odaya geri katılır.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createYouTube, parseYouTubeId } = require('./youtube');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanName(name) {
  if (typeof name !== 'string') return '';
  // Kontrol karakterlerini at, boşlukları sadeleştir.
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function normalizeRoom(room) {
  if (typeof room !== 'string') return '';
  const r = room.trim().toLowerCase();
  return ROOM_RE.test(r) ? r : '';
}

function buildIceServers(env) {
  const stun = (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const servers = [];
  if (stun.length) servers.push({ urls: stun });

  const turnUrls = (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    if (env.TURN_SECRET) {
      // coturn "use-auth-secret" (REST API) uyumlu, süreli kimlik bilgisi.
      const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
      const username = `${expiry}:riftvoice`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      servers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    } else {
      servers.push({ urls: turnUrls });
    }
  }
  return servers;
}

// ---------- Müzik (ortak YouTube çalma listesi) ----------

const MUSIC_QUEUE_MAX = 50;
const MUSIC_START_DELAY_MS = 1500; // herkes videoyu yükleyebilsin diye şarkı biraz ileride başlar
// Şarkı, bilinen süresi + bu pay dolunca sunucu tarafından geçilir. Pay, reklam izleyen
// birinin gerçek süreyi bildirmesine ve yavaş yükleyenlere zaman tanır.
const MUSIC_END_GRACE_MS = 8000;

/** YouTube oynatıcı hata kodlarının açıklaması */
function youtubeErrorText(code) {
  if (code === 101 || code === 150 || code === 152) return 'YouTube bu videonun başka sitelerde oynatılmasına izin vermiyor (telif ya da yaş sınırı)';
  if (code === 100) return 'video kaldırılmış ya da gizli';
  if (code === 2) return 'geçersiz video';
  if (code === 5) return 'tarayıcı bu videoyu oynatamadı';
  return 'YouTube hatası' + (code != null ? ' ' + code : '');
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const maxRoomSize = options.maxRoomSize || Number(env.MAX_ROOM_SIZE) || 12;
  const graceMs = options.graceMs ?? (Number(env.RECONNECT_GRACE_MS) || 20000);
  const heartbeatMs = options.heartbeatMs || 15000;
  const log = options.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const youtube =
    options.youtube ||
    createYouTube({
      apiKey: env.YOUTUBE_API_KEY,
      region: env.MUSIC_REGION || 'TR',
      oembed: options.fetchVideoInfo,
      log,
    });
  const musicStartDelay = options.musicStartDelayMs ?? MUSIC_START_DELAY_MS;
  const musicEndGrace = options.musicEndGraceMs ?? MUSIC_END_GRACE_MS;

  /**
   * Oda başına müzik durumu:
   *   queue:   sıradaki şarkılar   [{ key, id, title, author, by, duration }]
   *   current: çalan şarkı         { ...şarkı, key: çalma kimliği, itemKey, startedAt, pausedAt }
   *            (aynı şarkı tekrar çalınınca yeni çalma kimliği alır ki herkes baştan başlasın)
   *   history: çalınmış şarkılar, en yenisi başta (önceki şarkıya dönmek için)
   *   loop:    'off' | 'all' (liste tekrarı) | 'one' (tek şarkı tekrarı)
   */
  const music = new Map();
  const HISTORY_MAX = 30;
  const newKey = () => crypto.randomBytes(6).toString('hex');

  function musicOf(roomName) {
    let m = music.get(roomName);
    if (!m) {
      m = { queue: [], current: null, history: [], loop: 'off' };
      music.set(roomName, m);
    }
    return m;
  }

  function musicSnapshot(roomName) {
    const m = music.get(roomName);
    return {
      queue: m ? m.queue : [],
      current: m ? m.current : null,
      history: m ? m.history.slice(0, 15) : [],
      loop: m ? m.loop : 'off',
      search: youtube.searchEnabled,
      serverNow: Date.now(),
    };
  }

  function broadcastMusic(roomName, event) {
    broadcast(roomName, { t: 'music', ...musicSnapshot(roomName), event: event || null });
  }

  /** Çalan şarkının sıra/geçmiş için sade hali */
  function asItem(cur) {
    return { key: cur.itemKey, id: cur.id, title: cur.title, author: cur.author, by: cur.by, duration: cur.duration || null };
  }

  function startItem(roomName, item) {
    const m = musicOf(roomName);
    m.current = item
      ? { ...item, itemKey: item.key, key: newKey(), startedAt: Date.now() + musicStartDelay, pausedAt: null, duration: item.duration || null }
      : null;
    m.failedBy = new Set();
    m.altPending = false;
    scheduleMusicEnd(roomName);
  }

  /**
   * Sıradakine geç. how: 'ended' (şarkı bitti), 'skip' (biri geçti), 'failed' (çalınamadı).
   * Tek şarkı tekrarında biten şarkı baştan çalar; liste tekrarında biten/geçilen şarkı sıranın sonuna eklenir.
   */
  function advance(roomName, how) {
    const m = musicOf(roomName);
    const cur = m.current;
    if (cur) {
      if (how === 'ended' && m.loop === 'one') return startItem(roomName, asItem(cur));
      if (how !== 'failed') {
        m.history.unshift(asItem(cur));
        if (m.history.length > HISTORY_MAX) m.history.pop();
        if (m.loop === 'all' && m.queue.length < MUSIC_QUEUE_MAX) m.queue.push(asItem(cur));
      }
    }
    startItem(roomName, m.queue.shift() || null);
  }

  /** Önceki şarkıya dön; çalan şarkı sıranın başına geri konur. Geçmiş boşsa çalanı baştan başlatır. */
  function previous(roomName) {
    const m = musicOf(roomName);
    const cur = m.current;
    const prev = m.history.shift();
    if (!prev) {
      if (!cur) return null;
      startItem(roomName, asItem(cur));
      return asItem(cur);
    }
    // Liste tekrarında önceki şarkı bittiğinde sıranın sonuna eklenmişti; çift olmasın
    if (m.loop === 'all') {
      const last = m.queue.length - 1;
      if (last >= 0 && m.queue[last].key === prev.key) m.queue.pop();
    }
    if (cur) m.queue.unshift(asItem(cur));
    startItem(roomName, prev);
    return prev;
  }

  /**
   * Şarkının bitişini sunucu yönetir: süre bilindiğinde, süre + pay dolunca sıradakine geçer.
   * Böylece istemcilerin "bitti" bildirimi kaybolsa ya da hatalı gelse (ör. reklam bitişi)
   * müzik ne takılır ne de erken kesilir.
   */
  function scheduleMusicEnd(roomName) {
    const m = music.get(roomName);
    if (!m) return;
    clearTimeout(m.endTimer);
    m.endTimer = null;
    const cur = m.current;
    if (!cur || cur.pausedAt != null || !cur.duration) return;
    const at = cur.startedAt + cur.duration * 1000 + musicEndGrace;
    const key = cur.key;
    m.endTimer = setTimeout(() => {
      const mm = music.get(roomName);
      if (!mm || !mm.current || mm.current.key !== key || mm.current.pausedAt != null) return;
      advance(roomName, 'ended');
      broadcastMusic(roomName, null);
    }, Math.max(0, at - Date.now()));
    if (m.endTimer.unref) m.endTimer.unref();
  }

  function onlineCount(roomName) {
    const room = rooms.get(roomName);
    let n = 0;
    if (room) for (const mm of room.values()) if (mm.online) n++;
    return n;
  }

  /** @type {Map<string, Map<string, Member>>} */
  const rooms = new Map();

  // ---------- HTTP (statik dosyalar + sağlık kontrolü) ----------
  const server = http.createServer((req, res) => {
    try {
      handleHttp(req, res);
    } catch (err) {
      log('http error', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  });

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // YouTube gömülü oynatıcısı Referer ister (yoksa "Hata 153"); sadece origin gönderilir.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  }

  function handleHttp(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz') {
      let members = 0;
      for (const r of rooms.values()) members += r.size;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, members, uptime: Math.round(process.uptime()) }));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Oda linkleri (/r/oda-adi) aynı tek sayfalık uygulamayı açar.
    if (pathname === '/' || pathname.startsWith('/r/')) pathname = '/index.html';

    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bulunamadı');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        // Yeni sürüm deploy edildiğinde herkes hemen güncel dosyaları alsın.
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ---------- WebSocket sinyal ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  function send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        /* bağlantı kapanıyor olabilir */
      }
    }
  }

  function publicMember(m) {
    return { id: m.id, name: m.name, muted: m.muted, deafened: m.deafened, online: m.online };
  }

  function broadcast(roomName, msg, exceptId) {
    const room = rooms.get(roomName);
    if (!room) return;
    for (const m of room.values()) {
      if (m.id !== exceptId && m.online) send(m.ws, msg);
    }
  }

  function removeMember(roomName, id) {
    const room = rooms.get(roomName);
    if (!room) return;
    const m = room.get(id);
    if (!m) return;
    clearTimeout(m.graceTimer);
    room.delete(id);
    if (room.size === 0) {
      rooms.delete(roomName);
      const m = music.get(roomName);
      if (m) clearTimeout(m.endTimer);
      music.delete(roomName);
    }
    broadcast(roomName, { t: 'peer-left', id });
    log(`leave room=${roomName} id=${id} size=${room.size}`);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Basit hız sınırı: saniyede en fazla 200 mesaj.
    let windowStart = Date.now();
    let windowCount = 0;
    let chatTimes = [];
    let musicTimes = [];

    /** Bu soket şu an hangi üyeye bağlı */
    let member = null;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > 200) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        case 'ping':
          send(ws, { t: 'pong', serverNow: Date.now() });
          return;

        case 'join': {
          const roomName = normalizeRoom(msg.room);
          const id = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
          const name = cleanName(msg.name);
          if (!roomName || !id || !name) {
            send(ws, { t: 'error', code: 'bad-join', message: 'Geçersiz oda adı veya kullanıcı adı.' });
            return;
          }
          // Bu soket daha önce başka bir odaya katıldıysa oradan çıkar.
          if (member && (member.room !== roomName || member.id !== id)) {
            removeMember(member.room, member.id);
            member = null;
          }

          let room = rooms.get(roomName);
          const existing = room && room.get(id);
          if (!existing && room && room.size >= maxRoomSize) {
            send(ws, { t: 'error', code: 'room-full', message: `Oda dolu (en fazla ${maxRoomSize} kişi).` });
            return;
          }
          if (!room) {
            room = new Map();
            rooms.set(roomName, room);
          }

          if (existing) {
            // Yeniden bağlanma: aynı kimlik, yeni soket. P2P bağlantılar zaten
            // çalışıyor olabilir; diğerlerine sadece "tekrar çevrimiçi" deriz.
            clearTimeout(existing.graceTimer);
            existing.graceTimer = null;
            if (existing.ws && existing.ws !== ws) {
              const old = existing.ws;
              existing.ws = null;
              old.replaced = true;
              try {
                old.close(4000, 'replaced');
              } catch {}
            }
            existing.ws = ws;
            existing.online = true;
            existing.name = name;
            existing.muted = !!msg.muted;
            existing.deafened = !!msg.deafened;
            member = existing;
            broadcast(roomName, { t: 'peer-state', ...publicMember(existing) }, id);
            log(`rejoin room=${roomName} id=${id}`);
          } else {
            member = {
              id,
              room: roomName,
              name,
              muted: !!msg.muted,
              deafened: !!msg.deafened,
              online: true,
              ws,
              graceTimer: null,
            };
            room.set(id, member);
            broadcast(roomName, { t: 'peer-joined', peer: publicMember(member) }, id);
            log(`join room=${roomName} id=${id} size=${room.size}`);
          }

          const peers = [];
          for (const m of room.values()) if (m.id !== id) peers.push(publicMember(m));
          send(ws, { t: 'welcome', id, room: roomName, peers, iceServers: buildIceServers(env), music: musicSnapshot(roomName) });
          return;
        }

        case 'signal': {
          if (!member || member.ws !== ws) return;
          const room = rooms.get(member.room);
          const target = room && typeof msg.to === 'string' && room.get(msg.to);
          if (!target || !target.online) return;
          send(target.ws, { t: 'signal', from: member.id, data: msg.data });
          return;
        }

        case 'state': {
          if (!member || member.ws !== ws) return;
          member.muted = !!msg.muted;
          member.deafened = !!msg.deafened;
          if (typeof msg.name === 'string' && cleanName(msg.name)) member.name = cleanName(msg.name);
          broadcast(member.room, { t: 'peer-state', ...publicMember(member) }, member.id);
          return;
        }

        case 'chat': {
          if (!member || member.ws !== ws) return;
          const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500) : '';
          if (!text) return;
          chatTimes = chatTimes.filter((t) => now - t < 5000);
          if (chatTimes.length >= 8) return;
          chatTimes.push(now);
          const out = { t: 'chat', from: member.id, name: member.name, text, ts: now };
          broadcast(member.room, out);
          return;
        }

        case 'music-add': {
          if (!member || member.ws !== ws) return;
          const input = typeof msg.url === 'string' ? msg.url.trim() : '';
          if (!input) return;
          musicTimes = musicTimes.filter((t) => now - t < 10000);
          if (musicTimes.length >= 5) {
            send(ws, { t: 'music-error', message: 'Çok hızlı ekliyorsun, biraz bekle.' });
            return;
          }
          musicTimes.push(now);
          if (musicOf(member.room).queue.length >= MUSIC_QUEUE_MAX) {
            send(ws, { t: 'music-error', message: `Sıra dolu (en fazla ${MUSIC_QUEUE_MAX} şarkı).` });
            return;
          }
          const adder = member;
          Promise.resolve(youtube.resolve(input))
            .then((res) => {
              // Bu sırada kişi ayrılmış veya oda kapanmış olabilir
              const room = rooms.get(adder.room);
              if (!room || room.get(adder.id) !== adder) return;
              if (!res || res.error) {
                send(adder.ws, { t: 'music-error', message: (res && res.error) || 'Şarkı eklenemedi.' });
                return;
              }
              const m = musicOf(adder.room);
              if (m.queue.length >= MUSIC_QUEUE_MAX) return;
              const v = res.item;
              const item = { key: newKey(), id: v.id, title: v.title, author: v.author || null, by: adder.name, duration: v.duration || null };
              m.queue.push(item);
              const startNow = !m.current;
              if (startNow) startItem(adder.room, m.queue.shift());
              let event = startNow ? `🎵 ${adder.name} çalıyor: ${item.title}` : `🎵 ${adder.name} sıraya ekledi: ${item.title}`;
              if (res.replaced) event += ` (orijinali "${res.replaced.title}" çalınamıyor: ${res.replaced.reason}; çalınabilen versiyonu eklendi)`;
              broadcastMusic(adder.room, event);
            })
            .catch((err) => log('music-add', err));
          return;
        }

        case 'music-prev': {
          if (!member || member.ws !== ws) return;
          const prev = previous(member.room);
          if (!prev) return;
          broadcastMusic(member.room, `⏮️ ${member.name} önceki şarkıya döndü: ${prev.title}`);
          return;
        }

        case 'music-loop': {
          if (!member || member.ws !== ws) return;
          if (!['off', 'all', 'one'].includes(msg.mode)) return;
          const m = musicOf(member.room);
          if (m.loop === msg.mode) return;
          m.loop = msg.mode;
          const names = { off: 'kapalı', all: 'liste tekrarı', one: 'tek şarkı tekrarı' };
          broadcastMusic(member.room, `🔁 ${member.name}: tekrar modu ${names[msg.mode]}`);
          return;
        }

        case 'music-requeue': {
          // Geçmişteki bir şarkıyı tekrar sıraya ekle
          if (!member || member.ws !== ws) return;
          const m = music.get(member.room);
          const h = m && m.history.find((x) => x.key === msg.key);
          if (!h || m.queue.length >= MUSIC_QUEUE_MAX) return;
          const item = { ...h, key: newKey(), by: member.name };
          m.queue.push(item);
          if (!m.current) startItem(member.room, m.queue.shift());
          broadcastMusic(member.room, `🎵 ${member.name} tekrar sıraya ekledi: ${item.title}`);
          return;
        }

        case 'music-duration': {
          // İstemciler oynatıcının bildirdiği süreyi gönderir. Reklam sırasında reklamın
          // süresi gelebilir; bu yüzden en büyük değer geçerlidir.
          if (!member || member.ws !== ws) return;
          const m = music.get(member.room);
          const cur = m && m.current;
          const d = Number(msg.duration);
          if (!cur || msg.key !== cur.key || !Number.isFinite(d) || d < 1 || d > 12 * 3600) return;
          if (cur.duration && d <= cur.duration + 0.5) return;
          cur.duration = Math.round(d * 10) / 10;
          scheduleMusicEnd(member.room);
          broadcastMusic(member.room, null);
          return;
        }

        case 'music-skip':
        case 'music-stop':
        case 'music-pause':
        case 'music-resume':
        case 'music-remove':
        case 'music-ended':
        case 'music-failed': {
          if (!member || member.ws !== ws) return;
          const m = music.get(member.room);
          if (!m) return;
          const cur = m.current;
          let event = null;
          if (msg.t === 'music-skip') {
            if (!cur) return;
            advance(member.room, 'skip');
            event = `⏭️ ${member.name} geçti: ${cur.title}`;
          } else if (msg.t === 'music-stop') {
            if (!cur && !m.queue.length) return;
            if (cur) {
              m.history.unshift(asItem(cur));
              if (m.history.length > HISTORY_MAX) m.history.pop();
            }
            m.queue = [];
            m.current = null;
            scheduleMusicEnd(member.room);
            event = `⏹️ ${member.name} müziği durdurdu`;
          } else if (msg.t === 'music-pause') {
            if (!cur || cur.pausedAt != null) return;
            cur.pausedAt = Math.max(0, (now - cur.startedAt) / 1000);
            scheduleMusicEnd(member.room);
            event = `⏸️ ${member.name} duraklattı`;
          } else if (msg.t === 'music-resume') {
            if (!cur || cur.pausedAt == null) return;
            cur.startedAt = now - cur.pausedAt * 1000;
            cur.pausedAt = null;
            scheduleMusicEnd(member.room);
            event = `▶️ ${member.name} devam ettirdi`;
          } else if (msg.t === 'music-remove') {
            const i = m.queue.findIndex((q) => q.key === msg.key);
            if (i < 0) return;
            const [removed] = m.queue.splice(i, 1);
            event = `🗑️ ${member.name} sıradan çıkardı: ${removed.title}`;
          } else {
            // music-ended / music-failed: sadece şu anki şarkı için ve bir kez işlenir
            if (!cur || msg.key !== cur.key) return;
            if (msg.t === 'music-ended') {
              // Süresi dolmadan gelen "bitti" bildirimi yok sayılır: reklam bitişi ya da eski oynatıcı
              // durumu şarkıyı herkes için kesmesin. Süre (istemciler videoda 20 sn'yi geçince bildirir)
              // biliniyorsa dolmuş olmalı; bilinmiyorsa (çok kısa video) en az 25 sn geçmiş olmalı.
              if (cur.pausedAt != null) return;
              const elapsed = (now - cur.startedAt) / 1000;
              if (cur.duration ? elapsed < cur.duration - 5 : elapsed < 25) return;
              advance(member.room, 'ended');
            } else {
              // Oynatılamama: bir kişideki sorun herkesin müziğini kesmesin.
              // Ancak odadakilerin yarısından fazlası oynatamıyorsa geçilir.
              if (!m.failedBy) m.failedBy = new Set();
              m.failedBy.add(member.id);
              const reason = youtubeErrorText(typeof msg.code === 'number' ? msg.code : null);
              if (m.failedBy.size * 2 <= onlineCount(member.room)) {
                send(ws, { t: 'music-error', message: `Bu video sende oynatılamıyor: ${reason}. Diğerlerinde çalmaya devam ediyor.` });
                return;
              }
              // Çoğunluk oynatamıyor: API anahtarı varsa aynı şarkının çalınabilen versiyonunu dene
              if (m.altPending) return;
              m.altPending = true;
              const roomName = member.room;
              Promise.resolve(youtube.alternativeFor(cur))
                .then((alt) => {
                  const mm = music.get(roomName);
                  if (!mm || mm.current !== cur) return; // bu arada değişti
                  if (alt) {
                    startItem(roomName, { key: cur.itemKey, id: alt.id, title: alt.title, author: alt.author, by: cur.by, duration: alt.duration });
                    broadcastMusic(roomName, `🔄 "${cur.title}" çalınamadı (${reason}); yerine çalınabilen versiyonu: ${alt.title}`);
                  } else {
                    advance(roomName, 'failed');
                    broadcastMusic(roomName, `⚠️ Oynatılamadı, geçildi: ${cur.title} (${reason})`);
                  }
                })
                .catch((err) => log('music-alt', err));
              return;
            }
          }
          broadcastMusic(member.room, event);
          return;
        }

        case 'leave': {
          if (!member || member.ws !== ws) return;
          removeMember(member.room, member.id);
          member = null;
          return;
        }

        default:
          return;
      }
    });

    ws.on('close', () => {
      if (!member || member.ws !== ws || ws.replaced) return;
      const m = member;
      m.online = false;
      m.ws = null;
      // Kısa kopmalarda odadan atmıyoruz; P2P ses devam ediyor olabilir.
      broadcast(m.room, { t: 'peer-state', ...publicMember(m) }, m.id);
      m.graceTimer = setTimeout(() => removeMember(m.room, m.id), graceMs);
    });

    ws.on('error', () => {});
  });

  // Ölü soketleri temizle.
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, heartbeatMs);
  hb.unref();

  server.on('close', () => clearInterval(hb));

  function close() {
    return new Promise((resolve) => {
      for (const room of rooms.values()) for (const m of room.values()) clearTimeout(m.graceTimer);
      for (const m of music.values()) clearTimeout(m.endTimer);
      music.clear();
      rooms.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { server, wss, rooms, close, musicForTest: (room) => music.get(room) };
}

module.exports = { createServer, buildIceServers, normalizeRoom, cleanName, parseYouTubeId };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, close } = createServer();
  server.listen(port, () => console.log(`RiftVoice http://localhost:${port}`));

  // Beklenmeyen hatalar süreci düşürmesin; logla ve devam et.
  process.on('uncaughtException', (err) => console.error('uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

  const shutdown = () => {
    close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
