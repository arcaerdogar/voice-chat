'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createYouTube, parseIsoDuration, cleanTitle } = require('../youtube');

/** Sahte YouTube Data API: videos ve search uç noktaları */
function fakeApi(videos, searches, calls = []) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + '?' + u.searchParams.get('q'));
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.pathname.endsWith('/videos')) {
      const ids = u.searchParams.get('id').split(',');
      return json({ items: ids.filter((id) => videos[id]).map((id) => videos[id]) });
    }
    if (u.pathname.endsWith('/search')) {
      assert.equal(u.searchParams.get('videoEmbeddable'), 'true');
      assert.equal(u.searchParams.get('regionCode'), 'TR');
      const q = u.searchParams.get('q');
      if (q === 'kota') return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
      return json({ items: (searches[q] || []).map((videoId) => ({ id: { videoId } })) });
    }
    return json({}, 404);
  };
}

const video = (id, title, extra = {}) => ({
  id,
  snippet: { title, channelTitle: extra.channel || 'Kanal' },
  contentDetails: { duration: extra.duration || 'PT3M30S', ...(extra.cd || {}) },
  status: { embeddable: extra.embeddable !== false, privacyStatus: 'public' },
});

test('YouTube: süre ve başlık yardımcıları', () => {
  assert.equal(parseIsoDuration('PT3M33S'), 213);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('P0D'), null);
  assert.equal(parseIsoDuration('saçma'), null);
  assert.equal(cleanTitle('Tarkan - Şımarık (Official Video) [4K]'), 'Tarkan - Şımarık');
  assert.equal(cleanTitle('Sezen Aksu - Firuze | Official Audio'), 'Sezen Aksu - Firuze');
  assert.equal(cleanTitle('Duman - Bu Akşam (Lyric Video)'), 'Duman - Bu Akşam');
});

test('YouTube: çalınamayan videoya çalınabilen versiyon bulunur, isimle arama yapılır', async () => {
  const videos = {
    OFFICIALvid: video('OFFICIALvid', 'Sanatçı - Şarkı (Official Video)', { embeddable: false }),
    AGEvideo123: video('AGEvideo123', 'Sanatçı - Yaşlı Şarkı', { cd: { contentRating: { ytRating: 'ytAgeRestricted' } } }),
    REGIONblock: video('REGIONblock', 'Sanatçı - Bölge Şarkısı', { cd: { regionRestriction: { blocked: ['TR', 'DE'] } } }),
    TOPICaudio1: video('TOPICaudio1', 'Şarkı', { channel: 'Sanatçı - Topic', duration: 'PT3M31S' }),
    LYRICSvid12: video('LYRICSvid12', 'Sanatçı - Şarkı (Lyrics)'),
    AGEalt12345: video('AGEalt12345', 'Sanatçı - Yaşlı Şarkı (cover)', { cd: { contentRating: { ytRating: 'ytAgeRestricted' } } }),
    OKvideo1234: video('OKvideo1234', 'Normal Şarkı', { duration: 'PT2M' }),
  };
  const searches = {
    'Sanatçı - Şarkı': ['OFFICIALvid', 'TOPICaudio1', 'LYRICSvid12'],
    'Sanatçı - Yaşlı Şarkı': ['AGEalt12345', 'LYRICSvid12'],
    'Sanatçı - Bölge Şarkısı': [],
    'güzel bir şarkı': ['AGEvideo123', 'OKvideo1234'],
  };
  const calls = [];
  const yt = createYouTube({ apiKey: 'test', region: 'TR', fetchImpl: fakeApi(videos, searches, calls) });
  assert.equal(yt.searchEnabled, true);

  // Çalınabilen video olduğu gibi eklenir, süresi baştan bilinir
  const ok = await yt.resolve('https://youtu.be/OKvideo1234');
  assert.equal(ok.item.id, 'OKvideo1234');
  assert.equal(ok.item.duration, 120);
  assert.equal(ok.replaced, undefined);

  // Gömmeye kapalı resmi klip → Topic kanalındaki versiyon (orijinalin kendisi atlanır)
  const off = await yt.resolve('https://www.youtube.com/watch?v=OFFICIALvid');
  assert.equal(off.item.id, 'TOPICaudio1');
  assert.equal(off.replaced.reason, 'sahibi başka sitelerde oynatmayı kapatmış');

  // Yaş sınırlı → yaş sınırlı olmayan ilk alternatif
  const age = await yt.resolve('AGEvideo123');
  assert.equal(age.item.id, 'LYRICSvid12');
  assert.equal(age.replaced.reason, 'yaş sınırlı');

  // Bölgede engelli ve alternatif yok → anlaşılır hata
  const reg = await yt.resolve('REGIONblock');
  assert.match(reg.error, /bu bölgede engelli/);

  // Şarkı adıyla arama: yaş sınırlı sonuç atlanır
  const s = await yt.resolve('güzel bir şarkı');
  assert.equal(s.item.id, 'OKvideo1234');

  // Arama önbelleği: aynı sorgu tekrar API'ye gitmez
  const before = calls.filter((c) => c.includes('search')).length;
  await yt.resolve('güzel bir şarkı');
  assert.equal(calls.filter((c) => c.includes('search')).length, before);

  // YouTube dışı link
  assert.match((await yt.resolve('https://open.spotify.com/track/abc')).error, /Sadece YouTube/);
  // Çalarken oynatılamayan şarkıya alternatif
  const alt = await yt.alternativeFor({ id: 'OFFICIALvid', title: 'Sanatçı - Şarkı (Official Video)' });
  assert.equal(alt.id, 'TOPICaudio1');

  // Kota doldu: anlaşılır mesaj, sonra API bir süre denenmez ama linkler oEmbed ile çalışmaya devam eder
  const yt2 = createYouTube({ apiKey: 'test', fetchImpl: fakeApi(videos, searches), oembed: async (id) => ({ title: 'oEmbed ' + id }) });
  assert.match((await yt2.resolve('kota')).error, /kotası doldu/);
  assert.match((await yt2.resolve('başka arama')).error, /kotası doldu/);
  assert.equal((await yt2.resolve('https://youtu.be/OKvideo1234')).item.title, 'oEmbed OKvideo1234');
});

test('YouTube: API anahtarı yokken linkler oEmbed ile çalışır, arama kapalıdır', async () => {
  const yt = createYouTube({
    oembed: async (id) => (id === 'kapalikapal' ? { blocked: true, reason: 'sahibi başka sitelerde oynatmayı kapatmış' } : { title: 'Başlık ' + id, author: 'X' }),
  });
  assert.equal(yt.searchEnabled, false);
  const ok = await yt.resolve('https://youtu.be/aaaaaaaaaaa');
  assert.deepEqual(ok.item, { id: 'aaaaaaaaaaa', title: 'Başlık aaaaaaaaaaa', author: 'X', duration: null });
  const blocked = await yt.resolve('kapalikapal');
  assert.match(blocked.error, /lyrics/);
  assert.match(blocked.error, /API anahtarı/);
  assert.match((await yt.resolve('tarkan şımarık')).error, /API anahtarı ayarlı değil/);
  assert.equal(await yt.alternativeFor({ id: 'x', title: 'y' }), null);
});
