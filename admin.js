'use strict';

// Yönetici paneli: /admin (uygulamada linki yoktur).
//
// - Sadece ADMIN_USER ve ADMIN_PASSWORD (en az 10 karakter) tanımlıysa açılır; yoksa /admin 404 döner.
// - Oturum: HttpOnly + SameSite=Strict çerez (12 saat). Aynı IP'den 5 yanlış denemede 15 dk kilit.
// - Değişiklik yapan istekler sadece aynı siteden (Origin kontrolü) ve JSON ile kabul edilir (CSRF koruması).
// - Veriler bellektedir; sunucu yeniden başlarsa olay günlüğü ve yasaklar sıfırlanır.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ADMIN_DIR = path.join(__dirname, 'admin');
const COOKIE = 'yanki_admin';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** User-Agent → kısa, okunur cihaz bilgisi */
function parseUA(ua) {
  const s = String(ua || '');
  let browser = 'Bilinmiyor';
  let m;
  if ((m = s.match(/Edg\/(\d+)/))) browser = 'Edge ' + m[1];
  else if ((m = s.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
  else if ((m = s.match(/Firefox\/(\d+)/))) browser = 'Firefox ' + m[1];
  else if ((m = s.match(/Chrome\/(\d+)/))) browser = 'Chrome ' + m[1];
  else if ((m = s.match(/Version\/(\d+).*Safari/))) browser = 'Safari ' + m[1];
  let os = 'Bilinmiyor';
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
  else if (/Windows/.test(s)) os = 'Windows';
  else if ((m = s.match(/Android (\d+)/))) os = 'Android ' + m[1];
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser, os, mobile: /Mobi|Android|iPhone|iPad/.test(s) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * @param {object} ctx  Sunucunun iç durumuna ve işlemlerine erişim (bkz. server.js)
 * @param {object} env  Ortam değişkenleri
 */
function createAdmin(ctx, env) {
  const user = String(env.ADMIN_USER || '');
  const pass = String(env.ADMIN_PASSWORD || '');
  const enabled = user.length > 0 && pass.length >= 10;
  if ((user || pass) && !enabled) ctx.log('Yönetici paneli KAPALI: ADMIN_USER gerekli ve ADMIN_PASSWORD en az 10 karakter olmalı');
  else if (enabled) ctx.log('Yönetici paneli açık: /admin');

  const sessions = new Map(); // token → { user, ip, expires }
  const fails = new Map(); // ip → { count, until }

  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const credsOk = (u, p) => {
    // Sabit süreli karşılaştırma (zamanlamadan bilgi sızmasın)
    const a = crypto.timingSafeEqual(sha(u), sha(user));
    const b = crypto.timingSafeEqual(sha(p), sha(pass));
    return a && b;
  };

  function cookieToken(req) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
    return m ? m[1] : null;
  }

  function session(req) {
    const t = cookieToken(req);
    if (!t) return null;
    const s = sessions.get(t);
    if (!s) return null;
    if (s.expires < Date.now()) {
      sessions.delete(t);
      return null;
    }
    return { token: t, ...s };
  }

  function isHttps(req) {
    return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  /** CSRF: değişiklik isteği sadece aynı siteden gelebilir */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function json(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  function readJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('çok büyük'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('geçersiz JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveFile(res, file) {
    fs.readFile(path.join(ADMIN_DIR, file), (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  /** Paneldeki anlık görüntü */
  function snapshot() {
    const now = Date.now();
    const rooms = [];
    let members = 0;
    for (const [name, room] of ctx.rooms) {
      const meta = ctx.roomMeta.get(name) || {};
      const m = ctx.music.get(name);
      const list = [];
      for (const mem of room.values()) {
        members++;
        const names = new Map([...room.values()].map((x) => [x.id, x.name]));
        list.push({
          id: mem.id,
          name: mem.name,
          ip: mem.ip || null,
          country: mem.country || null,
          device: parseUA(mem.ua),
          online: mem.online,
          joinedAt: mem.joinedAt,
          connectedAt: mem.connectedAt,
          lastSeen: mem.lastSeen,
          reconnects: mem.reconnects || 0,
          muted: !!mem.muted,
          deafened: !!mem.deafened,
          sharing: !!mem.sharing,
          camera: !!mem.camera,
          chatCount: mem.chatCount || 0,
          audioBytes: mem.audioBytes || 0,
          // Diğer kişilerle bağlantı kalitesi (istemci 10 sn'de bir bildirir)
          peers: (mem.peerStats || []).map((p) => ({ ...p, name: names.get(p.id) || '?' })),
          statsAge: mem.statsAt ? Math.round((now - mem.statsAt) / 1000) : null,
        });
      }
      rooms.push({
        name,
        createdAt: meta.createdAt || null,
        locked: !!meta.locked,
        size: room.size,
        music: m && m.current ? { title: m.current.title, paused: m.current.pausedAt != null, queue: m.queue.length, loop: m.loop } : m ? { title: null, queue: m.queue.length, loop: m.loop } : null,
        members: list,
      });
    }
    rooms.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    const mem = process.memoryUsage();
    return {
      now,
      server: {
        startedAt: ctx.startedAt,
        uptime: Math.round((now - ctx.startedAt) / 1000),
        node: process.version,
        memoryMB: Math.round(mem.rss / 1048576),
        rooms: rooms.length,
        members,
        sockets: ctx.socketCount(),
        streamOn: ctx.streamOn(),
        turn: ctx.turnConfigured,
        maxRoomSize: ctx.maxRoomSize,
      },
      rooms,
      bans: [...ctx.bans].map(([ip, b]) => ({ ip, ...b })).filter((b) => !b.until || b.until > now),
      events: ctx.events.slice(-150).reverse(),
    };
  }

  async function handleAction(body, s) {
    const by = s.user;
    const { action } = body;
    const room = typeof body.room === 'string' ? body.room : '';
    const id = typeof body.id === 'string' ? body.id : '';
    switch (action) {
      case 'kick':
        return ctx.kickMember(room, id, 'Yönetici tarafından kanaldan çıkarıldın.', by);
      case 'ban': {
        const minutes = Number(body.minutes);
        if (!(minutes >= 0 && minutes <= 525600)) throw new Error('geçersiz süre');
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
        const target = ctx.findMember(room, id);
        const ip = target ? target.ip : typeof body.ip === 'string' ? body.ip.trim() : '';
        if (!ip) throw new Error('IP bulunamadı');
        return ctx.banIp(ip, minutes, reason, by);
      }
      case 'unban':
        return ctx.unbanIp(String(body.ip || ''), by);
      case 'mute':
        return ctx.muteMember(room, id, by);
      case 'lock':
        return ctx.lockRoom(room, !!body.locked, by);
      case 'close-room':
        return ctx.closeRoom(room, by);
      case 'music-stop':
      case 'music-skip':
        return ctx.musicControl(room, action === 'music-skip' ? 'skip' : 'stop', by);
      case 'announce': {
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : '';
        if (!text) throw new Error('mesaj boş');
        return ctx.announce(room || null, text, by);
      }
      default:
        throw new Error('bilinmeyen işlem');
    }
  }

  /** /admin isteklerini karşılar; /admin değilse false döner */
  async function handle(req, res, pathname, clientIp) {
    if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return false;
    if (!enabled) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadı');
      return true;
    }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') return serveFile(res, 'index.html'), true;
    if (pathname === '/admin/admin.js' || pathname === '/admin/admin.css') return serveFile(res, pathname.slice('/admin/'.length)), true;

    if (pathname === '/admin/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'izin yok' }), true;
      const f = fails.get(clientIp);
      if (f && f.until > Date.now()) {
        return json(res, 429, { error: `Çok fazla hatalı deneme. ${Math.ceil((f.until - Date.now()) / 60000)} dk sonra tekrar deneyin.` }), true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: 'geçersiz istek' }), true;
      }
      if (!credsOk(body.user || '', body.pass || '')) {
        const cur = fails.get(clientIp) || { count: 0, until: 0 };
        cur.count++;
        if (cur.count >= MAX_FAILS) {
          cur.until = Date.now() + LOCK_MS;
          cur.count = 0;
          ctx.logEvent('admin', `Yönetici girişi ${MAX_FAILS} kez hatalı, IP 15 dk kilitlendi: ${clientIp}`);
        } else ctx.logEvent('admin', `Hatalı yönetici girişi: ${clientIp}`);
        fails.set(clientIp, cur);
        await new Promise((r) => setTimeout(r, 400)); // denemeleri yavaşlat
        return json(res, 401, { error: 'Kullanıcı adı ya da şifre hatalı.' }), true;
      }
      fails.delete(clientIp);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { user, ip: clientIp, expires: Date.now() + SESSION_MS });
      ctx.logEvent('admin', `Yönetici girişi: ${user} (${clientIp})`);
      const cookie = `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
      return json(res, 200, { ok: true, user }, { 'Set-Cookie': cookie }), true;
    }

    if (pathname === '/admin/api/logout' && req.method === 'POST') {
      const s = session(req);
      if (s) sessions.delete(s.token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0` }), true;
    }

    if (pathname === '/admin/api/state' && req.method === 'GET') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'giriş gerekli' }), true;
      return json(res, 200, { user: s.user, ...snapshot() }), true;
    }

    if (pathname === '/admin/api/action' && req.method === 'POST') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'giriş gerekli' }), true;
      if (!sameOrigin(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 403, { error: 'izin yok' }), true;
      }
      try {
        const body = await readJson(req);
        const result = await handleAction(body, s);
        return json(res, 200, { ok: true, result: result || null }), true;
      } catch (err) {
        return json(res, 400, { error: err.message || 'işlem başarısız' }), true;
      }
    }

    res.writeHead(404);
    res.end();
    return true;
  }

  return { enabled, handle };
}

module.exports = { createAdmin, parseUA };
