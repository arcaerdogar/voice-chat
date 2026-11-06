'use strict';

// Ses tahtası kütüphanesi.
//
// - Kalıcıdır: dosyalar ve sounds.json dizini SOUNDS_DIR'de durur (sunucu yeniden başlasa da kalır).
// - Kanaldaki herkes ses ekleyebilir/silebilir (arkadaş grubu için); işlemler yönetici günlüğüne yazılır.
// - Sadece gerçek ses dosyaları kabul edilir (ilk baytlardan doğrulanır): MP3, OGG, WAV, M4A, WEBM.
// - Hazır sesler (korna, alkış…) tarayıcıda sentezlenir; burada sadece kimlikleri bilinir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILTIN = ['korna', 'davul', 'alkis', 'trombon', 'zil', 'kriket'];
// Ses çalarken çalan kişiye uygulanabilecek ses efektleri (istemcideki hazır ayarlarla aynı kimlikler)
const EFFECTS = ['', 'kalin', 'cokkalin', 'ince', 'sincap', 'robot', 'telsiz', 'magara', 'iblis'];
const EXT = { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/webm': 'webm' };

function sniffAudio(buf) {
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  return null;
}

function cleanName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** Tek bir emoji (ya da kısa simge); yoksa varsayılan */
function cleanEmoji(s) {
  const str = String(s || '').trim();
  if (!str) return '🔊';
  let first = str;
  try {
    first = [...new Intl.Segmenter().segment(str)][0].segment;
  } catch {
    first = [...str][0];
  }
  return first.slice(0, 16) || '🔊';
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function createSounds(opts = {}) {
  const dir = path.resolve(opts.dir || './sounds');
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const maxCount = opts.maxCount || 40;
  const maxTotal = opts.maxTotalBytes || 100 * 1024 * 1024;
  const maxDuration = opts.maxDurationSec || 180;
  const log = opts.log || (() => {});
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'sounds.json');

  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter((s) => s && s.id && fs.existsSync(path.join(dir, s.file)));
  } catch {}

  function persist() {
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fs.renameSync(tmp, indexFile);
  }

  const publicInfo = (s) => ({ id: s.id, name: s.name, emoji: s.emoji, effect: s.effect, duration: s.duration, by: s.by, createdAt: s.createdAt });
  const get = (id) => list.find((s) => s.id === id) || null;

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (declared > maxBytes) {
        req.resume();
        return reject(httpError(413, `Ses dosyası en fazla ${Math.round(maxBytes / 1048576)} MB olabilir.`));
      }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          reject(httpError(413, `Ses dosyası en fazla ${Math.round(maxBytes / 1048576)} MB olabilir.`));
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function add(req, { name, emoji, effect, duration, by }) {
    if (list.length >= maxCount) {
      req.resume();
      throw httpError(409, `Ses tahtası dolu (en fazla ${maxCount} ses). Önce birini sil.`);
    }
    const dur = Number(duration);
    if (!(dur > 0) || dur > maxDuration) {
      req.resume();
      throw httpError(400, `Ses en fazla ${Math.round(maxDuration / 60)} dakika olabilir.`);
    }
    const buf = await readBody(req);
    if (!buf.length) throw httpError(400, 'Dosya boş.');
    const total = list.reduce((a, s) => a + (s.size || 0), 0);
    if (total + buf.length > maxTotal) throw httpError(409, 'Ses tahtası için ayrılan yer doldu. Önce birkaç ses sil.');
    const mime = sniffAudio(buf);
    if (!mime) throw httpError(415, 'Bu bir ses dosyası değil (MP3, OGG, WAV, M4A ya da WEBM olmalı).');
    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.${EXT[mime]}`;
    await fs.promises.writeFile(path.join(dir, file), buf);
    const s = {
      id,
      file,
      mime,
      size: buf.length,
      name: cleanName(name) || 'Ses',
      emoji: cleanEmoji(emoji),
      effect: EFFECTS.includes(effect) ? effect : '',
      duration: Math.round(dur * 10) / 10,
      by: cleanName(by),
      createdAt: Date.now(),
    };
    list.push(s);
    persist();
    log('sound', `eklendi ${s.id} "${s.name}" ${buf.length} B`);
    return s;
  }

  function remove(id) {
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const [s] = list.splice(i, 1);
    persist();
    fs.promises.unlink(path.join(dir, s.file)).catch(() => {});
    return s;
  }

  function serve(req, res, id) {
    const s = /^[0-9a-f]{16}$/.test(id) ? get(id) : null;
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bulunamadı');
    }
    res.writeHead(200, {
      'Content-Type': s.mime,
      'Content-Length': s.size,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // İçerik kimliğe bağlı, hiç değişmez
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(path.join(dir, s.file)).on('error', () => res.destroy()).pipe(res);
  }

  return {
    list: () => list.map(publicInfo),
    add,
    remove,
    get,
    serve,
    has: (id) => BUILTIN.includes(id) || !!get(id),
    isBuiltin: (id) => BUILTIN.includes(id),
    publicInfo,
    maxBytes,
    maxDuration,
  };
}

module.exports = { createSounds, sniffAudio, BUILTIN, EFFECTS };
