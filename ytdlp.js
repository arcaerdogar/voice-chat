'use strict';

// yt-dlp ile YouTube'dan sadece ses akışı.
//
// Gömülü YouTube oynatıcısı yerine sunucu, şarkının ses akışının adresini yt-dlp ile alır ve
// odadaki kişilere aktarır (bkz. server.js /music/audio). Böylece:
//   - "başka sitelerde oynatılamaz" kısıtlaması olmaz,
//   - video indirilmez (Opus ses ~130 kbit/sn, saatte ~60 MB),
//   - reklam olmaz, şarkı adıyla arama API anahtarı gerektirmez.
// Arkadaşlar arası özel kullanım içindir; akış sadece odadaki kişilere açıktır.

const fs = require('fs');
const { execFile } = require('child_process');

function createYtDlp(opts = {}) {
  const bin = opts.bin || 'yt-dlp';
  const log = opts.log || (() => {});
  const base = ['--no-warnings', '--no-playlist', '--js-runtimes', 'node'];
  // YouTube sunucuyu bot sanarsa tarayıcıdan alınan çerez dosyası kullanılır (dosya yoksa yok sayılır)
  if (opts.cookies && fs.existsSync(opts.cookies)) {
    base.push('--cookies', opts.cookies);
    log('yt-dlp çerez dosyası kullanılıyor:', opts.cookies);
  }

  function run(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      execFile(bin, [...base, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || '').trim().split('\n').pop();
          return reject(Object.assign(new Error(msg || 'yt-dlp hatası'), { stderr: String(stderr || '') }));
        }
        resolve(String(stdout));
      });
    });
  }

  /** yt-dlp hata metnini kullanıcıya anlaşılır hale getir */
  function explain(err) {
    const s = (err && (err.stderr || err.message)) || '';
    if (/confirm you.?re not a bot|Sign in to confirm/i.test(s)) return "YouTube sunucuyu bot sandı; sunucuya YouTube çerezi eklenmeli (bkz. DEPLOY.md)";
    if (/age|inappropriate|Sign in to confirm your age/i.test(s)) return 'yaş sınırlı video (sunucuya YouTube çerezi eklenirse çalışır)';
    if (/Private video/i.test(s)) return 'gizli video';
    if (/unavailable|removed|does not exist|not available/i.test(s)) return 'video kaldırılmış ya da bu bölgede yok';
    if (/timed out|ETIMEDOUT|killed/i.test(s)) return "YouTube'a ulaşılamadı (zaman aşımı)";
    return "sunucu şarkıyı YouTube'dan alamadı";
  }

  let availability = null;
  /** yt-dlp kurulu ve çalışıyor mu (sonuç önbellekte) */
  function available() {
    if (!availability) {
      availability = run(['--version'], 15000)
        .then((v) => {
          log('yt-dlp', v.trim());
          return true;
        })
        .catch((err) => {
          log('yt-dlp bulunamadı, gömülü oynatıcı kullanılacak:', err.message);
          return false;
        });
    }
    return availability;
  }

  /**
   * Link ya da şarkı adı → { id, title, author, duration }
   * @param {string} target  YouTube video kimliği ya da arama metni
   */
  async function info(target, isId) {
    const arg = isId ? 'https://www.youtube.com/watch?v=' + target : 'ytsearch1:' + target;
    const out = await run(['-j', '--skip-download', arg], 40000);
    const line = out.trim().split('\n').filter(Boolean)[0];
    if (!line) throw new Error('sonuç yok');
    const j = JSON.parse(line);
    return {
      id: j.id,
      title: String(j.title || j.id).slice(0, 120),
      author: String(j.channel || j.uploader || '').slice(0, 60) || null,
      duration: Number(j.duration) > 0 ? Number(j.duration) : null,
      isLive: !!j.is_live,
    };
  }

  // Ses adresleri: kimlik → { url, mime, expires }. Adresler ~6 saat geçerli ve sunucunun IP'sine bağlı.
  const urls = new Map();
  const pending = new Map();

  async function audioUrl(id, { fresh = false } = {}) {
    const hit = urls.get(id);
    if (!fresh && hit && hit.expires - Date.now() > 10 * 60 * 1000) return hit;
    if (pending.has(id)) return pending.get(id);
    const p = (async () => {
      const out = await run(
        ['-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio', '--print', '%(ext)s', '--print', 'urls', 'https://www.youtube.com/watch?v=' + id],
        40000
      );
      const [ext, url] = out.trim().split('\n').map((s) => s.trim());
      if (!url || !/^https:\/\/[^/]+\.googlevideo\.com\//.test(url)) throw new Error('ses adresi alınamadı');
      const exp = Number(new URL(url).searchParams.get('expire')) * 1000 || Date.now() + 3 * 3600 * 1000;
      const entry = { url, mime: ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : 'audio/webm', expires: exp };
      urls.set(id, entry);
      if (urls.size > 300) urls.delete(urls.keys().next().value);
      return entry;
    })().finally(() => pending.delete(id));
    pending.set(id, p);
    return p;
  }

  /** Şarkı adıyla arama: ilk n sonuç (hızlı, sadece liste bilgisi) */
  async function search(q, n = 6) {
    const out = await run(['--flat-playlist', '-j', `ytsearch${n}:${q}`], 30000);
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const j = JSON.parse(line);
          if (j.live_status === 'is_live' || j.live_status === 'is_upcoming') return null;
          return {
            id: j.id,
            title: String(j.title || j.id).slice(0, 120),
            author: String(j.channel || j.uploader || '').slice(0, 60) || null,
            duration: Number(j.duration) > 0 ? Number(j.duration) : null,
          };
        } catch {
          return null;
        }
      })
      .filter((x) => x && /^[A-Za-z0-9_-]{11}$/.test(x.id));
  }

  return { available, info, audioUrl, explain, search };
}

/**
 * yt-dlp'yi düzenli güncelle (YouTube değiştikçe eski sürümler çalışmaz).
 * Açılıştan kısa süre sonra ve sonra her gün çalışır; hata olursa sadece loglanır.
 */
function startAutoUpdate({ pip, log = () => {}, firstDelayMs = 60 * 1000, intervalMs = 24 * 3600 * 1000 }) {
  const update = () =>
    execFile(pip, ['install', '-q', '--no-cache-dir', '-U', 'yt-dlp[default]'], { timeout: 5 * 60 * 1000, windowsHide: true }, (err, _out, stderr) => {
      if (err) log('yt-dlp güncellenemedi:', String(stderr || err.message).trim().split('\n').pop());
      else log('yt-dlp güncel');
    });
  const first = setTimeout(update, firstDelayMs);
  const every = setInterval(update, intervalMs);
  first.unref();
  every.unref();
}

module.exports = { createYtDlp, startAutoUpdate };
