'use strict';

// Müzik kaynakları: YouTube (video + ses) ve SoundCloud (sadece ses, ~5 kat az internet).
// Link ayrıştırma, parça bilgisi ve (YouTube API anahtarı varsa) arama.
//
// Telifli müzik notu: Sesi YouTube'dan indirip yeniden yayınlamıyoruz (YouTube kurallarına
// aykırı ve telifli içeriği yeniden dağıtmak olur). Bunun yerine her zaman YouTube'un resmi
// gömülü oynatıcısı kullanılır. Bir video gömülü oynatıcıda çalınamıyorsa (sahibi kapatmış,
// yaş sınırlı, bölgede engelli) YouTube Data API ile aynı şarkının çalınabilen bir
// versiyonu (Topic kanalı, lyrics, audio vb.) aranır.

const API = 'https://www.googleapis.com/youtube/v3';

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
 * SoundCloud parça linki → oEmbed'e verilecek temiz adres.
 * Dönüş: { url } | { error } | null (SoundCloud linki değil)
 */
function parseSoundCloudUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  let url;
  try {
    url = new URL(text.startsWith('http') ? text : 'https://' + text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (host === 'on.soundcloud.com') return url.pathname.length > 1 ? { url: 'https://on.soundcloud.com' + url.pathname } : null;
  if (host !== 'soundcloud.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { error: 'Bu bir SoundCloud profil linki; tek bir parçanın linkini yapıştırın.' };
  if (parts[1] === 'sets') return { error: 'SoundCloud çalma listeleri desteklenmiyor; parçaları tek tek ekleyin.' };
  if (['likes', 'reposts', 'tracks', 'albums', 'popular-tracks', 'followers', 'following'].includes(parts[1])) {
    return { error: 'Tek bir SoundCloud parçasının linkini yapıştırın.' };
  }
  return { url: 'https://soundcloud.com/' + parts.slice(0, 2).join('/') };
}

/** SoundCloud oEmbed: başlık, sanatçı ve kalıcı parça adresi (api.soundcloud.com/tracks/ID) */
async function fetchSoundCloud(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(5000) });
    if (res.status === 404 || res.status === 403) return { notFound: true };
    if (!res.ok) return { error: 'SoundCloud şu an yanıt vermiyor.' };
    const j = await res.json();
    const m = typeof j.html === 'string' && j.html.match(/url=([^&"]+)/);
    const api = m ? decodeURIComponent(m[1]) : null;
    if (api && /\/playlists\//.test(api)) return { error: 'SoundCloud çalma listeleri desteklenmiyor; parçaları tek tek ekleyin.' };
    const author = typeof j.author_name === 'string' ? j.author_name.slice(0, 60) : null;
    let title = typeof j.title === 'string' ? j.title : 'SoundCloud parçası';
    if (author && title.endsWith(' by ' + author)) title = title.slice(0, -(' by ' + author).length);
    const thumb = typeof j.thumbnail_url === 'string' && /^https:\/\//.test(j.thumbnail_url) ? j.thumbnail_url : null;
    return { id: api && /^https:\/\/api\.soundcloud\.com\/tracks\/\d+$/.test(api) ? api : url, title: title.slice(0, 120), author, thumb };
  } catch {
    return { error: 'SoundCloud şu an yanıt vermiyor.' };
  }
}

/** Linke benziyor mu (desteklenmeyen bir site de olabilir) */
function looksLikeUrl(text) {
  return /^(https?:\/\/|www\.)/i.test(text.trim()) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(text.trim());
}

/** ISO 8601 süre (PT3M33S) → saniye */
function parseIsoDuration(s) {
  const m = typeof s === 'string' && s.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, se] = m.map((x) => Number(x) || 0);
  const total = d * 86400 + h * 3600 + mi * 60 + se;
  return total > 0 ? total : null;
}

/** Arama için başlığı sadeleştir: "Sanatçı - Şarkı (Official Video) [4K]" → "Sanatçı - Şarkı" */
function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([][^)\]]*(official|video|audio|lyric|lyrics|clip|klip|remaster|hd|4k|mv|visualizer|music)[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * YouTube oEmbed ile başlık al (API anahtarı gerekmez). 401/403 = sahibi başka sitelerde
 * oynatmayı kapatmış, 404/400 = video yok. Ağ hatasında videoyu yine de kabul ederiz.
 */
async function fetchOEmbed(id, fetchImpl = fetch) {
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (res.status === 401 || res.status === 403) return { blocked: true, reason: 'sahibi başka sitelerde oynatmayı kapatmış' };
    if (res.status === 404 || res.status === 400) return { notFound: true };
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

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]   YouTube Data API v3 anahtarı (yoksa arama/alternatif kapalı)
 * @param {string} [opts.region]   Bölge kodu (bölge engeli kontrolü ve arama için), ör. TR
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.oembed] testler için oEmbed yerine geçen fonksiyon (id) => info
 */
function createYouTube(opts = {}) {
  const apiKey = opts.apiKey || '';
  const region = (opts.region || 'TR').toUpperCase();
  const fetchImpl = opts.fetchImpl || fetch;
  const oembed = opts.oembed || ((id) => fetchOEmbed(id, fetchImpl));
  const soundcloud = opts.soundcloud || ((url) => fetchSoundCloud(url, fetchImpl));
  const log = opts.log || (() => {});
  const searchCache = new Map(); // sorgu → { at, ids }
  let quotaUntil = 0; // kota dolunca bir süre API'yi deneme

  async function api(path, params) {
    if (Date.now() < quotaUntil) throw Object.assign(new Error('quota'), { quota: true });
    const url = `${API}/${path}?` + new URLSearchParams({ ...params, key: apiKey });
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      let reason = '';
      try {
        const j = await res.json();
        reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || '';
      } catch {}
      if (res.status === 403 && /quota/i.test(reason)) {
        quotaUntil = Date.now() + 30 * 60 * 1000;
        throw Object.assign(new Error('quota'), { quota: true });
      }
      throw new Error(`YouTube API ${res.status} ${reason}`);
    }
    return res.json();
  }

  /** Videoların ayrıntıları ve gömülü oynatıcıda çalınıp çalınamayacağı */
  async function details(ids) {
    const j = await api('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: String(ids.length) });
    const out = new Map();
    for (const v of j.items || []) {
      const st = v.status || {};
      const cd = v.contentDetails || {};
      const rr = cd.regionRestriction || {};
      let reason = null;
      if (st.embeddable === false) reason = 'sahibi başka sitelerde oynatmayı kapatmış';
      else if (cd.contentRating && cd.contentRating.ytRating === 'ytAgeRestricted') reason = 'yaş sınırlı';
      else if ((rr.blocked && rr.blocked.includes(region)) || (rr.allowed && !rr.allowed.includes(region))) reason = 'bu bölgede engelli';
      else if (st.privacyStatus === 'private') reason = 'gizli video';
      out.set(v.id, {
        id: v.id,
        title: String((v.snippet && v.snippet.title) || v.id).slice(0, 120),
        author: String((v.snippet && v.snippet.channelTitle) || '').slice(0, 60) || null,
        duration: parseIsoDuration(cd.duration),
        playable: !reason,
        reason,
      });
    }
    return out;
  }

  async function searchIds(q) {
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.ids;
    const j = await api('search', {
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '8',
      regionCode: region,
      q,
    });
    const ids = (j.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
    searchCache.set(key, { at: Date.now(), ids });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
    return ids;
  }

  /** Aramada çıkan ilk çalınabilir video */
  async function findPlayable(q, excludeId) {
    const ids = (await searchIds(q)).filter((id) => id !== excludeId);
    if (!ids.length) return null;
    const d = await details(ids);
    for (const id of ids) {
      const v = d.get(id);
      if (v && v.playable) return v;
    }
    return null;
  }

  function apiErrorText(err) {
    if (err && err.quota) return 'Günlük YouTube arama kotası doldu; şimdilik link yapıştırın.';
    return 'YouTube aramasına şu an ulaşılamıyor; link yapıştırmayı deneyin.';
  }

  /**
   * Kullanıcının yazdığını çalınabilir bir şarkıya çevir.
   * Dönüş: { item: {id,title,author,duration}, replaced?: {title, reason} } | { error }
   */
  async function resolve(input) {
    const text = typeof input === 'string' ? input.trim().slice(0, 300) : '';
    if (!text) return { error: 'Bir YouTube / SoundCloud linki ya da şarkı adı yaz.' };

    const sc = parseSoundCloudUrl(text);
    if (sc) {
      if (sc.error) return { error: sc.error };
      const info = await soundcloud(sc.url);
      if (info.notFound) return { error: 'SoundCloud parçası bulunamadı (gizli ya da silinmiş olabilir).' };
      if (info.error) return { error: info.error };
      return { item: { source: 'sc', id: info.id, title: info.title, author: info.author, duration: null, thumb: info.thumb || null } };
    }

    const id = parseYouTubeId(text);
    if (!id) {
      if (looksLikeUrl(text)) return { error: 'Sadece YouTube ve SoundCloud linkleri destekleniyor.' };
      if (!apiKey) return { error: 'Şarkı adıyla arama için sunucuda YouTube API anahtarı ayarlı değil. YouTube linki yapıştırın.' };
      try {
        const v = await findPlayable(text, null);
        return v ? { item: v } : { error: `"${text}" için çalınabilir bir sonuç bulunamadı.` };
      } catch (err) {
        log('youtube search', err.message);
        return { error: apiErrorText(err) };
      }
    }

    if (apiKey) {
      try {
        const d = (await details([id])).get(id);
        if (!d) return { error: 'Video bulunamadı.' };
        if (d.playable) return { item: d };
        const alt = await findPlayable(cleanTitle(d.title), id);
        if (alt) return { item: alt, replaced: { title: d.title, reason: d.reason } };
        return { error: `Bu video çalınamıyor (${d.reason}) ve çalınabilir bir versiyonu bulunamadı.` };
      } catch (err) {
        log('youtube details', err.message);
        // API'ye ulaşılamıyorsa oEmbed ile devam
      }
    }

    const info = await oembed(id);
    if (info && info.notFound) return { error: 'Video bulunamadı.' };
    if (info && (info.blocked || info.error)) {
      return {
        error:
          info.error ||
          `Bu video çalınamıyor (${info.reason}). Aynı şarkının "lyrics" ya da "audio" versiyonunu deneyin` +
            (apiKey ? '.' : ' (sunucuya YouTube API anahtarı eklenirse bu otomatik yapılır).'),
      };
    }
    return { item: { id, title: (info && info.title) || `YouTube videosu (${id})`, author: (info && info.author) || null, duration: null } };
  }

  /**
   * Çalınırken oynatılamayan bir şarkı için YouTube'da çalınabilen bir versiyon (API anahtarı gerekir).
   * SoundCloud'da sadece önizleme veren parçalar için de kullanılır.
   */
  async function alternativeFor(item) {
    if (!apiKey) return null;
    try {
      if (item.source === 'sc') return await findPlayable(`${item.author || ''} ${cleanTitle(item.title)}`.trim(), null);
      return await findPlayable(cleanTitle(item.title), item.id);
    } catch (err) {
      log('youtube alternative', err.message);
      return null;
    }
  }

  /** Şarkı adıyla arama: çalınabilir ilk sonuçlar (API anahtarı gerekir) */
  async function searchList(q) {
    if (!apiKey) throw new Error('Şarkı adıyla arama için sunucuda YouTube API anahtarı ayarlı değil. YouTube linki yapıştırın.');
    try {
      const ids = await searchIds(q);
      if (!ids.length) return [];
      const d = await details(ids);
      return ids
        .map((id) => d.get(id))
        .filter((v) => v && v.playable)
        .slice(0, 6)
        .map((v) => ({ id: v.id, title: v.title, author: v.author, duration: v.duration }));
    } catch (err) {
      throw new Error(apiErrorText(err));
    }
  }

  return { searchEnabled: !!apiKey, resolve, alternativeFor, searchList };
}

module.exports = { createYouTube, parseYouTubeId, parseSoundCloudUrl, looksLikeUrl, parseIsoDuration, cleanTitle, fetchOEmbed, fetchSoundCloud };
