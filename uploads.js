'use strict';

// Sohbette paylaşılan dosyalar.
//
// - Sadece kanaldaki kişiler yükleyebilir (server.js kişiye özel anahtarı kontrol eder).
// - Dosya adresi tahmin edilemez (/files/<24 hex>/<ad>).
// - Güvenli sunum: sadece bilinen görsel/video/ses türleri tarayıcıda açılır; diğer her şey
//   (HTML, SVG, PDF, zip…) indirilir. Ayrıca nosniff + sandbox CSP başlıkları.
// - Saklama: varsayılan 24 saat ya da kanal boşalınca silinir; toplam boyut sınırı aşılırsa en eskiler silinir.
//   Dosya bilgileri bellekte tutulduğu için sunucu açılırken klasördeki eski dosyalar temizlenir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INLINE = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
};

/** İlk baytlardan gerçek görsel türünü doğrula (görsel diye yüklenen başka bir şey görsel sayılmasın) */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 12) === 'ftypavif') return 'image/avif';
  return null;
}

function cleanFileName(name) {
  const n = String(name || 'dosya')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return n || 'dosya';
}

function createUploads(opts = {}) {
  const dir = path.resolve(opts.dir || './uploads');
  const maxBytes = opts.maxBytes || 25 * 1024 * 1024;
  const maxTotal = opts.maxTotalBytes || 2 * 1024 * 1024 * 1024;
  const ttlMs = opts.ttlMs || 24 * 3600 * 1000;
  const log = opts.log || (() => {});
  const files = new Map(); // id → bilgi
  let total = 0;

  // Açılışta klasörü hazırla; eski (bilgisi kaybolmuş) dosyaları sil
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (/^[a-f0-9]{24}(\.part)?$/.test(f)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  }

  function remove(id) {
    const f = files.get(id);
    if (!f) return;
    files.delete(id);
    total -= f.size;
    fs.unlink(path.join(dir, id), () => {});
  }

  function removeRoom(room) {
    for (const [id, f] of files) if (f.room === room) remove(id);
  }

  function cleanup() {
    const now = Date.now();
    for (const [id, f] of files) if (now - f.ts > ttlMs) remove(id);
    if (total > maxTotal) {
      const byAge = [...files.values()].sort((a, b) => a.ts - b.ts);
      for (const f of byAge) {
        if (total <= maxTotal * 0.9) break;
        remove(f.id);
      }
    }
  }
  const timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref();

  /**
   * İstek gövdesini dosya olarak kaydet.
   * @returns {Promise<object>} dosya bilgisi
   */
  function save(req, { room, uploader, name, type, width, height }) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > maxBytes) return reject(Object.assign(new Error(`Dosya en fazla ${Math.round(maxBytes / 1048576)} MB olabilir.`), { status: 413 }));
      const id = crypto.randomBytes(12).toString('hex');
      const tmp = path.join(dir, id + '.part');
      const out = fs.createWriteStream(tmp);
      let size = 0;
      let head = Buffer.alloc(0);
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.unlink(tmp, () => {});
        req.unpipe && req.unpipe(out);
        reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]);
        if (size > maxBytes) {
          fail(Object.assign(new Error(`Dosya en fazla ${Math.round(maxBytes / 1048576)} MB olabilir.`), { status: 413 }));
          req.destroy();
        }
      });
      req.on('aborted', () => fail(new Error('yükleme yarıda kesildi')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (failed) return;
        if (!size) {
          fs.unlink(tmp, () => {});
          return reject(Object.assign(new Error('Dosya boş.'), { status: 400 }));
        }
        fs.rename(tmp, path.join(dir, id), (err) => {
          if (err) return fail(err);
          let mime = String(type || '').toLowerCase().split(';')[0].trim();
          let kind = INLINE[mime] || 'file';
          // Görsel diye gelen dosyanın gerçekten görsel olduğunu doğrula
          if (kind === 'image') {
            const real = sniffImage(head);
            if (!real) kind = 'file';
            else mime = real;
          }
          if (kind === 'file') mime = 'application/octet-stream';
          const w = Number(width);
          const h = Number(height);
          const f = {
            id,
            room,
            uploader,
            name: cleanFileName(name),
            size,
            mime,
            kind,
            w: kind === 'image' || kind === 'video' ? (w > 0 && w < 20000 ? Math.round(w) : null) : null,
            h: kind === 'image' || kind === 'video' ? (h > 0 && h < 20000 ? Math.round(h) : null) : null,
            ts: Date.now(),
          };
          files.set(id, f);
          total += size;
          cleanup();
          resolve(f);
        });
      });
      req.pipe(out);
    });
  }

  /** Mesajda gösterilecek (güvenli) bilgi */
  function publicInfo(f) {
    return { id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind, w: f.w, h: f.h, url: `/files/${f.id}/${encodeURIComponent(f.name)}` };
  }

  /** GET /files/<id>/<ad> */
  function serve(req, res, id) {
    const f = /^[a-f0-9]{24}$/.test(id) ? files.get(id) : null;
    if (!f) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Dosya bulunamadı ya da süresi doldu.');
    }
    const p = path.join(dir, id);
    const disposition = (f.kind === 'file' ? 'attachment' : 'inline') + `; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
    const headers = {
      'Content-Type': f.mime,
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
      'Accept-Ranges': 'bytes',
    };
    // Video/ses için sarma (Range)
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : f.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
      if (start < 0) start = 0;
      if (end >= f.size) end = f.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${f.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${f.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(p, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': f.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
  }

  function stats() {
    return { count: files.size, bytes: total };
  }

  return { save, serve, get: (id) => files.get(id), publicInfo, remove, removeRoom, cleanup, stats, maxBytes, close: () => clearInterval(timer) };
}

module.exports = { createUploads, sniffImage, cleanFileName };
