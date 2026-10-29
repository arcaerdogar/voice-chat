'use strict';
// Yankı yönetim paneli. Kullanıcıların yazdığı her şey (isim, kanal adı, sebep) textContent ile
// eklenir; HTML olarak yorumlanmaz.
(() => {
  const $ = (s) => document.querySelector(s);
  const POLL_MS = 2000;
  let state = null;
  let pollTimer = null;
  let lastOk = 0;
  let banTarget = null;

  /** Güvenli DOM üretici: el('div', {class:'x', title:'..'}, 'metin', çocuk...) */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }

  let toastTimer;
  function toast(text, err) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.toggle('err', !!err);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---- yardımcılar ----
  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}g ${h}s`;
    if (h) return `${h}s ${m}dk`;
    if (m) return `${m}dk`;
    return `${sec}sn`;
  }
  const ago = (ts) => (ts ? dur((state.now - ts) / 1000) : '—');
  const clock = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // Ülke kodu → Türkçe ülke adı (Windows bayrak emojisi göstermediği için ad kullanılır)
  const regionNames = (() => {
    try {
      return new Intl.DisplayNames(['tr'], { type: 'region' });
    } catch {
      return null;
    }
  })();
  const flag = (cc) => {
    if (!cc || !/^[A-Z]{2}$/.test(cc)) return '';
    try {
      return (regionNames && regionNames.of(cc)) || cc;
    } catch {
      return cc;
    }
  };
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
  function hue(name) {
    let h = 0;
    for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }

  // ---- API ----
  async function api(path, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch('/admin/api/' + path, { credentials: 'same-origin', cache: 'no-store', ...opts });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && path !== 'login') {
      showLogin();
      throw new Error('Oturum sona erdi, tekrar giriş yapın.');
    }
    if (!res.ok) throw new Error(data.error || 'İstek başarısız (' + res.status + ')');
    return data;
  }

  async function act(body, okText, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api('action', body);
      if (okText) toast(okText);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---- görünümler ----
  function showLogin() {
    clearTimeout(pollTimer);
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#l-user').focus();
  }

  function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
  }

  function renderStats() {
    const s = state.server;
    const box = $('#stats');
    box.replaceChildren(
      ...[
        [s.rooms, 'Kanal'],
        [s.members, 'Kişi'],
        [s.sockets, 'Açık bağlantı'],
        [dur(s.uptime), 'Çalışma süresi'],
        [s.memoryMB + ' MB', 'Bellek'],
        [s.streamOn ? 'Açık' : 'Kapalı', 'Müzik akışı (yt-dlp)', s.streamOn ? 'ok' : 'warn'],
        [s.turn ? 'Ayarlı' : 'Yok', 'TURN sunucusu', s.turn ? 'ok' : 'warn'],
        [state.bans.length, 'Aktif yasak'],
        [`${s.uploads.count} · ${mb(s.uploads.bytes)}`, 'Paylaşılan dosya'],
      ].map(([v, k, cls]) => el('div', { class: 'stat ' + (cls || '') }, el('div', { class: 'v' }, v), el('div', { class: 'k' }, k)))
    );
    $('#who').textContent = state.user;
    // Duyuru hedefleri
    const sel = $('#announce-room');
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '' }, 'Tüm kanallar'), ...state.rooms.map((r) => el('option', { value: r.name }, r.name)));
    sel.value = state.rooms.some((r) => r.name === cur) ? cur : '';
  }

  function memberRow(room, m) {
    const peers = m.peers.length
      ? m.peers.map((p) => {
          const ok = p.state === 'connected';
          const cls = !ok ? 'red' : p.relay ? 'amber' : 'green';
          const label = `${p.name}: ${ok ? (p.relay ? 'röle' : 'P2P') + (p.rtt != null ? ' ' + p.rtt + 'ms' : '') : p.state === 'none' ? 'yok' : p.state}`;
          return el('span', { class: 'chip ' + cls, title: ok ? (p.relay ? 'TURN sunucusu üzerinden' : 'Doğrudan bağlantı') : 'Bağlantı kurulamadı' }, label);
        })
      : [el('span', { class: 'sub' }, room.size > 1 ? (m.statsAge == null ? 'bilgi bekleniyor' : '—') : 'tek başına')];
    const status = [
      !m.online && el('span', { class: 'chip amber' }, 'bağlantı koptu'),
      m.muted && el('span', { class: 'chip red' }, 'mikrofon kapalı'),
      m.deafened && el('span', { class: 'chip red' }, 'sesi kapalı'),
      m.camera && el('span', { class: 'chip blue' }, 'kamera'),
      m.sharing && el('span', { class: 'chip blue' }, 'ekran paylaşıyor'),
    ].filter(Boolean);
    return el(
      'tr',
      { 'data-id': m.id },
      el(
        'td',
        {},
        el(
          'div',
          { class: 'who' },
          el('span', { class: 'av' + (m.online ? ' on' : ''), style: `background:hsl(${hue(m.name)} 60% 50%)` }, (m.name || '?').charAt(0).toUpperCase()),
          el('div', {}, el('div', { class: 'nm' }, m.name), el('div', { class: 'sub mono' }, m.id.slice(0, 8)))
        )
      ),
      el('td', {}, el('div', { class: 'chips' }, status.length ? status : el('span', { class: 'chip green' }, 'konuşabilir'))),
      el('td', {}, el('div', { class: 'mono' }, m.ip || '—'), el('div', { class: 'sub' }, flag(m.country))),
      el('td', {}, el('div', {}, m.device.browser), el('div', { class: 'sub' }, m.device.os + (m.device.mobile ? ' · mobil' : ''))),
      el(
        'td',
        {},
        el('div', {}, ago(m.joinedAt)),
        el('div', { class: 'sub' }, m.reconnects ? `${m.reconnects} kez yeniden bağlandı` : 'kesintisiz')
      ),
      el('td', {}, el('div', { class: 'chips' }, peers)),
      el('td', {}, el('div', { class: 'sub' }, `${m.chatCount} mesaj`), el('div', { class: 'sub' }, m.audioBytes ? 'müzik ' + mb(m.audioBytes) : '')),
      el(
        'td',
        {},
        el(
          'div',
          { class: 'acts' },
          el('button', { class: 'btn small', type: 'button', disabled: m.muted, onclick: () => act({ action: 'mute', room: room.name, id: m.id }, `${m.name} susturuldu`) }, 'Sustur'),
          el(
            'button',
            { class: 'btn small', type: 'button', onclick: () => act({ action: 'kick', room: room.name, id: m.id }, `${m.name} çıkarıldı`, `${m.name} kanaldan çıkarılsın mı? (Tekrar girebilir.)`) },
            'At'
          ),
          el('button', { class: 'btn small danger', type: 'button', disabled: !m.ip, onclick: () => openBan(room, m) }, 'Yasakla')
        )
      )
    );
  }

  function renderRooms() {
    const q = $('#search').value.trim().toLowerCase();
    const box = $('#rooms');
    const rooms = state.rooms
      .map((r) => {
        if (!q || r.name.includes(q)) return r;
        const members = r.members.filter((m) => m.name.toLowerCase().includes(q) || (m.ip || '').includes(q));
        return members.length ? { ...r, members } : null;
      })
      .filter(Boolean);
    if (!rooms.length) {
      box.replaceChildren(el('div', { class: 'empty' }, state.rooms.length ? 'Aramayla eşleşen yok.' : 'Şu an hiç kanal yok.'));
      return;
    }
    box.replaceChildren(
      ...rooms.map((r) =>
        el(
          'section',
          { class: 'room', 'data-room': r.name },
          el(
            'div',
            { class: 'room-head' },
            el('span', { class: 'room-name' }, r.name),
            el('span', { class: 'badge' }, `${r.size} kişi`),
            r.locked && el('span', { class: 'badge lock' }, 'KİLİTLİ'),
            el('span', { class: 'room-meta' }, `açık: ${ago(r.createdAt)} · ${r.chatCount} mesaj`),
            r.music && r.music.title && el('span', { class: 'room-meta' }, `🎵 ${r.music.paused ? '(duraklatıldı) ' : ''}${r.music.title}${r.music.queue ? ` · sırada ${r.music.queue}` : ''}`),
            el(
              'div',
              { class: 'room-actions' },
              r.music &&
                r.music.title &&
                el('button', { class: 'btn small', type: 'button', onclick: () => act({ action: 'music-skip', room: r.name }, 'Şarkı geçildi') }, 'Şarkıyı geç'),
              r.music &&
                (r.music.title || r.music.queue) &&
                el('button', { class: 'btn small', type: 'button', onclick: () => act({ action: 'music-stop', room: r.name }, 'Müzik durduruldu') }, 'Müziği durdur'),
              el(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  onclick: () => {
                    const text = prompt(`"${r.name}" kanalına duyuru:`);
                    if (text && text.trim()) act({ action: 'announce', room: r.name, text: text.trim() }, 'Duyuru gönderildi');
                  },
                },
                'Duyuru'
              ),
              r.chatCount > 0 &&
                el(
                  'button',
                  {
                    class: 'btn small',
                    type: 'button',
                    onclick: () => act({ action: 'chat-clear', room: r.name }, 'Sohbet temizlendi', `"${r.name}" sohbeti ve paylaşılan dosyalar silinsin mi?`),
                  },
                  'Sohbeti temizle'
                ),
              el(
                'button',
                { class: 'btn small', type: 'button', onclick: () => act({ action: 'lock', room: r.name, locked: !r.locked }, r.locked ? 'Kilit açıldı' : 'Kanal kilitlendi') },
                r.locked ? 'Kilidi aç' : 'Kilitle'
              ),
              el(
                'button',
                {
                  class: 'btn small danger',
                  type: 'button',
                  onclick: () => act({ action: 'close-room', room: r.name }, 'Kanal kapatıldı', `"${r.name}" kapatılsın mı? İçindeki herkes çıkarılır.`),
                },
                'Kanalı kapat'
              )
            )
          ),
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ...['Kişi', 'Durum', 'IP', 'Cihaz', 'Süre', 'Bağlantılar', 'Etkinlik', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...r.members.map((m) => memberRow(r, m)))
          )
        )
      )
    );
  }

  function renderBans() {
    const box = $('#bans');
    if (!state.bans.length) return box.replaceChildren(el('div', { class: 'none' }, 'Yasaklı IP yok.'));
    box.replaceChildren(
      ...state.bans.map((b) =>
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'mono' }, b.ip),
          el('span', { class: 'sub' }, (b.until ? `${dur((b.until - state.now) / 1000)} kaldı` : 'kalıcı') + (b.reason ? ` · ${b.reason}` : '') + ` · ${b.by}`),
          el('span', { style: 'flex:1' }),
          el('button', { class: 'btn small', type: 'button', onclick: () => act({ action: 'unban', ip: b.ip }, 'Yasak kaldırıldı', `${b.ip} yasağı kaldırılsın mı?`) }, 'Kaldır')
        )
      )
    );
  }

  function renderEvents() {
    const show = new Set([...document.querySelectorAll('.log-filter input:checked')].map((i) => i.dataset.type));
    const items = state.events.filter((e) => show.has(e.type));
    $('#events').replaceChildren(
      ...(items.length ? items.map((e) => el('li', { class: 't-' + e.type }, el('time', {}, clock(e.ts)), el('span', {}, e.text))) : [el('li', { class: 'none' }, 'Olay yok.')])
    );
  }

  function render() {
    renderStats();
    renderRooms();
    renderBans();
    renderEvents();
  }

  // ---- yasaklama penceresi ----
  function openBan(room, m) {
    banTarget = { room: room.name, id: m.id, name: m.name };
    $('#ban-name').textContent = m.name;
    $('#ban-ip').textContent = m.ip;
    $('#ban-reason').value = '';
    $('#ban-dialog').showModal();
  }

  // ---- yenileme ----
  async function refresh() {
    clearTimeout(pollTimer);
    try {
      state = await api('state');
      lastOk = Date.now();
      showApp();
      render();
      $('#live').className = 'live';
      $('#live').textContent = '● Canlı';
    } catch (err) {
      if ($('#login-view').hidden === false) return;
      $('#live').className = 'live down';
      $('#live').textContent = '● Bağlantı yok';
    }
    if (!document.hidden && $('#login-view').hidden) pollTimer = setTimeout(refresh, POLL_MS);
  }

  // ---- olaylar ----
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('login', { user: $('#l-user').value, pass: $('#l-pass').value });
      $('#l-pass').value = '';
      refresh();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  $('#logout').onclick = async () => {
    await api('logout', {}).catch(() => {});
    showLogin();
  };
  $('#search').addEventListener('input', () => state && renderRooms());
  for (const cb of document.querySelectorAll('.log-filter input')) cb.addEventListener('change', () => state && renderEvents());
  $('#announce-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#announce-text').value.trim();
    if (!text) return;
    const room = $('#announce-room').value;
    act({ action: 'announce', room, text }, 'Duyuru gönderildi', room ? null : `Duyuru TÜM kanallara gönderilsin mi?\n\n${text}`).then(() => ($('#announce-text').value = ''));
  });
  $('#ban-dialog').addEventListener('close', () => {
    if ($('#ban-dialog').returnValue !== 'ok' || !banTarget) return;
    act({ action: 'ban', room: banTarget.room, id: banTarget.id, minutes: Number($('#ban-minutes').value), reason: $('#ban-reason').value.trim() }, `${banTarget.name} yasaklandı`);
  });
  // Sekme gizliyken yenilemeyi durdur, geri gelince hemen yenile
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('#login-view').hidden) refresh();
  });
  // Bayat veri uyarısı
  setInterval(() => {
    if (lastOk && Date.now() - lastOk > 6000 && $('#live').className === 'live') {
      $('#live').className = 'live stale';
      $('#live').textContent = '● Gecikmeli';
    }
  }, 1000);

  // Açılışta: oturum varsa panel, yoksa giriş
  api('state')
    .then((s) => {
      state = s;
      showApp();
      render();
      lastOk = Date.now();
      pollTimer = setTimeout(refresh, POLL_MS);
    })
    .catch(() => showLogin());
})();
