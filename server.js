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

function parseYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : 'https://' + text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/**
 * YouTube oEmbed ile başlık al. 401/403 = sahibi başka sitelerde oynatmayı kapatmış,
 * 404/400 = video yok. Ağ hatasında videoyu yine de kabul ederiz.
 */
async function fetchYouTubeInfo(id) {
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.status === 401 || res.status === 403) return { error: 'Bu video başka sitelerde oynatılmaya kapalı (sahibi engellemiş).' };
    if (res.status === 404 || res.status === 400) return { error: 'Video bulunamadı.' };
    if (!res.ok) return { title: null };
    const j = await res.json();
    return {
      title: typeof j.title === 'string' ? j.title.slice(0, 120) : null,
      author: typeof j.author_name === 'string' ? j.author_name.slice(0, 60) : null,
    };
  } catch {
    return { title: null };
  }
}

const MUSIC_QUEUE_MAX = 50;
const MUSIC_START_DELAY_MS = 1500; // herkes videoyu yükleyebilsin diye şarkı biraz ileride başlar

function createServer(options = {}) {
  const env = options.env || process.env;
  const maxRoomSize = options.maxRoomSize || Number(env.MAX_ROOM_SIZE) || 12;
  const graceMs = options.graceMs ?? (Number(env.RECONNECT_GRACE_MS) || 20000);
  const heartbeatMs = options.heartbeatMs || 15000;
  const log = options.quiet ? () => {} : (...a) => console.log(new Date().toISOString(), ...a);
  const getVideoInfo = options.fetchVideoInfo || fetchYouTubeInfo;

  /** Oda başına müzik durumu: { queue: [...], current: {..., startedAt, pausedAt} | null } */
  const music = new Map();

  function musicOf(roomName) {
    let m = music.get(roomName);
    if (!m) {
      m = { queue: [], current: null };
      music.set(roomName, m);
    }
    return m;
  }

  function musicSnapshot(roomName) {
    const m = music.get(roomName);
    return { queue: m ? m.queue : [], current: m ? m.current : null, serverNow: Date.now() };
  }

  function broadcastMusic(roomName, event) {
    broadcast(roomName, { t: 'music', ...musicSnapshot(roomName), event: event || null });
  }

  function playNext(roomName) {
    const m = musicOf(roomName);
    const next = m.queue.shift();
    m.current = next ? { ...next, startedAt: Date.now() + MUSIC_START_DELAY_MS, pausedAt: null } : null;
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
          const id = parseYouTubeId(msg.url);
          if (!id) {
            send(ws, { t: 'music-error', message: 'Geçerli bir YouTube linki değil.' });
            return;
          }
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
          Promise.resolve(getVideoInfo(id))
            .then((info) => {
              // Bu sırada kişi ayrılmış veya oda kapanmış olabilir
              const room = rooms.get(adder.room);
              if (!room || room.get(adder.id) !== adder) return;
              if (info && info.error) {
                send(adder.ws, { t: 'music-error', message: info.error });
                return;
              }
              const m = musicOf(adder.room);
              if (m.queue.length >= MUSIC_QUEUE_MAX) return;
              const item = {
                key: crypto.randomBytes(6).toString('hex'),
                id,
                title: (info && info.title) || `YouTube videosu (${id})`,
                author: (info && info.author) || null,
                by: adder.name,
              };
              m.queue.push(item);
              const startNow = !m.current;
              if (startNow) playNext(adder.room);
              broadcastMusic(adder.room, startNow ? `🎵 ${adder.name} çalıyor: ${item.title}` : `🎵 ${adder.name} sıraya ekledi: ${item.title}`);
            })
            .catch((err) => log('music-add', err));
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
            playNext(member.room);
            event = `⏭️ ${member.name} geçti: ${cur.title}`;
          } else if (msg.t === 'music-stop') {
            if (!cur && !m.queue.length) return;
            m.queue = [];
            m.current = null;
            event = `⏹️ ${member.name} müziği durdurdu`;
          } else if (msg.t === 'music-pause') {
            if (!cur || cur.pausedAt != null) return;
            cur.pausedAt = Math.max(0, (now - cur.startedAt) / 1000);
            event = `⏸️ ${member.name} duraklattı`;
          } else if (msg.t === 'music-resume') {
            if (!cur || cur.pausedAt == null) return;
            cur.startedAt = now - cur.pausedAt * 1000;
            cur.pausedAt = null;
            event = `▶️ ${member.name} devam ettirdi`;
          } else if (msg.t === 'music-remove') {
            const i = m.queue.findIndex((q) => q.key === msg.key);
            if (i < 0) return;
            const [removed] = m.queue.splice(i, 1);
            event = `🗑️ ${member.name} sıradan çıkardı: ${removed.title}`;
          } else {
            // music-ended / music-failed: herkes bildirir ama sadece şu anki şarkı için bir kez işlenir
            if (!cur || msg.key !== cur.key) return;
            // Şarkı süresi dolmadan gelen "bitti" bildirimi (hatalı/eski oynatıcı durumu) yok sayılır
            if (msg.t === 'music-ended' && cur.pausedAt == null && typeof msg.duration === 'number' && msg.duration > 0) {
              const elapsed = (now - cur.startedAt) / 1000;
              if (elapsed < msg.duration - 5) return;
            }
            playNext(member.room);
            if (msg.t === 'music-failed') event = `⚠️ Oynatılamadı, geçildi: ${cur.title}`;
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
      rooms.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { server, wss, rooms, close };
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
