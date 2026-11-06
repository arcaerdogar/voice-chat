'use strict';

// Ses tahtası: sabit ses listesi (kullanıcılar ekleyip silemez).
//
// Sesler iki yerden okunur; her klasörde ses dosyaları ve bir sounds.json listesi bulunur:
//   1) Uygulamayla gelenler: ./sounds (depoda)
//   2) Sunucuya sonradan eklenenler: SOUNDS_DIR (Docker'da /data/sounds, salt okunur)
// sounds.json: [{ "file": "ses.mp3", "name": "Ad", "emoji": "🔊", "effect": "kalin" }]
//   effect (isteğe bağlı): ses çalarken çalan kişinin sesine uygulanan efekt.
// Liste sunucu açılırken okunur; değişiklik için sunucuyu yeniden başlatın.
// Hazır sentez sesler (korna, alkış…) tarayıcıda üretilir; burada sadece kimlikleri bilinir.

const fs = require('fs');
const path = require('path');

const BUILTIN = ['korna', 'davul', 'alkis', 'trombon', 'zil', 'kriket'];
// İstemcideki hazır efekt ayarlarıyla aynı kimlikler
const EFFECTS = ['', 'kalin', 'cokkalin', 'ince', 'sincap', 'robot', 'telsiz', 'magara', 'iblis'];
const MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webm': 'audio/webm' };

function cleanText(s, max) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Bir klasördeki sounds.json'u oku; hatalı/eksik girdileri atla */
function readDir(dir, log) {
  const listFile = path.join(dir, 'sounds.json');
  if (!fs.existsSync(listFile)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  } catch (err) {
    log('sounds', `${listFile} okunamadı: ${err.message}`);
    return [];
  }
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const file = e && typeof e.file === 'string' ? path.basename(e.file) : '';
    const mime = MIME[path.extname(file).toLowerCase()];
    const full = path.join(dir, file);
    if (!file || !mime || !fs.existsSync(full)) {
      log('sounds', `atlandı (dosya yok ya da ses değil): ${dir}/${file}`);
      continue;
    }
    // Kimlik dosya adından: hamam-bocegi.mp3 → hamam-bocegi
    const id = path
      .basename(file, path.extname(file))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (!id || BUILTIN.includes(id)) continue;
    out.push({
      id,
      full,
      mime,
      size: fs.statSync(full).size,
      name: cleanText(e.name, 24) || id,
      emoji: cleanText(e.emoji, 16) || '🔊',
      effect: EFFECTS.includes(e.effect) ? e.effect : '',
    });
  }
  return out;
}

function createSounds(opts = {}) {
  const log = opts.log || (() => {});
  const dirs = (opts.dirs || [path.join(__dirname, 'sounds')]).filter(Boolean).map((d) => path.resolve(d));
  // Sonraki klasör aynı kimliği tanımlarsa öncekinin yerine geçer (sunucudaki ekler uygulamanınkini ezebilir)
  const byId = new Map();
  for (const d of dirs) for (const s of readDir(d, log)) byId.set(s.id, s);
  const list = [...byId.values()];
  log('sounds', `${list.length} ses yüklendi`);

  const publicInfo = (s) => ({ id: s.id, name: s.name, emoji: s.emoji, effect: s.effect });

  function serve(req, res, id) {
    const s = byId.get(id);
    if (!s) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bulunamadı');
    }
    res.writeHead(200, {
      'Content-Type': s.mime,
      'Content-Length': s.size,
      'X-Content-Type-Options': 'nosniff',
      // Sabit dosya; değişirse sunucu yeniden başlatılır. Kısa önbellek yeterli.
      'Cache-Control': 'private, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(s.full).on('error', () => res.destroy()).pipe(res);
  }

  return {
    list: () => list.map(publicInfo),
    serve,
    has: (id) => BUILTIN.includes(id) || byId.has(id),
  };
}

module.exports = { createSounds, BUILTIN, EFFECTS };
