'use strict';
/*
 * Yankı istemcisi.
 *
 * Mimari:
 *  - WebSocket (/ws) yalnızca sinyal içindir: oda üyeliği + WebRTC SDP/ICE mesajları.
 *  - Ses, her oyuncu çifti arasında doğrudan WebRTC ile akar (mesh).
 *  - Dayanıklılık:
 *      * WebSocket koparsa üstel geri çekilmeyle yeniden bağlanır, aynı kimlikle odaya döner.
 *        Bu sırada mevcut P2P ses bağlantıları kesilmez.
 *      * Her eş bağlantısını bir "bekçi" izler; bağlantı koparsa / kurulamazsa sıfırdan yeniden kurar.
 *      * Her bağlantının bir oturum kimliği (sid) vardır; eski oturumlara ait gecikmiş mesajlar yok sayılır.
 *      * Çakışmalar "perfect negotiation" kalıbıyla çözülür. Kimliği küçük olan taraf teklifi başlatır.
 */
(() => {
  const $ = (s) => document.querySelector(s);

  const SPEAK_DB = -50; // konuşma göstergesi eşiği (dBFS)
  const GATE_OFF = -80; // eşik bu değerdeyse kapalı kabul edilir
  const GATE_HOLD_MS = 400; // ses eşiğin altına düştükten sonra mikrofonun açık kalma süresi
  // Otomatik eşik, ses seviyesine değil RNNoise'un "bu konuşma mı" olasılığına (VAD) bakar;
  // böylece mikrofon kazancı (AGC) değişse de çalışır. Ölçümlerde (test/noise.test.js)
  // konuşmanın ~%97'si geçerken oyun sesi kalıntısı kesildi. Kısa patlama efektleri
  // açmasın diye koşulun art arda 2 ölçümde (~40 ms) sağlanması gerekir.
  const AUTO_GATE_VAD = 0.9;
  const AUTO_GATE_MIN_DB = -55;
  const AUTO_GATE_FRAMES = 2;

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('rv:' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('rv:' + k, JSON.stringify(v));
      } catch {}
    },
  };

  function randomId(n = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => chars[b % chars.length]).join('');
  }

  const now = () => performance.now();
  const FORCE_RELAY = new URLSearchParams(location.search).has('relay');

  const S = {
    id: randomId(),
    room: '',
    name: '',
    joined: false, // kullanıcı odada mı (UI açısından)
    welcomed: false, // sunucu en az bir kez kabul etti mi
    ws: null,
    wsAttempt: 0,
    wsTimer: null,
    pingTimer: null,
    pingSentAt: 0,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    ctx: null,
    rawStream: null, // mikrofondan gelen ham akış
    rawTrack: null,
    stream: null, // gönderilen akış (ham ya da gürültüsü temizlenmiş)
    track: null,
    aiNs: store.get('aiNs', true),
    aiActive: false,
    procSrc: null,
    procDest: null,
    rnnoiseReady: null,
    clockOffset: 0, // sunucu saati - yerel saat (ms)
    music: { queue: [], current: null, history: [], loop: 'off', search: false },
    musicVol: store.get('musicVol', 35),
    player: null, // çalan oynatıcı (YouTube ya da SoundCloud)
    playerCreating: null,
    playerCreatingKind: null,
    playKey: null, // oynatıcıya yüklenen şarkının çalma kimliği
    endSent: false,
    durReported: { key: null, d: 0 },
    startTimer: null,
    musicOff: store.get('musicOff', false), // müzik sadece bu kişide kapalı (internet harcamaz)
    analysisTrack: null,
    meterSrc: null,
    meterNode: null,
    meterReady: null,
    level: -100,
    muted: store.get('muted', false),
    deafened: false,
    mutedBeforeDeafen: false,
    mode: store.get('mode', 'vad'),
    pttKey: store.get('pttKey', 'KeyV'),
    pttLabel: store.get('pttLabel', 'V'),
    pttDown: false,
    gate: store.get('gate', GATE_OFF), // elle ayarlanan eşik
    autoGate: store.get('autoGate', true),
    gateRun: 0,
    gateOpenUntil: 0,
    micId: store.get('micId', ''),
    outId: store.get('outId', ''),
    ns: store.get('ns', true),
    ec: store.get('ec', true),
    agc: store.get('agc', true),
    peers: new Map(),
    selfEl: null,
    screen: null, // kendi ekran paylaşımım: { stream, video, audio }
    cam: null, // kendi kameram: { stream, track }
    camId: store.get('camId', ''),
    transmitting: false,
    uploadMaxMB: 25,
  };
  window.__rv = S; // hata ayıklama / testler için

  // =====================================================================
  // UI yardımcıları
  // =====================================================================
  let toastTimer;
  function toast(text, ms = 2600) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  function setConn(kind, text) {
    const el = $('#conn-status');
    el.className = 'conn-status ' + kind;
    el.textContent = '● ' + text;
  }

  function banner(html, actions) {
    const b = $('#banner');
    if (!html) {
      b.hidden = true;
      b.innerHTML = '';
      return;
    }
    b.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = html;
    b.appendChild(span);
    for (const [label, fn] of actions || []) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = label;
      btn.onclick = fn;
      b.appendChild(btn);
    }
    b.hidden = false;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }

  // =====================================================================
  // Sohbet: gruplanmış mesajlar, biçimlendirme, @bahsetme, tepkiler, dosyalar
  // =====================================================================
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💯', '🙏', '😡', '✅'];
  const QUICK_REACTS = ['👍', '❤️', '😂', '🔥'];
  const EMOJIS = [
    '😀', '😂', '🤣', '😅', '😊', '😍', '😘', '😎', '🤔', '🙄', '😏', '😴', '😭', '😡', '🤯', '🥶',
    '🥳', '😇', '🤡', '💀', '👻', '🤖', '👀', '🙈', '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🫡',
    '❤️', '💔', '🔥', '💯', '✨', '🎉', '🎮', '🏆', '⚔️', '🛡️', '🎯', '🍕', '🍺', '☕', '✅', '❌',
  ];
  const GROUP_MS = 5 * 60 * 1000;
  const MAX_FILES = 10;
  const chat = {
    msgs: new Map(), // id -> { m, el }
    last: null, // son mesaj grubu: { from, ts, group }
    unread: 0,
    stuck: true, // kaydırma en altta mı
    typers: new Map(), // id -> { name, until }
    typingSentAt: 0,
    pending: [], // gönderilmeyi bekleyen ekler
    sending: false,
    mention: null, // { start, query, items, sel }
    welcomeHtml: '',
    hidden: store.get('chatHidden', false),
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const reEsc = (s) => s.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&');
  const lower = (s) => String(s).toLocaleLowerCase('tr-TR');

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function fmtStamp(ts) {
    const d = new Date(ts);
    const t = fmtTime(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Bugün ' + t;
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Dün ' + t;
    return d.toLocaleDateString('tr-TR') + ' ' + t;
  }

  /** Kanalda bilinen isimler (bahsetme vurgusu ve önerileri için) */
  function knownNames() {
    const names = new Set([S.name]);
    for (const p of S.peers.values()) names.add(p.name);
    names.delete('');
    return [...names];
  }
  const nameOf = (id) => (id === S.id ? S.name : (S.peers.get(id) || {}).name || 'ayrılan biri');

  /** Discord benzeri biçimlendirme. Önce her şey kaçırılır; kod ve linkler yer tutucuyla korunur. */
  function formatText(text) {
    const slots = [];
    const keep = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000';
    let s = String(text).replace(/\u0000/g, '');
    s = s.replace(/```(?:[a-z0-9+#-]*\n)?([\s\S]*?)```/gi, (_, code) => keep('<pre><code>' + esc(code.replace(/^\n+|\n+$/g, '')) + '</code></pre>'));
    s = s.replace(/`([^`\n]+)`/g, (_, code) => keep('<code>' + esc(code) + '</code>'));
    s = s.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (url) => {
      const tail = (url.match(/[.,;:!?)*_~|]+$/) || [''])[0];
      const u = tail ? url.slice(0, -tail.length) : url;
      return keep('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>') + tail;
    });
    s = esc(s)
      .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" title="Göstermek için tıkla">$1</span>')
      .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
      .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
      .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1<i>$2</i>')
      .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');
    const alts = knownNames()
      .concat(['herkes', 'everyone'])
      .sort((a, b) => b.length - a.length)
      .map((n) => reEsc(esc(n)));
    s = s.replace(new RegExp('@(' + alts.join('|') + ')(?![\\wçğıöşüÇĞİÖŞÜ])', 'gi'), (all, n) => {
      const me = /^(herkes|everyone)$/i.test(n) || lower(n) === lower(esc(S.name));
      return '<span class="mention' + (me ? ' me' : '') + '">@' + n + '</span>';
    });
    s = s.replace(/\n/g, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  }

  function mentionsMe(m) {
    if (!m.text || m.from === S.id || !S.name) return false;
    const re = new RegExp('@(' + reEsc(S.name) + '|herkes|everyone)(?![\\wçğıöşüÇĞİÖŞÜ])', 'i');
    return re.test(m.text);
  }

  const atBottom = () => {
    const log = $('#chat-log');
    return log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  };
  function scrollChatBottom() {
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
    chat.stuck = true;
    $('#jump-new').hidden = true;
  }

  function trimLog() {
    const log = $('#chat-log');
    while (log.children.length > 400) {
      const first = log.firstElementChild;
      if (chat.last && chat.last.group === first) chat.last = null;
      for (const el of first.querySelectorAll('.msg')) chat.msgs.delete(el.dataset.id);
      first.remove();
    }
  }

  /** Mesaj geldi: en alttaysa kaydır, değilse "yeni mesajlar" düğmesini göster */
  function afterAppend(stick, own, quiet) {
    trimLog();
    if (stick || own) scrollChatBottom();
    else if (!quiet) $('#jump-new').hidden = false;
  }

  function bumpUnread() {
    if (!chat.hidden) return;
    chat.unread++;
    const b = $('#chat-badge');
    b.textContent = chat.unread > 99 ? '99+' : chat.unread;
    b.hidden = false;
  }

  const SYS_ICONS = { join: 'arrow-right', leave: 'arrow-left', music: 'music', admin: 'megaphone', info: 'info' };
  /** Sistem satırı: katıldı, ayrıldı, müzik olayları, duyurular */
  function sysLine(text, kind = 'info', ts = Date.now()) {
    const log = $('#chat-log');
    const stick = atBottom();
    const div = document.createElement('div');
    div.className = 'sys-line sys-' + kind;
    const ic = document.createElement('span');
    ic.className = 'sys-ic';
    ic.innerHTML = svgIcon(SYS_ICONS[kind] || 'info');
    const tx = document.createElement('span');
    // Baştaki emoji yerine satırın kendi simgesi kullanılır
    tx.textContent = String(text).replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '') || text;
    const tm = document.createElement('time');
    tm.textContent = fmtTime(ts);
    tm.title = fmtStamp(ts);
    div.append(ic, tx, tm);
    log.appendChild(div);
    chat.last = null; // sistem satırı mesaj gruplarını böler
    afterAppend(stick, false, true);
  }

  /** Eski arayüzle uyumlu kısa yol */
  function chatAppend(name, text, ts, sys) {
    if (!sys) return renderMessage({ id: randomId(8), from: '', name, text, ts: ts || Date.now(), files: [], reactions: {} });
    sysLine(text, /katıldı/.test(text) ? 'join' : /ayrıldı/.test(text) ? 'leave' : 'info', ts || Date.now());
  }

  function renderMessage(m, hist) {
    if (m.admin) return sysLine('Yönetici: ' + m.text, 'admin', m.ts);
    if (chat.msgs.has(m.id)) return;
    const log = $('#chat-log');
    const stick = atBottom();
    const own = m.from === S.id;
    let group;
    const last = chat.last;
    if (last && last.from === m.from && m.from && m.ts - last.ts < GROUP_MS && last.group.isConnected) {
      group = last.group;
    } else {
      group = document.createElement('div');
      group.className = 'msg-group';
      const hue = avatarHue(m.name);
      const av = document.createElement('div');
      av.className = 'mg-av';
      av.style.background = 'hsl(' + hue + ' 55% 45%)';
      av.textContent = (m.name || '?').trim().charAt(0).toUpperCase();
      const body = document.createElement('div');
      body.className = 'mg-body';
      const head = document.createElement('div');
      head.className = 'mg-head';
      const nm = document.createElement('span');
      nm.className = 'mg-name';
      nm.style.color = 'hsl(' + hue + ' 70% 72%)';
      nm.textContent = m.name;
      nm.title = 'Bahsetmek için tıkla';
      nm.style.cursor = 'pointer';
      nm.onclick = () => insertAtCaret('@' + m.name + ' ');
      const tm = document.createElement('time');
      tm.textContent = fmtStamp(m.ts);
      head.append(nm, tm);
      body.appendChild(head);
      group.append(av, body);
      log.appendChild(group);
    }
    chat.last = { from: m.from, ts: m.ts, group };

    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.id = m.id;
    const ht = document.createElement('span');
    ht.className = 'msg-hover-time';
    ht.textContent = fmtTime(m.ts);
    ht.title = fmtStamp(m.ts);
    el.appendChild(ht);
    if (m.text) {
      const tx = document.createElement('div');
      tx.className = 'msg-text';
      tx.innerHTML = formatText(m.text);
      el.appendChild(tx);
    }
    if (m.files && m.files.length) el.appendChild(renderFiles(m.files));
    const reacts = document.createElement('div');
    reacts.className = 'msg-reacts';
    el.appendChild(reacts);
    if (m.from) el.appendChild(msgTools(m));
    const me = mentionsMe(m);
    if (me) el.classList.add('mention-me');
    group.querySelector('.mg-body').appendChild(el);
    chat.msgs.set(m.id, { m, el });
    renderReactions(m.id);
    afterAppend(stick, own && !hist, !!hist);
    if (!hist && !own) {
      bumpUnread();
      if (me) {
        beep([880, 1320], 0.07, 0.1);
        if (chat.hidden || document.hidden) toast('💬 ' + m.name + ' senden bahsetti', 4000);
      }
    }
  }

  function removeMessage(id) {
    const it = chat.msgs.get(id);
    if (!it) return;
    chat.msgs.delete(id);
    const group = it.el.closest('.msg-group');
    it.el.remove();
    if (group && !group.querySelector('.msg')) {
      if (chat.last && chat.last.group === group) chat.last = null;
      group.remove();
    }
  }

  function renderReactions(id) {
    const it = chat.msgs.get(id);
    if (!it) return;
    const box = it.el.querySelector('.msg-reacts');
    box.innerHTML = '';
    const r = it.m.reactions || {};
    for (const emoji of REACTIONS) {
      const ids = r[emoji];
      if (!ids || !ids.length) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'react' + (ids.includes(S.id) ? ' mine' : '');
      b.innerHTML = '<span>' + emoji + '</span><span>' + ids.length + '</span>';
      b.title = ids.map(nameOf).join(', ') + ' ' + emoji + ' ile tepki verdi';
      b.onclick = () => wsSend({ t: 'chat-react', id, emoji });
      box.appendChild(b);
    }
  }

  function msgTools(m) {
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    for (const emoji of QUICK_REACTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.title = emoji + ' tepkisi';
      b.onclick = () => wsSend({ t: 'chat-react', id: m.id, emoji });
      tools.appendChild(b);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.innerHTML = svgIcon('smile');
    more.title = 'Tepki ekle';
    more.onclick = (e) => {
      e.stopPropagation();
      tools.classList.add('open');
      openEmojiPop(more, REACTIONS, (emoji) => wsSend({ t: 'chat-react', id: m.id, emoji }), true, () => tools.classList.remove('open'));
    };
    tools.appendChild(more);
    if (m.from === S.id) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.innerHTML = svgIcon('trash');
      del.title = 'Mesajı sil';
      del.onclick = (e) => {
        if (e.shiftKey || confirm('Bu mesaj' + (m.files && m.files.length ? ' ve ekleri' : '') + ' herkesten silinsin mi?')) wsSend({ t: 'chat-delete', id: m.id });
      };
      tools.appendChild(del);
    }
    return tools;
  }

  // ---- ekler
  function renderFiles(files) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-files';
    const imgs = files.filter((f) => f.kind === 'image');
    if (imgs.length) {
      const n = imgs.length === 1 ? 1 : imgs.length === 2 || imgs.length === 4 ? 2 : 3;
      const grid = document.createElement('div');
      grid.className = 'att-grid n' + n;
      for (const f of imgs) grid.appendChild(attImage(f));
      wrap.appendChild(grid);
    }
    for (const f of files) {
      if (f.kind === 'video') wrap.appendChild(attVideo(f));
      else if (f.kind === 'audio') wrap.appendChild(attFile(f, true));
      else if (f.kind !== 'image') wrap.appendChild(attFile(f, false));
    }
    return wrap;
  }

  function attGone(f) {
    const d = document.createElement('div');
    d.className = 'att-gone';
    d.textContent = (f.name || 'Dosya') + ' artık mevcut değil (süresi doldu)';
    return d;
  }

  function attImage(f) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'att-img';
    b.title = f.name;
    const img = document.createElement('img');
    img.alt = f.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    if (f.w && f.h) {
      img.width = f.w;
      img.height = f.h;
    }
    img.onload = () => chat.stuck && scrollChatBottom();
    img.onerror = () => b.replaceWith(attGone(f));
    img.src = f.url;
    b.appendChild(img);
    b.onclick = () => openLightbox(f);
    return b;
  }

  function attVideo(f) {
    const v = document.createElement('video');
    v.className = 'att-video';
    v.controls = true;
    v.preload = 'metadata';
    v.src = f.url;
    v.onloadedmetadata = () => chat.stuck && scrollChatBottom();
    v.onerror = () => v.replaceWith(attGone(f));
    return v;
  }

  function attFile(f, audio) {
    const a = document.createElement(audio ? 'div' : 'a');
    a.className = 'att-file' + (audio ? ' audio' : '');
    if (!audio) {
      a.href = f.url;
      a.download = f.name;
      a.title = 'İndir: ' + f.name;
    }
    a.innerHTML = svgIcon('file') + '<div class="af-info"><span class="af-name"></span><span class="af-size"></span></div>' + (audio ? '' : svgIcon('download'));
    const nm = a.querySelector('.af-name');
    nm.textContent = f.name;
    a.querySelector('.af-size').textContent = fmtSize(f.size);
    if (audio) {
      const link = document.createElement('a');
      link.className = 'af-name';
      link.href = f.url;
      link.download = f.name;
      link.textContent = f.name;
      nm.replaceWith(link);
      const au = document.createElement('audio');
      au.controls = true;
      au.preload = 'none';
      au.src = f.url;
      a.appendChild(au);
    }
    return a;
  }

  function openLightbox(f) {
    const lb = $('#lightbox');
    $('#lb-img').src = f.url;
    $('#lb-img').alt = f.name;
    $('#lb-name').textContent = f.name + ' · ' + fmtSize(f.size);
    $('#lb-open').href = f.url;
    lb.hidden = false;
  }
  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lb-img').removeAttribute('src');
  }

  // ---- emoji / tepki seçici
  let emojiClose = null;
  function openEmojiPop(anchor, list, onPick, reactMode, onClose) {
    closeEmojiPop();
    const pop = $('#emoji-pop');
    pop.innerHTML = '';
    pop.classList.toggle('react-mode', !!reactMode);
    for (const e of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = () => {
        onPick(e);
        if (reactMode) closeEmojiPop();
      };
      pop.appendChild(b);
    }
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    emojiClose = onClose || null;
  }
  function closeEmojiPop() {
    const pop = $('#emoji-pop');
    if (pop.hidden) return;
    pop.hidden = true;
    if (emojiClose) emojiClose();
    emojiClose = null;
  }

  // ---- mesaj kutusu
  function autoGrow() {
    const ta = $('#chat-input');
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function insertAtCaret(text) {
    const ta = $('#chat-input');
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
    autoGrow();
  }

  function onComposerInput() {
    autoGrow();
    const ta = $('#chat-input');
    const t = ta.value;
    if (t.trim() && !t.startsWith('/') && Date.now() - chat.typingSentAt > 2500) {
      chat.typingSentAt = Date.now();
      wsSend({ t: 'typing' });
    }
    updateMention();
  }

  function updateMention() {
    const ta = $('#chat-input');
    const before = ta.value.slice(0, ta.selectionStart);
    const mm = before.match(/(^|\s)@([^\s@]{0,24})$/);
    if (!mm) return hideMention();
    const q = lower(mm[2]);
    const items = knownNames()
      .filter((n) => n !== S.name)
      .concat(['herkes'])
      .filter((n) => lower(n).startsWith(q))
      .slice(0, 8);
    if (!items.length) return hideMention();
    const prevSel = chat.mention ? chat.mention.sel : 0;
    chat.mention = { start: before.length - mm[2].length - 1, items, sel: Math.min(prevSel, items.length - 1) };
    renderMention();
  }

  function renderMention() {
    const pop = $('#mention-pop');
    const m = chat.mention;
    pop.innerHTML = '<div class="mp-title">Kişiler</div>';
    m.items.forEach((n, i) => {
      const o = document.createElement('div');
      o.className = 'mention-opt' + (i === m.sel ? ' sel' : '');
      o.setAttribute('role', 'option');
      const av = document.createElement('span');
      av.className = 'avatar-sm';
      av.style.cssText = 'display:grid;place-items:center;border-radius:50%;color:#fff;font-size:12px;font-weight:700;background:' + (n === 'herkes' ? 'var(--accent)' : 'hsl(' + avatarHue(n) + ' 55% 45%)');
      av.textContent = n === 'herkes' ? '@' : n.charAt(0).toUpperCase();
      const label = document.createElement('span');
      label.textContent = n;
      const small = document.createElement('small');
      small.textContent = n === 'herkes' ? 'kanaldaki herkes' : '';
      o.append(av, label, small);
      o.onmousedown = (e) => {
        e.preventDefault();
        m.sel = i;
        applyMention();
      };
      pop.appendChild(o);
    });
    pop.hidden = false;
  }

  function hideMention() {
    chat.mention = null;
    $('#mention-pop').hidden = true;
  }

  function applyMention() {
    const m = chat.mention;
    if (!m) return;
    const ta = $('#chat-input');
    const end = ta.selectionStart;
    const ins = '@' + m.items[m.sel] + ' ';
    ta.value = ta.value.slice(0, m.start) + ins + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = m.start + ins.length;
    hideMention();
    autoGrow();
    ta.focus();
  }

  function onComposerKey(e) {
    const m = chat.mention;
    if (m) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        m.sel = (m.sel + (e.key === 'ArrowDown' ? 1 : -1) + m.items.length) % m.items.length;
        return renderMention();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return applyMention();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return hideMention();
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    } else if (e.key === 'Escape' && chat.pending.length && !chat.sending) {
      clearPending();
    }
  }

  // ---- dosya ekleme / yükleme
  function addFiles(list, pasted) {
    if (!S.joined) return;
    const max = (S.uploadMaxMB || 25) * 1048576;
    let added = 0;
    for (const f of list) {
      if (chat.pending.length >= MAX_FILES) {
        toast('Bir mesajda en fazla ' + MAX_FILES + ' dosya gönderebilirsin.');
        break;
      }
      if (!f.size) continue;
      if (f.size > max) {
        toast(f.name + ' çok büyük (en fazla ' + S.uploadMaxMB + ' MB).', 4000);
        continue;
      }
      let name = f.name || 'dosya';
      if (pasted && /^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
        const d = new Date();
        const p2 = (x) => String(x).padStart(2, '0');
        name = 'ekran-goruntusu-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.' + name.split('.').pop();
      }
      const p = { file: f, name, size: f.size, type: f.type || 'application/octet-stream', url: null, w: 0, h: 0, progress: 0, info: null, error: false };
      if (/^image\//.test(f.type)) {
        p.url = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => {
          p.w = im.naturalWidth;
          p.h = im.naturalHeight;
        };
        im.src = p.url;
      }
      chat.pending.push(p);
      added++;
    }
    if (added) {
      if (chat.hidden) setChatHidden(false);
      renderTray();
      $('#chat-input').focus();
    }
  }

  function renderTray() {
    const tray = $('#attach-tray');
    tray.innerHTML = '';
    tray.hidden = chat.pending.length === 0;
    for (const p of chat.pending) {
      const it = document.createElement('div');
      it.className = 'tray-item' + (p.error ? ' error' : '');
      const th = document.createElement('div');
      th.className = 'tray-thumb';
      if (p.url) {
        const img = document.createElement('img');
        img.src = p.url;
        img.alt = '';
        th.appendChild(img);
      } else th.innerHTML = svgIcon('file');
      const nm = document.createElement('div');
      nm.className = 'tray-name';
      nm.textContent = p.name;
      nm.title = p.name;
      const sz = document.createElement('div');
      sz.className = 'tray-size';
      sz.textContent = p.error ? 'Yüklenemedi' : fmtSize(p.size);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'tray-rm';
      rm.title = 'Kaldır';
      rm.innerHTML = svgIcon('trash');
      rm.disabled = chat.sending;
      rm.onclick = () => {
        if (p.url) URL.revokeObjectURL(p.url);
        chat.pending.splice(chat.pending.indexOf(p), 1);
        renderTray();
      };
      it.append(th, nm, sz, rm);
      if (chat.sending && !p.info) {
        const bar = document.createElement('div');
        bar.className = 'tray-bar';
        bar.innerHTML = '<i></i>';
        bar.firstChild.style.width = Math.round(p.progress * 100) + '%';
        p.bar = bar.firstChild;
        it.appendChild(bar);
      }
      tray.appendChild(it);
    }
  }

  function clearPending() {
    for (const p of chat.pending) if (p.url) URL.revokeObjectURL(p.url);
    chat.pending = [];
    renderTray();
  }

  function uploadFile(p) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ k: S.streamToken || '', name: p.name });
      if (p.w && p.h) {
        q.set('w', p.w);
        q.set('h', p.h);
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload?' + q);
      xhr.setRequestHeader('Content-Type', p.type);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        p.progress = e.loaded / e.total;
        if (p.bar) p.bar.style.width = Math.round(p.progress * 100) + '%';
      };
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200 && body && body.id) return resolve(body);
        const msg = (body && body.error) || (xhr.status === 413 ? 'Dosya çok büyük.' : 'Yükleme başarısız (' + xhr.status + ').');
        reject(new Error(p.name + ': ' + msg));
      };
      xhr.onerror = () => reject(new Error(p.name + ': bağlantı hatası, yüklenemedi.'));
      xhr.send(p.file);
    });
  }

  async function sendChat() {
    if (chat.sending) return;
    const ta = $('#chat-input');
    const text = ta.value.trim();
    if (text.startsWith('/') && !chat.pending.length) {
      chatCommand(text);
      ta.value = '';
      autoGrow();
      return;
    }
    if (!text && !chat.pending.length) return;
    if (!S.ws || S.ws.readyState !== 1) return toast('Sunucuya bağlı değil, mesaj gönderilemedi.');
    hideMention();
    if (chat.pending.length) {
      chat.sending = true;
      ta.readOnly = true;
      $('#chat-form').classList.add('busy');
      renderTray();
      try {
        for (const p of chat.pending) {
          if (p.info) continue;
          p.error = false;
          try {
            p.info = await uploadFile(p);
          } catch (err) {
            p.error = true;
            throw err;
          }
        }
      } catch (err) {
        toast(err.message, 5000);
        return;
      } finally {
        chat.sending = false;
        ta.readOnly = false;
        $('#chat-form').classList.remove('busy');
        renderTray();
      }
    }
    if (!wsSend({ t: 'chat', text, files: chat.pending.map((p) => p.info.id) })) return toast('Sunucuya bağlı değil, mesaj gönderilemedi.');
    ta.value = '';
    autoGrow();
    clearPending();
    chat.typingSentAt = 0;
    ta.focus();
  }

  // ---- yazıyor…
  function onTyping(m) {
    chat.typers.set(m.from, { name: m.name, until: Date.now() + 4500 });
    renderTyping();
  }
  function renderTyping() {
    const t = Date.now();
    for (const [id, v] of chat.typers) if (v.until < t || !S.peers.has(id)) chat.typers.delete(id);
    const names = [...chat.typers.values()].map((v) => v.name);
    const box = $('#typing');
    box.classList.toggle('on', names.length > 0);
    const out = box.querySelector('.typing-text');
    out.innerHTML = '';
    if (!names.length) return;
    if (names.length > 3) return (out.textContent = 'Birkaç kişi yazıyor…');
    names.forEach((n, i) => {
      if (i) out.append(i === names.length - 1 ? ' ve ' : ', ');
      const b = document.createElement('b');
      b.textContent = n;
      out.appendChild(b);
    });
    out.append(' yazıyor…');
  }

  // ---- görünüm
  function setChatHidden(hidden) {
    chat.hidden = hidden;
    store.set('chatHidden', hidden);
    $('.stage').classList.toggle('chat-hidden', hidden);
    $('#chat-toggle').classList.toggle('active', !hidden);
    if (!hidden) {
      chat.unread = 0;
      $('#chat-badge').hidden = true;
      requestAnimationFrame(scrollChatBottom);
    }
  }

  function resetChat() {
    $('#chat-log').innerHTML = chat.welcomeHtml;
    chat.msgs.clear();
    chat.last = null;
    chat.unread = 0;
    chat.typers.clear();
    renderTyping();
    $('#chat-badge').hidden = true;
    $('#jump-new').hidden = true;
    hideMention();
    closeEmojiPop();
    closeLightbox();
  }

  function initChat() {
    chat.welcomeHtml = $('#chat-log').innerHTML;
    const ta = $('#chat-input');
    ta.addEventListener('input', onComposerInput);
    ta.addEventListener('keydown', onComposerKey);
    ta.addEventListener('click', updateMention);
    ta.addEventListener('blur', () => setTimeout(hideMention, 120));
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat();
    });
    $('#attach-btn').onclick = () => $('#file-input').click();
    $('#file-input').onchange = (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    };
    $('#emoji-btn').onclick = (e) => {
      e.stopPropagation();
      if (!$('#emoji-pop').hidden) return closeEmojiPop();
      openEmojiPop($('#emoji-btn'), EMOJIS, (em) => insertAtCaret(em), false);
    };
    $('#chat-log').addEventListener('scroll', () => {
      chat.stuck = atBottom();
      if (chat.stuck) $('#jump-new').hidden = true;
    });
    $('#chat-log').addEventListener('click', (e) => {
      const sp = e.target.closest('.spoiler');
      if (sp) sp.classList.add('shown');
    });
    $('#jump-new').onclick = scrollChatBottom;
    // Mesaj kutusu büyüyünce / ek eklenince / ayırıcı sürüklenince en altta kal
    if (window.ResizeObserver) new ResizeObserver(() => chat.stuck && scrollChatBottom()).observe($('#chat-log'));
    $('#chat-toggle').onclick = () => setChatHidden(!chat.hidden);
    setChatHidden(chat.hidden);

    // Yapıştırma (ekran görüntüsü), sürükle-bırak
    window.addEventListener('paste', (e) => {
      if (!S.joined || !e.clipboardData) return;
      const t = e.target;
      const elsewhere = t && t !== ta && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const files = [...e.clipboardData.files];
      if (!files.length || elsewhere) return;
      e.preventDefault();
      addFiles(files, true);
    });
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      if (S.joined) {
        if (chat.hidden) setChatHidden(false);
        $('#drop-max').textContent = S.uploadMaxMB;
        $('#drop-zone').hidden = false;
      }
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = S.joined ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      if (--dragDepth <= 0) {
        dragDepth = 0;
        $('#drop-zone').hidden = true;
      }
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $('#drop-zone').hidden = true;
      addFiles([...e.dataTransfer.files]);
    });

    // Görüşme / sohbet ayırıcısı
    const body = $('.stage-body');
    const sp = $('#splitter');
    const ratio = store.get('callRatio', 0.44);
    body.style.setProperty('--call-ratio', ratio);
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      const move = (ev) => {
        const r = body.getBoundingClientRect();
        const v = Math.max(0.15, Math.min(0.85, (ev.clientY - r.top) / r.height));
        body.style.setProperty('--call-ratio', v.toFixed(3));
      };
      const up = () => {
        sp.classList.remove('dragging');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        store.set('callRatio', Number(body.style.getPropertyValue('--call-ratio')) || 0.44);
        if (chat.stuck) scrollChatBottom();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('dblclick', () => setChatHidden(true));

    // Görsel büyütme ve açılır menüleri kapatma
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id !== 'lb-img' && e.target.id !== 'lb-open') closeLightbox();
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#emoji-pop')) closeEmojiPop();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#lightbox').hidden) closeLightbox();
      closeEmojiPop();
    });
    setInterval(renderTyping, 1000);
  }

  const svgIcon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;

  /** İsimden sabit bir avatar rengi (herkeste aynı) */
  function avatarHue(name) {
    let h = 0;
    for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }
  function paintAvatar(el, name) {
    const hue = avatarHue(name);
    el.style.setProperty('--av', `hsl(${hue} 60% 52%)`);
    el.style.setProperty('--av-bg', `hsl(${hue} 28% 20%)`);
  }

  function makeCard(name, isSelf) {
    const el = $('#participant-tpl').content.firstElementChild.cloneNode(true);
    el.querySelector('.initial').textContent = (name || '?').trim().charAt(0).toUpperCase();
    el.querySelector('.name').textContent = name;
    el.querySelector('.you').hidden = !isSelf;
    paintAvatar(el, name);
    // Sol paneldeki kişi listesi öğesi (Discord'daki sesli kanal altındaki liste gibi)
    const li = document.createElement('li');
    li.className = 'side-member';
    li.innerHTML =
      '<span class="avatar-sm"></span><span class="sm-name"></span><span class="sm-vol" hidden></span><span class="sm-icons"><span class="sm-mute" hidden>' +
      svgIcon('mic-off') + '</span><span class="sm-deaf" hidden>' + svgIcon('head-off') + '</span></span>' +
      (isSelf ? '' : '<button class="icon-btn small sm-more" type="button" title="Kullanıcı ayarları (ses seviyesi)">' + svgIcon('more') + '</button>');
    li.querySelector('.avatar-sm').textContent = (name || '?').trim().charAt(0).toUpperCase();
    li.querySelector('.sm-name').textContent = name;
    paintAvatar(li, name);
    if (isSelf) $('#side-members').prepend(li);
    else $('#side-members').appendChild(li);
    el.side = li;
    return el;
  }

  // ---- Kişi menüsü ----
  let menuPeer = null;

  function openMemberMenu(p, anchor) {
    if (menuPeer && menuPeer.el && menuPeer.el.side) menuPeer.el.side.classList.remove('menu-open');
    menuPeer = p;
    const m = $('#member-menu');
    m.querySelector('.mm-title').textContent = p.name;
    m.querySelector('.vol').value = p.volume;
    renderMemberMenu();
    m.hidden = false;
    if (p.el.side) p.el.side.classList.add('menu-open');
    if (window.innerWidth <= 760) {
      m.classList.add('sheet');
      return;
    }
    m.classList.remove('sheet');
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    let x = anchor.right + 8;
    if (x + w > window.innerWidth - 8) x = anchor.left - w - 8;
    let y = anchor.top;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    m.style.left = Math.max(8, x) + 'px';
    m.style.top = Math.max(8, y) + 'px';
  }

  function toggleMemberMenu(p, anchor) {
    if (menuPeer === p && !$('#member-menu').hidden) closeMemberMenu();
    else openMemberMenu(p, anchor);
  }

  function closeMemberMenu() {
    $('#member-menu').hidden = true;
    if (menuPeer && menuPeer.el && menuPeer.el.side) menuPeer.el.side.classList.remove('menu-open');
    menuPeer = null;
  }

  function renderMemberMenu() {
    const p = menuPeer;
    if (!p) return;
    const m = $('#member-menu');
    const v = m.querySelector('.vol-val');
    v.textContent = p.volume + '%';
    v.classList.toggle('boost', p.volume > 100);
    const lm = m.querySelector('.local-mute');
    lm.classList.toggle('on', p.localMuted);
    lm.querySelector('span').textContent = p.localMuted ? 'Susturmayı kaldır' : 'Bende sustur';
  }

  function setPeerVolume(p, v) {
    p.volume = v;
    store.set('vol:' + p.name, v);
    applyPeerAudio(p);
    renderSideVol(p);
    renderMemberMenu();
  }

  /** Soldaki listede varsayılandan farklı ses ayarını göster (ör. 150%, susturuldu) */
  function renderSideVol(p) {
    const el = p.el && p.el.side && p.el.side.querySelector('.sm-vol');
    if (!el) return;
    el.hidden = !p.localMuted && p.volume === 100;
    el.textContent = p.localMuted ? 'susturuldu' : p.volume + '%';
    el.classList.toggle('muted-local', p.localMuted);
  }

  // ---- Kutu düzeni: 16:9 kutular sahneyi dolduracak en büyük boyutta, ortalı ----
  function layoutTiles() {
    const box = $('#participants');
    if (!box || $('#room-view').hidden) return;
    if ($('.stage').classList.contains('focus')) return box.style.removeProperty('--tile-w');
    const n = box.children.length;
    if (!n) return;
    const cs = getComputedStyle(box);
    const W = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const gap = 8;
    const ratio = 16 / 9;
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * ratio);
      if (w > best) best = w;
    }
    // Çok küçülürse (çok kişi / dar ekran) en az bu genişlikte kalsın, sahne kaydırılır
    best = Math.max(best, Math.min(W, 180));
    box.style.setProperty('--tile-w', Math.floor(best) + 'px');
  }

  function renderSide(el, { name, muted, deafened, offline, sharing }) {
    const li = el && el.side;
    if (!li) return;
    if (name != null) {
      li.querySelector('.sm-name').textContent = name;
      li.querySelector('.avatar-sm').textContent = (name || '?').charAt(0).toUpperCase();
    }
    li.querySelector('.sm-mute').hidden = !muted || deafened;
    li.querySelector('.sm-deaf').hidden = !deafened;
    li.classList.toggle('offline', !!offline);
    li.classList.toggle('live', !!sharing);
  }

  function setCardStatus(el, kind, text) {
    const dot = el.querySelector('.dot');
    dot.className = 'dot ' + (kind || '');
    el.querySelector('.status-text').textContent = text;
  }

  function setSpeaking(el, on) {
    if (!el || el.classList.contains('speaking') === on) return;
    el.classList.toggle('speaking', on);
    if (el.side) el.side.classList.toggle('speaking', on);
    if (el === S.selfEl) $('.user-panel').classList.toggle('speaking', on);
  }

  function updateCount() {
    const n = S.peers.size + 1;
    $('#member-count').textContent = `${n} kişi`;
    // Kanalda tek başınaysa davet kartını öne çıkar
    $('#invite-btn').classList.toggle('alone', n === 1);
  }

  function renderSelf() {
    if (!S.selfEl) return;
    S.selfEl.querySelector('.i-mute').hidden = !(S.muted || S.deafened || !S.track);
    S.selfEl.querySelector('.i-deaf').hidden = !S.deafened;
    let text = 'Mikrofon açık';
    if (!S.track) text = 'Mikrofon yok (dinleyici)';
    else if (S.deafened) text = 'Ses kapalı';
    else if (S.muted) text = 'Mikrofon kapalı';
    else if (S.mode === 'ptt') text = `Bas-konuş (${S.pttLabel})`;
    if (S.track && S.aiActive) text += ' · AI gürültü engelleme';
    setCardStatus(S.selfEl, S.muted || S.deafened || !S.track ? 'bad' : 'ok', text);
    renderSide(S.selfEl, { muted: S.muted || !S.track, deafened: S.deafened, sharing: !!S.screen });

    // Sol alttaki kullanıcı paneli
    const up = $('#up-avatar');
    up.textContent = (S.name || '?').charAt(0).toUpperCase();
    paintAvatar(up, S.name);
    $('#up-name').textContent = S.name;
    $('#up-status').textContent = text;

    $('#mute-btn').classList.toggle('off', S.muted || S.deafened || !S.track);
    $('#mute-btn').title = (S.muted || S.deafened || !S.track ? 'Mikrofonu aç' : 'Mikrofonu kapat') + ' (M)';
    $('#deafen-btn').classList.toggle('off', S.deafened);
    $('#deafen-btn').title = (S.deafened ? 'Sesi aç' : 'Sesi kapat') + ' (D)';
  }

  function renderPeer(p) {
    if (!p.el) return;
    p.el.querySelector('.name').textContent = p.name;
    p.el.querySelector('.initial').textContent = (p.name || '?').charAt(0).toUpperCase();
    p.el.querySelector('.i-mute').hidden = !(p.muted || p.deafened);
    p.el.querySelector('.i-deaf').hidden = !p.deafened;
    p.el.classList.toggle('offline', !p.online);
    const st = p.pc ? p.pc.connectionState : 'none';
    if (st === 'connected') {
      let text = 'Bağlı';
      if (p.rtt != null) text += ` · ${p.rtt} ms`;
      if (p.relay) text += ' · röle';
      setCardStatus(p.el, 'ok', text);
      p.el.querySelector('.status-text').title = p.relay
        ? 'Doğrudan bağlantı kurulamadığı için ses TURN sunucusu üzerinden aktarılıyor.'
        : 'Doğrudan (P2P) bağlantı';
    } else if (!p.online) {
      setCardStatus(p.el, 'warn', 'Sunucuyla bağlantısı koptu…');
    } else if (st === 'disconnected' || st === 'failed') {
      setCardStatus(p.el, 'bad', 'Bağlantı koptu, yeniden kuruluyor…');
    } else if (p.attempts >= 2) {
      // Birkaç deneme başarısız: büyük ihtimalle iki taraftan birinin ağı doğrudan bağlantıya izin vermiyor.
      setCardStatus(p.el, 'bad', 'Bağlantı kurulamıyor (ağ kısıtlaması), deneniyor…');
      p.el.querySelector('.status-text').title =
        'Bu kişiyle aranızda doğrudan bağlantı kurulamıyor. Mobil hat, hotspot, VPN veya kurum ağı kullanılıyorsa olabilir. Sunucuda TURN ayarlıysa kısa sürede röle üzerinden bağlanır.';
    } else {
      setCardStatus(p.el, 'warn', 'Bağlanıyor…');
    }
    p.el.querySelector('.i-lmute').hidden = !p.localMuted;
    renderSideVol(p);
    if (menuPeer === p) renderMemberMenu();
    renderSide(p.el, { name: p.name, muted: p.muted, deafened: p.deafened, offline: !p.online, sharing: p.sharing });
    refreshCam(p);
  }

  // =====================================================================
  // Ses efektleri (oyundayken ekrana bakmadan olanları duymak için)
  // =====================================================================
  function beep(freqs, dur = 0.07, vol = 0.12) {
    if (!S.ctx || S.deafened) return;
    try {
      let t = S.ctx.currentTime;
      for (const f of freqs) {
        const o = S.ctx.createOscillator();
        const g = S.ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(vol, t + 0.01);
        g.gain.linearRampToValueAtTime(0, t + dur);
        o.connect(g).connect(S.ctx.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
        t += dur;
      }
    } catch {}
  }
  const sfx = {
    join: () => beep([660, 880]),
    leave: () => beep([700, 470]),
    mute: () => beep([380], 0.08),
    unmute: () => beep([760], 0.08),
  };

  // =====================================================================
  // Mikrofon
  // =====================================================================
  async function acquireMic() {
    const audio = {
      echoCancellation: S.ec,
      // Yapay zekâ gürültü engelleme açıkken tarayıcınınki kapatılır: ikisi üst üste
      // çalışınca RNNoise'un girdisi bozuluyor ve oyun sesi zamanla daha çok sızıyor (ölçüldü).
      noiseSuppression: S.ns && !S.aiNs,
      autoGainControl: S.agc,
      channelCount: 1,
    };
    if (S.micId) audio.deviceId = { exact: S.micId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (S.micId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        // Kayıtlı cihaz artık yok; varsayılana dön.
        S.micId = '';
        store.set('micId', '');
        delete audio.deviceId;
        return await navigator.mediaDevices.getUserMedia({ audio });
      }
      throw err;
    }
  }

  async function setMicStream(stream) {
    const oldRaw = S.rawStream;
    S.rawStream = stream;
    S.rawTrack = stream.getAudioTracks()[0] || null;
    if (S.rawTrack) S.rawTrack.onended = onMicEnded;
    await rebuildSendTrack();
    if (oldRaw && oldRaw !== stream) oldRaw.getTracks().forEach((t) => t.stop());
    renderSelf();
    refreshDevices();
  }

  /**
   * Gönderilecek izi kurar. Yapay zekâ gürültü engelleme açıksa mikrofon sesi önce
   * RNNoise'dan geçer: konuşma kalır; oyun sesi, müzik, klavye, fan büyük ölçüde silinir.
   * (Tarayıcının yankı engellemesi sadece tarayıcının çaldığı sesleri bilir; hoparlörden
   * gelen oyun sesini ancak bu şekilde bastırabiliriz.)
   */
  async function rebuildSendTrack() {
    const raw = S.rawTrack;
    let send = raw;
    S.aiActive = false;
    if (S.procSrc) {
      try {
        S.procSrc.disconnect();
      } catch {}
      S.procSrc = null;
    }
    if (raw && S.aiNs) {
      try {
        const node = await ensureRnnoise();
        S.procSrc = S.ctx.createMediaStreamSource(new MediaStream([raw]));
        S.procSrc.connect(node);
        send = S.procDest.stream.getAudioTracks()[0];
        S.aiActive = true;
      } catch (err) {
        console.warn('rnnoise', err);
        if (!S.aiWarned) {
          S.aiWarned = true;
          toast('Yapay zekâ gürültü engelleme başlatılamadı; normal mikrofon kullanılıyor.', 4000);
        }
      }
    }
    S.track = send;
    S.stream = send ? new MediaStream([send]) : null;
    for (const p of S.peers.values()) attachLocalTrack(p);
    applyTransmit();
    await setupMeter();
    renderSelf();
  }

  const WASM_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

  function ensureRnnoise() {
    if (!S.ctx || !S.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('AudioWorklet yok'));
    if (S.ctx.sampleRate !== 48000) return Promise.reject(new Error('RNNoise 48 kHz ister, ses bağlamı ' + S.ctx.sampleRate));
    if (!S.rnnoiseReady) {
      S.rnnoiseReady = (async () => {
        const simd = WebAssembly.validate(WASM_SIMD_PROBE);
        const [wasm] = await Promise.all([
          fetch(simd ? '/vendor/rnnoise/rnnoise_simd.wasm' : '/vendor/rnnoise/rnnoise.wasm').then((r) => {
            if (!r.ok) throw new Error('rnnoise wasm ' + r.status);
            return r.arrayBuffer();
          }),
          S.ctx.audioWorklet.addModule('/vendor/rnnoise/worklet.js'),
        ]);
        const node = new AudioWorkletNode(S.ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
          processorOptions: { maxChannels: 1, wasmBinary: wasm },
        });
        // Chrome, Web Audio'dan üretilen izde enabled=false'u göndericiye tam yansıtmıyor;
        // susturma/eşik için sesi bir kazanç düğümüyle gerçekten sıfırlıyoruz.
        S.sendGain = S.ctx.createGain();
        S.sendGain.gain.value = 0;
        S.procDest = S.ctx.createMediaStreamDestination();
        S.procDest.channelCount = 1;
        node.connect(S.sendGain).connect(S.procDest);
        S.rnnoiseNode = node;
        // Yamalı worklet ~21 ms'de bir RNNoise'un konuşma olasılığını (0-1) gönderir
        node.port.onmessage = (e) => {
          if (e.data && typeof e.data.vad === 'number') onVad(e.data.vad);
        };
        return node;
      })();
      S.rnnoiseReady.catch(() => (S.rnnoiseReady = null));
    }
    return S.rnnoiseReady;
  }

  let micRecovering = false;
  async function onMicEnded() {
    if (micRecovering || !S.joined) return;
    micRecovering = true;
    toast('Mikrofon bağlantısı kesildi, yeniden deneniyor…');
    for (let i = 0; i < 5 && S.joined; i++) {
      try {
        const st = await acquireMic();
        await setMicStream(st);
        toast('Mikrofon yeniden bağlandı');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    micRecovering = false;
  }

  async function switchMic() {
    try {
      const st = await acquireMic();
      await setMicStream(st);
    } catch (err) {
      toast('Mikrofon açılamadı: ' + micErrorText(err), 4000);
    }
  }

  function micErrorText(err) {
    if (!err) return 'bilinmeyen hata';
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      return 'Mikrofon izni verilmedi. Adres çubuğundaki kilit/mikrofon simgesinden izin verip tekrar deneyin.';
    if (err.name === 'NotFoundError') return 'Mikrofon bulunamadı.';
    if (err.name === 'NotReadableError') return 'Mikrofon başka bir uygulama tarafından kullanılıyor olabilir.';
    return err.message || String(err);
  }

  // ---- Seviye ölçer / ses eşiği ----
  async function setupMeter() {
    if (!S.ctx || !S.track) return;
    try {
      if (S.meterSrc && S.meterNode) {
        try {
          S.meterSrc.disconnect(S.meterNode);
        } catch {}
      }
      S.meterSrc = null;
      if (S.analysisTrack) S.analysisTrack.stop();
      S.analysisTrack = null;

      if (!S.meterNode) {
        if (!S.meterReady) {
          S.meterReady = (async () => {
            if (S.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
              await S.ctx.audioWorklet.addModule('/meter-worklet.js');
              const node = new AudioWorkletNode(S.ctx, 'meter');
              node.port.onmessage = (e) => onLevel(e.data);
              const sink = S.ctx.createGain();
              sink.gain.value = 0;
              node.connect(sink).connect(S.ctx.destination);
              return node;
            }
            // Yedek: AnalyserNode + zamanlayıcı
            const an = S.ctx.createAnalyser();
            an.fftSize = 1024;
            const buf = new Float32Array(an.fftSize);
            setInterval(() => {
              an.getFloatTimeDomainData(buf);
              let s = 0;
              for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
              onLevel(Math.sqrt(s / buf.length));
            }, 30);
            return an;
          })();
        }
        S.meterNode = await S.meterReady;
      }
      // Ölçüm, susturmadan ÖNCEKİ sinyalden yapılır ki eşik konuşmayı görüp tekrar açılabilsin.
      if (S.aiActive && S.rnnoiseNode) {
        S.meterSrc = S.rnnoiseNode; // gürültüsü temizlenmiş sinyal
      } else {
        // Ham iz susturulunca (enabled=false) sessizlik üretir; ölçüm için bağımsız bir kopya.
        S.analysisTrack = S.track.clone();
        S.analysisTrack.enabled = true;
        S.meterSrc = S.ctx.createMediaStreamSource(new MediaStream([S.analysisTrack]));
      }
      S.meterSrc.connect(S.meterNode);
    } catch (err) {
      console.warn('meter', err);
    }
  }

  function onLevel(rms) {
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    S.level = db;
    const auto = autoGateActive();
    const pass = auto ? S.vad >= AUTO_GATE_VAD && db >= AUTO_GATE_MIN_DB : db >= S.gate;
    S.gateRun = pass ? S.gateRun + 1 : 0;
    if (S.gateRun >= (auto ? AUTO_GATE_FRAMES : 1)) S.gateOpenUntil = now() + GATE_HOLD_MS;
    applyTransmit();
    const pct = Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
    const fill = $('#meter-fill');
    if (fill && $('#settings-dialog').open) {
      fill.style.width = pct + '%';
      const lv = $('#meter-val');
      if (lv) lv.textContent = db <= -99 ? '—' : Math.round(db) + ' dB';
    }
    setSpeaking(S.selfEl, S.transmitting && db > SPEAK_DB);
  }

  function onVad(p) {
    S.vad = p;
  }

  /** Şu an geçerli eşik (dB). Otomatik mod sadece yapay zekâ gürültü engelleme çalışırken devreye girer. */
  function effectiveGate() {
    if (S.autoGate) return S.aiActive ? AUTO_GATE_MIN_DB : GATE_OFF;
    return S.gate;
  }

  /** Otomatik (konuşma algılamalı) eşik sadece yapay zekâ gürültü engelleme çalışırken devrededir. */
  function autoGateActive() {
    return S.autoGate && S.aiActive;
  }

  function gateOpen() {
    if (autoGateActive()) return now() < S.gateOpenUntil;
    return S.gate <= GATE_OFF || now() < S.gateOpenUntil;
  }

  function applyTransmit() {
    const want = !!S.track && !S.muted && !S.deafened && (S.mode === 'ptt' ? S.pttDown : gateOpen());
    if (S.track && S.track.enabled !== want) S.track.enabled = want;
    if (S.sendGain) {
      const g = want && S.aiActive ? 1 : 0;
      if (S.sendGainTarget !== g) {
        S.sendGainTarget = g;
        // ~5 ms yumuşak geçiş: tık sesi olmasın
        S.sendGain.gain.setTargetAtTime(g, S.ctx.currentTime, 0.005);
      }
    }
    S.transmitting = want;
    if (!want) setSpeaking(S.selfEl, false);
  }

  // =====================================================================
  // Cihaz listeleri
  // =====================================================================
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const outs = devices.filter((d) => d.kind === 'audiooutput');

    const fill = (sel, list, current, defLabel) => {
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = defLabel;
      sel.appendChild(def);
      list.forEach((d, i) => {
        if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) return;
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Cihaz ${i + 1}`;
        sel.appendChild(o);
      });
      sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
    };
    fill($('#mic-select'), mics, S.micId, 'Sistem varsayılanı');
    fill($('#cam-select'), devices.filter((d) => d.kind === 'videoinput'), S.camId, 'Varsayılan kamera');
    fill($('#join-mic'), mics, S.micId, 'Sistem varsayılanı');
    const canSink = 'setSinkId' in HTMLMediaElement.prototype;
    $('#out-select').hidden = !canSink;
    $('#out-hint').hidden = canSink;
    if (canSink) fill($('#out-select'), outs, S.outId, 'Sistem varsayılanı');
  }

  function applyOutput() {
    for (const p of S.peers.values()) {
      if (p.audio && p.audio.setSinkId) p.audio.setSinkId(S.outId || '').catch(() => {});
    }
    if (S.ctx && S.ctx.setSinkId) S.ctx.setSinkId(S.outId || '').catch(() => {});
    if (S.player && S.player.setSink) S.player.setSink(S.outId);
  }

  // =====================================================================
  // Sinyal (WebSocket)
  // =====================================================================
  function wsSend(msg) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      try {
        S.ws.send(JSON.stringify(msg));
        return true;
      } catch {}
    }
    return false;
  }

  function connectWs() {
    clearTimeout(S.wsTimer);
    if (!S.joined) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    S.ws = ws;
    // Bağlantı 8 sn içinde açılmazsa vazgeç ve tekrar dene.
    const openTimeout = setTimeout(() => {
      if (S.ws === ws && ws.readyState !== WebSocket.OPEN) dropWs();
    }, 8000);

    ws.onopen = () => {
      clearTimeout(openTimeout);
      if (S.ws !== ws) return;
      wsSend({ t: 'join', room: S.room, id: S.id, name: S.name, muted: S.muted || !S.track, deafened: S.deafened, sharing: !!S.screen, camera: !!S.cam });
      startPing();
    };
    ws.onmessage = (e) => {
      if (S.ws !== ws) return;
      S.pingSentAt = 0; // herhangi bir mesaj bağlantının canlı olduğunu gösterir
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      try {
        onServerMessage(m);
      } catch (err) {
        console.error('mesaj işlenemedi', m && m.t, err);
      }
    };
    ws.onclose = (e) => {
      clearTimeout(openTimeout);
      if (S.ws !== ws) return;
      S.ws = null;
      stopPing();
      // Yönetici çıkardı (4001) ya da engelledi (4003): geri bağlanma
      if (e && (e.code === 4001 || e.code === 4003)) {
        onKicked(e.code === 4003 ? 'Bu sunucuya girişin yönetici tarafından engellendi.' : 'Yönetici tarafından kanaldan çıkarıldın.');
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function dropWs() {
    const ws = S.ws;
    S.ws = null;
    stopPing();
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!S.joined) return;
    clearTimeout(S.wsTimer);
    const delay = Math.min(8000, 400 * 2 ** S.wsAttempt) + Math.random() * 300;
    S.wsAttempt++;
    if (S.welcomed) {
      setConn('warn', 'Sunucuya yeniden bağlanılıyor…');
    } else if (S.wsAttempt > 1) {
      showJoinError('Sunucuya ulaşılamıyor, tekrar deneniyor…');
    }
    S.wsTimer = setTimeout(connectWs, delay);
  }

  function startPing() {
    stopPing();
    S.pingSentAt = 0;
    S.pingTimer = setInterval(() => {
      if (S.pingSentAt && now() - S.pingSentAt > 12000) {
        // Yanıt yok: bağlantı ölü, yenisini aç.
        dropWs();
        return;
      }
      if (!S.pingSentAt) S.pingSentAt = now();
      wsSend({ t: 'ping' });
    }, 5000);
  }

  function stopPing() {
    clearInterval(S.pingTimer);
    S.pingTimer = null;
  }

  function onServerMessage(m) {
    switch (m.t) {
      case 'welcome':
        onWelcome(m);
        break;
      case 'peer-joined':
        onPeerJoined(m.peer);
        break;
      case 'peer-left':
        onPeerLeft(m.id);
        break;
      case 'peer-state':
        onPeerState(m);
        break;
      case 'signal':
        onSignal(m.from, m.data);
        break;
      case 'chat':
        if (m.admin) toast('📢 ' + m.text, 5000);
        chat.typers.delete(m.from);
        renderTyping();
        renderMessage(m, false);
        break;
      case 'chat-delete':
        removeMessage(m.id);
        break;
      case 'chat-react': {
        const it = chat.msgs.get(m.id);
        if (it) {
          it.m.reactions = m.reactions || {};
          renderReactions(m.id);
        }
        break;
      }
      case 'chat-clear':
        resetChat();
        sysLine('Sohbet yönetici tarafından temizlendi', 'admin');
        break;
      case 'typing':
        onTyping(m);
        break;
      case 'music-results':
        onMusicResults(m);
        break;
      case 'kicked':
        onKicked(m.message);
        break;
      case 'admin-mute':
        if (S.track && !S.muted && !S.deafened) toggleMute();
        toast('Yönetici seni susturdu. Mikrofonunu tekrar açabilirsin.', 4000);
        break;
      case 'music':
        onMusic(m);
        break;
      case 'music-error':
        toast(m.message || 'Müzik eklenemedi', 3500);
        break;
      case 'pong':
        if (typeof m.serverNow === 'number') S.clockOffset = m.serverNow - Date.now();
        break;
      case 'error':
        onServerError(m);
        break;
      default:
        break;
    }
  }

  /** Yönetici tarafından çıkarıldı/engellendi: odadan çık, sebebini göster, geri bağlanma */
  function onKicked(message) {
    if (!S.joined) return;
    leaveRoom(false);
    showJoinError(message || 'Kanaldan çıkarıldın.');
  }

  /** Bağlantı kalitesini sunucuya bildir (sadece yönetici panelinde görünür) */
  function reportStats() {
    if (!S.joined || !S.ws) return;
    const peers = [...S.peers.values()].map((p) => ({
      id: p.id,
      state: p.pc ? p.pc.connectionState : 'none',
      rtt: p.rtt,
      relay: !!p.relay,
    }));
    wsSend({ t: 'stats', peers });
  }

  function onServerError(m) {
    if (!S.welcomed) {
      // Henüz odaya girmeden hata: giriş ekranına dön.
      leaveRoom(false);
      showJoinError(m.message || 'Odaya katılınamadı.');
    } else {
      toast(m.message || 'Sunucu hatası');
    }
  }

  function onWelcome(m) {
    S.wsAttempt = 0;
    if (Array.isArray(m.iceServers) && m.iceServers.length) S.iceServers = m.iceServers;
    const first = !S.welcomed;
    S.welcomed = true;
    setConn('ok', 'Bağlı');
    if (first) showRoom();

    const listed = new Set();
    for (const info of m.peers || []) {
      listed.add(info.id);
      upsertPeer(info, first);
    }
    // Listede olmayanlar: ya biz yokken ayrıldılar ya da sunucu yeniden başladı
    // ve henüz geri dönmediler. Hemen kapatmıyoruz; P2P bağlantı canlıysa ses sürsün.
    for (const p of S.peers.values()) {
      if (!listed.has(p.id)) {
        p.online = false;
        if (!p.absentSince) p.absentSince = now();
        renderPeer(p);
      }
    }
    if (m.uploadMaxMB) S.uploadMaxMB = m.uploadMaxMB;
    if (Array.isArray(m.chat)) {
      // İlk girişte geçmişi baştan çiz; yeniden bağlanınca sadece kaçırılanları ekle
      if (first) resetChat();
      for (const msg of m.chat) renderMessage(msg, true);
      if (first) requestAnimationFrame(scrollChatBottom);
    }
    if (first && S.peers.size === 0) chatAppend('', 'Odada şu an kimse yok. Linki arkadaşlarına gönder!', 0, true);
    if (m.streamToken) S.streamToken = m.streamToken;
    if (m.music) onMusic(m.music);
  }

  function onPeerJoined(info) {
    const isNew = !S.peers.has(info.id);
    upsertPeer(info, false);
    if (isNew) {
      chatAppend('', `${info.name} kanala katıldı`, 0, true);
      sfx.join();
    }
  }

  function onPeerLeft(id) {
    const p = S.peers.get(id);
    if (!p) return;
    chatAppend('', `${p.name} kanaldan ayrıldı`, 0, true);
    sfx.leave();
    removePeer(p);
  }

  function onPeerState(m) {
    const p = S.peers.get(m.id);
    if (!p) return;
    const wasOnline = p.online;
    p.name = m.name || p.name;
    p.muted = !!m.muted;
    p.deafened = !!m.deafened;
    p.online = !!m.online;
    const wasSharing = p.sharing;
    p.sharing = !!m.sharing;
    p.camera = !!m.camera;
    if (p.online) p.absentSince = 0;
    if (wasSharing && !p.sharing) p.iWatch = false;
    if (p.sharing && !wasSharing) chatAppend('', `${p.name} ekranını paylaşmaya başladı`, 0, true);
    renderPeer(p);
    renderScreens();
    if (p.online && !wasOnline) kick(p);
  }

  // =====================================================================
  // Eşler (WebRTC)
  // =====================================================================
  function isInitiator(p) {
    return S.id < p.id;
  }

  function upsertPeer(info, quiet) {
    let p = S.peers.get(info.id);
    if (!p) {
      p = {
        id: info.id,
        name: info.name,
        muted: !!info.muted,
        deafened: !!info.deafened,
        online: info.online !== false,
        pc: null,
        sid: null,
        polite: S.id > info.id,
        makingOffer: false,
        ignoreOffer: false,
        chain: Promise.resolve(),
        pcCreated: 0,
        badSince: 0,
        attempts: 0,
        nextAttemptAt: 0,
        absentSince: 0,
        audio: null,
        src: null,
        analyser: null,
        levelDb: -100,
        volume: store.get('vol:' + info.name, 100),
        localMuted: false,
        rtt: null,
        relay: false,
        sharing: !!info.sharing,
        camera: !!info.camera,
        watching: false, // bu kişi benim yayınımı izliyor
        iWatch: false, // ben bu kişinin yayınını izliyorum
        el: null,
      };
      S.peers.set(p.id, p);
      p.el = makeCard(p.name, false);
      // Kişi menüsü (ses seviyesi, bende sustur): soldaki listede ⋯ ya da sağ tık; telefonda kutuya dokun
      const li = p.el.side;
      li.querySelector('.sm-more').onclick = (e) => {
        e.stopPropagation();
        toggleMemberMenu(p, li.getBoundingClientRect());
      };
      const atPointer = (e) => {
        e.preventDefault();
        openMemberMenu(p, { left: e.clientX, right: e.clientX, top: e.clientY });
      };
      li.oncontextmenu = atPointer;
      p.el.oncontextmenu = atPointer;
      p.el.onclick = (e) => {
        if (window.innerWidth <= 760) {
          e.stopPropagation();
          openMemberMenu(p, p.el.getBoundingClientRect());
        }
      };
      $('#participants').appendChild(p.el);
      updateCount();
    } else {
      p.name = info.name;
      p.muted = !!info.muted;
      p.deafened = !!info.deafened;
      p.online = info.online !== false;
      p.sharing = !!info.sharing;
      p.camera = !!info.camera;
      if (!p.sharing) p.iWatch = false;
    }
    refreshCam(p);
    renderScreens();
    if (p.online) p.absentSince = 0;
    renderPeer(p);
    kick(p);
    return p;
  }

  function removePeer(p) {
    closePc(p);
    if (p.audio) {
      p.audio.srcObject = null;
      p.audio.remove();
      p.audio = null;
    }
    if (p.src) {
      try {
        p.src.disconnect();
      } catch {}
    }
    if (p.boostGain) {
      try {
        p.boostGain.disconnect();
        p.boostLimiter.disconnect();
      } catch {}
      p.boostGain = null;
    }
    if (p.el) {
      if (p.el.side) p.el.side.remove();
      p.el.remove();
    }
    if (p.screenEl) p.screenEl.remove();
    if (menuPeer === p) closeMemberMenu();
    S.peers.delete(p.id);
    renderScreens();
    updateCount();
  }

  /** Gerekirse bağlantıyı başlat (yalnızca başlatıcı taraf). */
  function kick(p) {
    if (!p.online || !S.ws) return;
    const st = p.pc ? p.pc.connectionState : 'none';
    if (st === 'connected' || st === 'connecting' || st === 'new') return;
    if (isInitiator(p)) startConnection(p);
  }

  function closePc(p) {
    const pc = p.pc;
    p.pc = null;
    p.sid = null;
    p.rtt = null;
    p.relay = false;
    if (pc) {
      pc.onicecandidate = pc.onnegotiationneeded = pc.ontrack = pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {}
    }
  }

  function sendSignal(p, data, sid) {
    wsSend({ t: 'signal', to: p.id, data: { sid, ...data } });
  }

  function createPc(p, sid) {
    const pc = new RTCPeerConnection({
      iceServers: S.iceServers,
      // ?relay=1 ile açılırsa sadece TURN kullanılır (TURN sunucusunu test etmek için).
      iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    p.pc = pc;
    p.sid = sid;
    p.makingOffer = false;
    p.ignoreOffer = false;
    p.pcCreated = now();
    p.badSince = now();

    pc.onicecandidate = (e) => {
      if (e.candidate && p.pc === pc) sendSignal(p, { candidate: e.candidate.toJSON() }, sid);
    };
    pc.onnegotiationneeded = async () => {
      if (p.pc !== pc) return;
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        if (p.pc === pc) sendSignal(p, { description: pc.localDescription.toJSON() }, sid);
      } catch (err) {
        console.warn('negotiation', err);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      if (p.pc !== pc) return;
      if (e.transceiver && e.transceiver === camTx(pc)) {
        setTimeout(() => refreshCam(p), 0);
        return;
      }
      if (e.transceiver && e.transceiver !== micTx(pc)) {
        // Ekran paylaşımı izi: izliyorsam görüntüyü yeni bağlantının izleriyle tazele
        if (p.iWatch) setTimeout(() => refreshScreenVideo(p), 0);
        return;
      }
      attachRemote(p, e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        p.attempts = 0;
        p.badSince = 0;
        tuneSenders(pc);
        applyScreenSend(p);
        applyCamSend(p);
        refreshCam(p);
        // Bağlantı yeniden kurulduysa izleme isteğini tekrarla
        if (p.iWatch) {
          sendSignal(p, { watch: true }, p.sid);
          refreshScreenVideo(p);
        }
        if (p.audio && p.audio.paused) p.audio.play().catch(() => showAudioUnlock());
      } else if (st === 'failed') {
        p.badSince = 1; // bekçi hemen müdahale etsin
        setTimeout(watchdog, 0);
      } else if (!p.badSince) {
        p.badSince = now();
      }
      renderPeer(p);
    };
    return pc;
  }

  function startConnection(p) {
    closePc(p);
    const pc = createPc(p, randomId(12));
    if (S.track) pc.addTransceiver(S.track, { direction: 'sendrecv', streams: [S.stream] });
    else pc.addTransceiver('audio', { direction: 'sendrecv' });
    // Ekran paylaşımı için baştan açık duran (boş) görüntü ve ekran sesi kanalları.
    // Paylaşım başlayınca sadece içlerine iz konur (replaceTrack); yeniden müzakere gerekmez.
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    // Kamera kanalı (boş durur; kamera açılınca içine iz konur)
    pc.addTransceiver('video', { direction: 'sendrecv' });
    applyScreenSend(p);
    applyCamSend(p);
    renderPeer(p);
    // negotiationneeded olayı teklifi gönderecek.
  }

  /**
   * Kanal sırası her iki tarafta aynıdır: [0] mikrofon, [1] ekran görüntüsü, [2] ekran sesi, [3] kamera.
   * (Başlatan taraf bu sırayla ekler; karşı taraf teklifteki sırayla alır.)
   */
  function micTx(pc) {
    return pc.getTransceivers()[0];
  }
  function screenTx(pc) {
    const t = pc.getTransceivers();
    return { video: t[1] && t[1].receiver.track.kind === 'video' ? t[1] : null, audio: t[2] && t[2].receiver.track.kind === 'audio' ? t[2] : null };
  }

  function camTx(pc) {
    const t = pc.getTransceivers()[3];
    return t && t.receiver.track.kind === 'video' ? t : null;
  }

  /** Kamera görüntüsünü gönder (açıksa herkese; düşük çözünürlük, ~500 kbit/sn) */
  function applyCamSend(p) {
    if (!p.pc) return;
    const tx = camTx(p.pc);
    if (!tx || tx.stopped) return;
    const want = S.cam ? S.cam.track : null;
    if (tx.sender.track !== want) tx.sender.replaceTrack(want).catch(() => {});
    try {
      const prm = tx.sender.getParameters();
      if (prm.encodings && prm.encodings.length) {
        prm.encodings[0].active = !!want;
        if (want) {
          prm.encodings[0].maxBitrate = 500000;
          prm.encodings[0].maxFramerate = 24;
        }
        tx.sender.setParameters(prm).catch(() => {});
      }
    } catch {}
  }

  function attachLocalTrack(p) {
    const pc = p.pc;
    if (!pc) return;
    const t0 = micTx(pc);
    if (t0 && !t0.stopped) {
      if (t0.sender.track !== S.track) t0.sender.replaceTrack(S.track).catch(() => {});
      if (t0.direction !== 'sendrecv') t0.direction = 'sendrecv';
    }
    for (const t of pc.getTransceivers().slice(1)) {
      if (!t.stopped && t.direction !== 'sendrecv') t.direction = 'sendrecv';
    }
    applyScreenSend(p);
    applyCamSend(p);
  }

  /**
   * Ekran görüntüsünü sadece izlemek isteyen kişiye gönder. İzlemeyene iz hiç konmaz (0 bayt);
   * herkes birbirine doğrudan bağlı olduğu için paylaşan kişinin internetini korur.
   */
  function applyScreenSend(p) {
    if (!p.pc) return;
    const { video, audio } = screenTx(p.pc);
    const on = !!S.screen && !!p.watching;
    for (const [tx, track, isVideo] of [
      [video, S.screen && S.screen.video, true],
      [audio, S.screen && S.screen.audio, false],
    ]) {
      if (!tx || tx.stopped) continue;
      const want = on && track ? track : null;
      if (tx.sender.track !== want) tx.sender.replaceTrack(want).catch(() => {});
      try {
        // İzlemeyene kodlayıcı da tamamen kapatılır (dolgu/deneme paketleri de gitmesin)
        const prm = tx.sender.getParameters();
        if (prm.encodings && prm.encodings.length) {
          prm.encodings[0].active = !!want;
          if (want) {
            prm.encodings[0].maxBitrate = isVideo ? 2500000 : 128000;
            if (isVideo) prm.encodings[0].maxFramerate = 30;
          }
          tx.sender.setParameters(prm).catch(() => {});
        }
      } catch {}
    }
  }

  function tuneSenders(pc) {
    const t0 = micTx(pc);
    for (const s of t0 ? [t0.sender] : []) {
      try {
        const prm = s.getParameters();
        if (!prm.encodings || !prm.encodings.length) continue;
        prm.encodings[0].maxBitrate = 64000;
        prm.encodings[0].priority = 'high';
        prm.encodings[0].networkPriority = 'high';
        s.setParameters(prm).catch(() => {});
      } catch {}
    }
  }

  function onSignal(from, data) {
    const p = S.peers.get(from);
    if (!p || !data || typeof data !== 'object') return;
    // Mesajlar sırayla işlenmeli (ör. aday, teklif uygulanmadan eklenmemeli).
    p.chain = p.chain.then(() => processSignal(p, data)).catch((err) => console.warn('signal', err));
  }

  async function processSignal(p, data) {
    if (typeof data.watch === 'boolean') {
      // Karşı taraf yayınımı izlemeye başladı / bıraktı
      p.watching = data.watch;
      applyScreenSend(p);
      renderScreens();
      return;
    }
    if (data.renew) {
      if (!isInitiator(p)) return;
      const st = p.pc && p.pc.connectionState;
      if (p.pc && (st === 'new' || st === 'connecting') && now() - p.pcCreated < 4000) return;
      startConnection(p);
      return;
    }
    const desc = data.description;
    if (desc && desc.type === 'offer' && data.sid !== p.sid) {
      // Karşı taraf yeni bir oturum başlattı.
      if (isInitiator(p)) return;
      closePc(p);
      createPc(p, data.sid);
    }
    const pc = p.pc;
    if (!pc || data.sid !== p.sid) return; // eski oturuma ait

    if (desc) {
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        attachLocalTrack(p);
        await pc.setLocalDescription();
        if (p.pc === pc) sendSignal(p, { description: pc.localDescription.toJSON() }, data.sid);
      }
      renderPeer(p);
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!p.ignoreOffer) console.warn('ice', err);
      }
    }
  }

  function attachRemote(p, stream) {
    if (!p.audio) {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      a.hidden = true;
      document.body.appendChild(a);
      p.audio = a;
      if (S.outId && a.setSinkId) a.setSinkId(S.outId).catch(() => {});
    }
    if (p.audio.srcObject !== stream) p.audio.srcObject = stream;
    applyPeerAudio(p);
    p.audio.play().catch(() => showAudioUnlock());

    if (S.ctx) {
      try {
        if (p.src) p.src.disconnect();
        p.src = S.ctx.createMediaStreamSource(stream);
        if (!p.analyser) {
          p.analyser = S.ctx.createAnalyser();
          p.analyser.fftSize = 512;
        }
        p.src.connect(p.analyser);
        if (p.boostGain) p.src.connect(p.boostGain);
      } catch (err) {
        console.warn('analyser', err);
      }
    }
    applyPeerAudio(p);
  }

  /**
   * %100'ün üstü için güçlendirme zinciri: kaynak → kazanç → sınırlayıcı → hoparlör.
   * Sınırlayıcı, yükseltilen sesin patlamasını (clipping) engeller.
   */
  function ensureBoost(p) {
    if (p.boostGain || !S.ctx || !p.src) return !!p.boostGain;
    try {
      p.boostGain = S.ctx.createGain();
      p.boostGain.gain.value = 0;
      const limiter = S.ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      p.boostGain.connect(limiter).connect(S.ctx.destination);
      p.boostLimiter = limiter;
      p.src.connect(p.boostGain);
      return true;
    } catch (err) {
      console.warn('boost', err);
      p.boostGain = null;
      return false;
    }
  }

  /**
   * Kişi ses seviyesi (0-200%). %100'e kadar ses doğrudan <audio> öğesinden çalar (tarayıcının
   * yankı engellemesiyle en uyumlu yol). %100'ün üstünde ses Web Audio güçlendiricisinden çalar;
   * <audio> öğesi sessize alınır ama bağlı kalır (Chrome uzak sesi ancak böyle akıtıyor).
   */
  function applyPeerAudio(p) {
    if (!p.audio) return;
    const silent = S.deafened || p.localMuted;
    const v = Math.max(0, Math.min(2, p.volume / 100));
    const boosted = v > 1 && ensureBoost(p);
    if (boosted) {
      p.audio.muted = true;
      p.boostGain.gain.setTargetAtTime(silent ? 0 : v, S.ctx.currentTime, 0.02);
    } else {
      if (p.boostGain) p.boostGain.gain.setTargetAtTime(0, S.ctx.currentTime, 0.02);
      p.audio.volume = Math.min(1, v);
      p.audio.muted = silent;
    }
    p.boosted = boosted;
  }

  function showAudioUnlock() {
    banner('Tarayıcı ses çalmayı engelledi.', [
      [
        'Sesi aç',
        () => {
          if (S.ctx) S.ctx.resume().catch(() => {});
          for (const p of S.peers.values()) if (p.audio) p.audio.play().catch(() => {});
          banner(null);
        },
      ],
    ]);
  }

  // ---- Bekçi: kopan/kurulamayan bağlantıları onarır ----
  function watchdog() {
    if (!S.joined) return;
    const t = now();
    for (const p of [...S.peers.values()]) {
      const st = p.pc ? p.pc.connectionState : 'none';

      // Sunucu listesinde olmayan eş: P2P de ölmüşse kaldır; yine de 60 sn sonra kesin kaldır.
      if (p.absentSince) {
        const absentFor = t - p.absentSince;
        if ((st !== 'connected' && absentFor > 8000) || absentFor > 60000) {
          removePeer(p);
          continue;
        }
      }
      if (st === 'connected') {
        p.badSince = 0;
        continue;
      }
      if (!p.online || !S.ws || S.ws.readyState !== WebSocket.OPEN) continue;
      if (!p.badSince) p.badSince = t;

      let grace;
      if (st === 'failed' || st === 'closed') grace = 0;
      else if (st === 'disconnected') grace = 5000;
      else if (st === 'none') grace = isInitiator(p) ? 0 : 4000;
      else grace = 12000; // new / connecting

      if (t - p.badSince >= grace && t >= p.nextAttemptAt) {
        p.nextAttemptAt = t + Math.min(15000, 1500 * 2 ** p.attempts);
        p.attempts++;
        p.badSince = t;
        if (isInitiator(p)) startConnection(p);
        else sendSignal(p, { renew: true }, null);
        renderPeer(p);
      }
    }
  }

  // ---- Konuşma göstergeleri + gecikme ----
  const levelBuf = new Float32Array(512);
  function remoteLevels() {
    for (const p of S.peers.values()) {
      if (!p.analyser) continue;
      p.analyser.getFloatTimeDomainData(levelBuf);
      let s = 0;
      for (let i = 0; i < levelBuf.length; i++) s += levelBuf[i] * levelBuf[i];
      const rms = Math.sqrt(s / levelBuf.length);
      p.levelDb = rms > 0 ? 20 * Math.log10(rms) : -100;
      setSpeaking(p.el, p.levelDb > SPEAK_DB && !p.localMuted && p.pc && p.pc.connectionState === 'connected');
    }
  }

  async function collectStats() {
    for (const p of S.peers.values()) {
      if (!p.pc || p.pc.connectionState !== 'connected') continue;
      try {
        const stats = await p.pc.getStats();
        let pair = null;
        stats.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId) || pair;
        });
        if (!pair) {
          stats.forEach((r) => {
            if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r;
          });
        }
        const rtt = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
        const lc = pair && stats.get(pair.localCandidateId);
        const rc = pair && stats.get(pair.remoteCandidateId);
        const relay = !!((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay'));
        if (rtt !== p.rtt || relay !== p.relay) {
          p.rtt = rtt;
          p.relay = relay;
          renderPeer(p);
        }
      } catch {}
    }
  }

  // =====================================================================
  // Kontroller
  // =====================================================================
  // =====================================================================
  // Kamera
  // =====================================================================
  const canCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function camErrorText(err) {
    if (!err) return 'Kamera açılamadı.';
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return 'Kamera izni verilmedi. Adres çubuğundaki kamera simgesinden izin verin.';
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'Kamera bulunamadı.';
    if (err.name === 'NotReadableError') return 'Kamera başka bir uygulama tarafından kullanılıyor olabilir.';
    return 'Kamera açılamadı: ' + (err.message || err.name);
  }

  async function startCam() {
    if (S.cam || S.camStarting) return;
    S.camStarting = true;
    const video = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };
    if (S.camId) video.deviceId = { exact: S.camId };
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video });
    } catch (err) {
      if (S.camId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        // Kayıtlı kamera artık yok: varsayılana dön
        S.camId = '';
        store.set('camId', '');
        delete video.deviceId;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video });
        } catch (err2) {
          toast(camErrorText(err2), 4000);
        }
      } else toast(camErrorText(err), 4000);
    }
    S.camStarting = false;
    if (!stream) return;
    if (!S.joined) return stream.getTracks().forEach((t) => t.stop());
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', stopCam);
    S.cam = { stream, track };
    for (const p of S.peers.values()) applyCamSend(p);
    publishState();
    renderSelfCam();
    refreshDevices();
  }

  function stopCam() {
    if (!S.cam) return;
    S.cam.stream.getTracks().forEach((t) => t.stop());
    S.cam = null;
    for (const p of S.peers.values()) applyCamSend(p);
    publishState();
    renderSelfCam();
  }

  /** Bir kişinin kamera görüntüsünü kutusuna bağla (kamerası açıksa) */
  function refreshCam(p) {
    if (!p.el) return;
    const video = p.el.querySelector('.cam-video');
    const tx = p.pc && camTx(p.pc);
    const on = !!(p.camera && tx);
    p.el.classList.toggle('has-cam', on);
    if (!on) {
      if (video.srcObject) video.srcObject = null;
      return;
    }
    const track = tx.receiver.track;
    if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== track) video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
  }

  function renderSelfCam() {
    const b = $('#cam-btn');
    if (b) {
      b.hidden = !canCam;
      b.classList.toggle('on', !!S.cam);
      b.title = S.cam ? 'Kamerayı kapat' : 'Kamerayı aç';
      b.querySelector('use').setAttribute('href', S.cam ? '#i-video' : '#i-video-off');
    }
    if (!S.selfEl) return;
    const video = S.selfEl.querySelector('.cam-video');
    S.selfEl.classList.toggle('has-cam', !!S.cam);
    video.classList.add('mirror'); // kendi görüntün ayna gibi
    if (S.cam) {
      if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== S.cam.track) video.srcObject = new MediaStream([S.cam.track]);
      video.play().catch(() => {});
    } else video.srcObject = null;
    renderSide(S.selfEl, { muted: S.muted || !S.track, deafened: S.deafened, sharing: !!S.screen });
  }

  // =====================================================================
  // Ekran paylaşımı (Discord'daki "Yayın" gibi; izlemek isteğe bağlı)
  // =====================================================================
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  async function startShare() {
    if (S.screen) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        // Sekme/sistem sesi de paylaşılır; bu sekmenin kendi sesi (arkadaşların sesi) hariç tutulur ki yankı olmasın
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Ekran paylaşılamadı: ' + (err.message || err.name), 4000);
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (!video) return stream.getTracks().forEach((t) => t.stop());
    try {
      video.contentHint = 'motion'; // oyun/video için akıcılık öncelikli
    } catch {}
    S.screen = { stream, video, audio: stream.getAudioTracks()[0] || null };
    // Tarayıcının "Paylaşımı durdur" çubuğundan durdurulursa
    video.addEventListener('ended', stopShare);
    for (const p of S.peers.values()) applyScreenSend(p);
    publishState();
    renderSelf();
    renderScreens();
    sfx.join();
  }

  function stopShare() {
    if (!S.screen) return;
    S.screen.stream.getTracks().forEach((t) => t.stop());
    S.screen = null;
    for (const p of S.peers.values()) applyScreenSend(p);
    if (S.selfScreenEl) {
      S.selfScreenEl.remove();
      S.selfScreenEl = null;
    }
    publishState();
    renderSelf();
    renderScreens();
  }

  function setWatch(p, on) {
    p.iWatch = on;
    if (p.pc) sendSignal(p, { watch: on }, p.sid);
    if (on) refreshScreenVideo(p);
    renderScreens();
  }

  /** İzlediğim kişinin ekran görüntüsünü ve sesini oynatıcıya bağla */
  function refreshScreenVideo(p) {
    if (!p.pc || !p.screenVideo) return;
    const { video, audio } = screenTx(p.pc);
    const tracks = [video && video.receiver.track, audio && audio.receiver.track].filter(Boolean);
    const cur = p.screenVideo.srcObject;
    if (!cur || cur.getTracks().length !== tracks.length || cur.getTracks().some((t, i) => t !== tracks[i])) {
      p.screenVideo.srcObject = new MediaStream(tracks);
    }
    applyScreenAudio(p);
    p.screenVideo.play().catch(() => showAudioUnlock());
  }

  function applyScreenAudio(p) {
    if (!p.screenVideo) return;
    p.screenVideo.volume = Math.max(0, Math.min(1, (p.screenVol ?? 100) / 100));
    p.screenVideo.muted = S.deafened;
  }

  /** Paylaşım kartını oluştur (bir kez) */
  function screenCard(owner, isSelf) {
    const el = document.createElement('div');
    el.className = 'screen-tile';
    el.innerHTML =
      '<video class="screen-video" playsinline></video>' +
      '<div class="screen-idle"><span class="screen-ico">' + svgIcon('monitor') + '</span><span class="screen-msg"></span>' +
      '<button class="btn primary watch-btn" type="button">Yayını izle</button></div>' +
      '<div class="screen-bar"><span class="live-badge">CANLI</span><span class="screen-name"></span><span class="spacer"></span>' +
      '<span class="screen-vol" title="Yayın sesi (sadece senin için)">' + svgIcon('speaker') + '<input type="range" min="0" max="100" value="100" aria-label="Yayın sesi"></span>' +
      '<button class="icon-btn fs-btn" title="Tam ekran" type="button">' + svgIcon('fullscreen') + '</button>' +
      '<button class="btn stop-btn" type="button"></button></div>';
    const video = el.querySelector('video');
    el.querySelector('.fs-btn').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else el.requestFullscreen().catch(() => {});
    };
    if (isSelf) {
      video.muted = true; // kendi yayınımın sesini kendime çalma
      el.querySelector('.screen-vol').hidden = true;
      el.querySelector('.stop-btn').textContent = 'Paylaşımı durdur';
      el.querySelector('.stop-btn').classList.add('danger');
      el.querySelector('.stop-btn').onclick = stopShare;
    } else {
      owner.screenVideo = video;
      el.querySelector('.watch-btn').onclick = () => setWatch(owner, true);
      el.querySelector('.stop-btn').textContent = 'İzlemeyi bırak';
      el.querySelector('.stop-btn').onclick = () => setWatch(owner, false);
      const vol = el.querySelector('.screen-vol input');
      vol.oninput = () => {
        owner.screenVol = Number(vol.value);
        applyScreenAudio(owner);
      };
    }
    $('#screens').appendChild(el);
    return el;
  }

  /** Paylaşımları çiz: izlenenler büyük, diğerleri "Yayını izle" kartı */
  function renderScreens() {
    const shareBtn = $('#share-btn');
    if (shareBtn) {
      shareBtn.hidden = !canShare;
      shareBtn.classList.toggle('on', !!S.screen);
      shareBtn.querySelector('span').textContent = S.screen ? 'Durdur' : 'Ekran';
      shareBtn.title = S.screen ? 'Ekran paylaşımını durdur' : 'Ekranını, bir pencereyi ya da sekmeyi paylaş';
    }
    let watched = 0;
    let tiles = 0;
    // Kendi yayınım (önizleme)
    if (S.screen) {
      if (!S.selfScreenEl) {
        S.selfScreenEl = screenCard(null, true);
        S.selfScreenEl.querySelector('video').srcObject = new MediaStream([S.screen.video]);
        S.selfScreenEl.querySelector('video').play().catch(() => {});
      }
      const n = [...S.peers.values()].filter((p) => p.watching).length;
      const el = S.selfScreenEl;
      el.classList.add('watching', 'self');
      el.querySelector('.screen-name').textContent = 'Ekranını paylaşıyorsun · ' + (n ? `${n} kişi izliyor` : 'henüz izleyen yok');
      tiles++;
      watched++;
    }
    for (const p of S.peers.values()) {
      if (!p.sharing) {
        if (p.screenEl) {
          p.screenEl.remove();
          p.screenEl = null;
          p.screenVideo = null;
        }
        continue;
      }
      if (!p.screenEl) p.screenEl = screenCard(p, false);
      const el = p.screenEl;
      el.classList.toggle('watching', p.iWatch);
      el.querySelector('.screen-name').textContent = p.name;
      el.querySelector('.screen-msg').textContent = `${p.name} ekranını paylaşıyor`;
      if (!p.iWatch && p.screenVideo && p.screenVideo.srcObject) {
        p.screenVideo.pause();
        p.screenVideo.srcObject = null;
      }
      tiles++;
      if (p.iWatch) watched++;
    }
    const stage = $('.stage');
    stage.classList.toggle('has-screens', tiles > 0);
    stage.classList.toggle('focus', watched > 0);
    renderSelf();
    layoutTiles();
  }

  function publishState() {
    wsSend({ t: 'state', muted: S.muted || !S.track, deafened: S.deafened, sharing: !!S.screen, camera: !!S.cam });
  }

  function toggleMute() {
    if (!S.track) {
      toast('Mikrofon yok. Ayarlardan bir mikrofon seçin.');
      return;
    }
    if (S.deafened) {
      S.deafened = false;
      S.muted = false;
    } else {
      S.muted = !S.muted;
    }
    store.set('muted', S.muted);
    for (const p of S.peers.values()) applyPeerAudio(p);
    applyTransmit();
    applyMusicVolume();
    renderSelf();
    publishState();
    (S.muted ? sfx.mute : sfx.unmute)();
  }

  function toggleDeafen() {
    if (!S.deafened) {
      sfx.mute();
      S.mutedBeforeDeafen = S.muted;
      S.deafened = true;
    } else {
      S.deafened = false;
      S.muted = S.mutedBeforeDeafen;
      sfx.unmute();
    }
    for (const p of S.peers.values()) {
      applyPeerAudio(p);
      applyScreenAudio(p);
    }
    applyTransmit();
    applyMusicVolume();
    renderSelf();
    publishState();
  }

  // =====================================================================
  // Müzik (ortak YouTube çalma listesi)
  // Ses sunucudan yayınlanmaz: herkesin tarayıcısı aynı videoyu aynı saniyede çalar.
  // Böylece müzik mikrofondan gönderilmez ve herkes kendi müzik sesini ayarlar.
  // =====================================================================
  const serverTime = () => Date.now() + S.clockOffset;

  function musicPos(cur) {
    if (cur.pausedAt != null) return cur.pausedAt;
    return (serverTime() - cur.startedAt) / 1000;
  }

  function onMusic(m) {
    if (typeof m.serverNow === 'number') S.clockOffset = m.serverNow - Date.now();
    S.music = {
      queue: Array.isArray(m.queue) ? m.queue : [],
      current: m.current || null,
      history: Array.isArray(m.history) ? m.history : [],
      loop: m.loop || 'off',
      search: !!m.search,
      stream: !!m.stream,
    };
    if (m.event) sysLine(m.event, 'music');
    renderMusic();
    syncPlayer();
  }

  function fmtDur(sec) {
    if (!sec) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** Kaynak işareti: SoundCloud sadece ses, YouTube video + ses (daha çok internet) */
  function sourceLabel(item, short) {
    if (sourceOf(item) === 'sc') return 'SoundCloud';
    if (S.music.stream) return short ? 'YouTube' : 'YouTube · sadece ses';
    return 'YouTube';
  }

  const LOOP_INFO = {
    off: { icon: 'repeat', title: 'Tekrar: kapalı (tıkla: liste tekrarı)', next: 'all' },
    all: { icon: 'repeat', title: 'Tekrar: liste (tıkla: tek şarkı)', next: 'one' },
    one: { icon: 'repeat-one', title: 'Tekrar: tek şarkı (tıkla: kapalı)', next: 'off' },
  };

  const ytThumb = (id) => 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg';
  const thumbOf = (item) => (item ? item.thumb || (sourceOf(item) === 'yt' && item.id ? ytThumb(item.id) : null) : null);

  /** Sıra/geçmiş satırı: küçük kapak, ad, süre, üzerine gelince işlemler */
  function mpItem(item, actions) {
    const li = document.createElement('li');
    li.className = 'mp-item';
    const th = document.createElement('div');
    th.className = 'mp-thumb';
    const src = thumbOf(item);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => (th.innerHTML = svgIcon('music'));
      th.appendChild(img);
    } else th.innerHTML = svgIcon('music');
    const info = document.createElement('div');
    info.className = 'mp-info';
    info.style.minWidth = '0';
    const t = document.createElement('div');
    t.className = 'mp-title';
    t.textContent = item.title;
    t.title = item.title;
    const meta = document.createElement('div');
    meta.className = 'mp-meta';
    meta.textContent = [sourceLabel(item, true), item.author, item.by].filter(Boolean).join(' · ');
    info.append(t, meta);
    const side = document.createElement('div');
    side.className = 'mp-side';
    const dur = document.createElement('span');
    dur.className = 'mp-dur';
    dur.textContent = fmtDur(item.duration);
    const acts = document.createElement('div');
    acts.className = 'mp-acts';
    for (const [icon, title, fn, cls] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn' + (cls ? ' ' + cls : '');
      b.title = title;
      b.innerHTML = svgIcon(icon);
      b.onclick = fn;
      acts.appendChild(b);
    }
    side.append(dur, acts);
    li.append(th, info, side);
    return li;
  }

  function renderMusic() {
    const cur = S.music.current;
    const loop = LOOP_INFO[S.music.loop] || LOOP_INFO.off;
    const lb = $('#m-loop');
    lb.innerHTML = svgIcon(loop.icon);
    lb.dataset.mode = S.music.loop;
    lb.title = loop.title;
    lb.classList.toggle('on', S.music.loop !== 'off');
    $('#music-input').placeholder = S.music.search ? 'Şarkı ara ya da link yapıştır' : 'YouTube / SoundCloud linki yapıştır';
    $('#now-playing').hidden = !cur;
    $('#music-empty').hidden = !!cur;
    if (cur) {
      $('#np-title').textContent = cur.title;
      $('#np-title').title = cur.title;
      $('#np-sub').textContent = [sourceLabel(cur), cur.author, 'ekleyen: ' + cur.by].filter(Boolean).join(' · ');
      $('#np-sub').title =
        sourceOf(cur) === 'sc'
          ? 'SoundCloud: sadece ses (saatte ~70 MB)'
          : S.music.stream
            ? 'YouTube, sunucudan sadece ses olarak (saatte ~60 MB)'
            : 'YouTube: video + ses (saatte ~350 MB)';
      const src = thumbOf(cur);
      const art = $('#np-art');
      if (src) {
        if (art.getAttribute('src') !== src) art.src = src;
        art.hidden = false;
      } else {
        art.removeAttribute('src');
        art.hidden = true;
      }
      $('#np-art-wrap').classList.toggle('has-img', !!src);
      $('#m-pause').innerHTML = svgIcon(cur.pausedAt != null ? 'play' : 'pause');
      $('#m-pause').title = cur.pausedAt != null ? 'Devam ettir (herkes için)' : 'Duraklat (herkes için)';
    }
    const pill = $('#np-pill');
    pill.hidden = !cur;
    if (cur) pill.querySelector('span').textContent = cur.title;
    $('#music-dot').hidden = !cur;

    const q = S.music.queue;
    const list = $('#music-queue');
    list.innerHTML = '';
    q.forEach((item, i) => {
      const acts = [];
      if (i > 0) acts.push(['arrow-up', 'Sıradaki yap', () => wsSend({ t: 'music-move', key: item.key })]);
      acts.push(['x', 'Sıradan çıkar', () => wsSend({ t: 'music-remove', key: item.key }), 'rm']);
      list.appendChild(mpItem(item, acts));
    });
    const total = q.reduce((a, it) => a + (it.duration || 0), 0);
    $('#queue-count').textContent = q.length ? q.length + ' şarkı' + (total ? ' · ' + fmtDur(total) : '') : '';
    $('#queue-empty').hidden = q.length > 0;

    const hist = $('#music-history');
    hist.innerHTML = '';
    for (const item of S.music.history.slice(0, 10)) {
      hist.appendChild(mpItem(item, [['repeat', 'Tekrar sıraya ekle', () => wsSend({ t: 'music-requeue', key: item.key })]]));
    }
    $('#history-wrap').hidden = S.music.history.length === 0;
    $('#m-prev').disabled = !cur && S.music.history.length === 0;
    $('#m-shuffle').disabled = q.length < 2;
    renderArtVisibility();
    updateProgress();
  }

  /** YouTube videosu oynatıcıda görünür; sadece ses çalarken (akış) kapak gösterilir */
  function renderArtVisibility() {
    const cur = S.music.current;
    const kind = cur ? playerKindFor(cur) : null;
    const showPlayer = !!cur && !S.musicOff && kind !== 'stream';
    $('#player-box').hidden = !showPlayer;
    $('#np-art-wrap').hidden = showPlayer;
  }

  function musicDuration(cur) {
    if (cur.duration) return cur.duration;
    const d = S.player && S.playKey === cur.key ? S.player.duration() : 0;
    return d > 0 ? d : 0;
  }

  function updateProgress() {
    const cur = S.music.current;
    if (!cur) return;
    const dur = musicDuration(cur);
    let pos = Math.max(0, musicPos(cur));
    if (dur) pos = Math.min(pos, dur);
    $('#np-cur').textContent = fmtDur(pos) || '0:00';
    $('#np-dur').textContent = dur ? fmtDur(dur) : '—';
    $('#np-fill').style.width = dur ? (pos / dur) * 100 + '%' : '0';
    $('#np-bar').classList.toggle('no-dur', !dur);
  }

  // ---- arama: sonuç listesinden seçilir
  const msearch = { q: '', items: null, error: null, timer: null };
  const isMusicLink = (v) => /^(https?:\/\/|www\.)|youtu\.?be\/|soundcloud\.com\//i.test(v);

  function startMusicSearch(q) {
    clearTimeout(msearch.timer);
    Object.assign(msearch, { q, items: null, error: null });
    if (!wsSend({ t: 'music-search', q })) {
      msearch.error = 'Sunucuya bağlı değil.';
    } else {
      msearch.timer = setTimeout(() => {
        if (msearch.q === q && !msearch.items && !msearch.error) {
          msearch.error = 'Arama zaman aşımına uğradı, tekrar dene.';
          renderMusicResults();
        }
      }, 25000);
    }
    renderMusicResults();
  }

  function onMusicResults(m) {
    if (m.q !== msearch.q) return;
    clearTimeout(msearch.timer);
    msearch.items = Array.isArray(m.items) ? m.items : [];
    msearch.error = m.error || null;
    renderMusicResults();
  }

  function hideMusicResults() {
    clearTimeout(msearch.timer);
    Object.assign(msearch, { q: '', items: null, error: null });
    $('#music-results').hidden = true;
    $('#music-results').innerHTML = '';
  }

  function renderMusicResults() {
    const box = $('#music-results');
    box.innerHTML = '';
    box.hidden = false;
    const head = document.createElement('div');
    head.className = 'mpr-head';
    const ht = document.createElement('span');
    ht.innerHTML = '<b></b> için sonuçlar';
    ht.firstChild.textContent = '“' + msearch.q + '”';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.title = 'Kapat';
    close.style.cssText = 'width:24px;height:24px';
    close.innerHTML = svgIcon('x');
    close.onclick = hideMusicResults;
    head.append(ht, close);
    box.appendChild(head);
    if (msearch.error) {
      const p = document.createElement('div');
      p.className = 'mpr-msg error';
      p.textContent = msearch.error;
      return box.appendChild(p);
    }
    if (!msearch.items) {
      for (let i = 0; i < 3; i++) {
        const sk = document.createElement('div');
        sk.className = 'mp-result';
        sk.innerHTML = '<span class="sk"></span><span><div class="sk-line" style="width:90%"></div><div class="sk-line" style="width:50%"></div></span>';
        box.appendChild(sk);
      }
      return;
    }
    if (!msearch.items.length) {
      const p = document.createElement('div');
      p.className = 'mpr-msg';
      p.textContent = 'Sonuç bulunamadı. Başka bir şey dene ya da link yapıştır.';
      return box.appendChild(p);
    }
    for (const it of msearch.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mp-result';
      b.title = 'Sıraya ekle: ' + it.title;
      const img = document.createElement('img');
      img.alt = '';
      img.src = it.thumb || ytThumb(it.id);
      const info = document.createElement('span');
      info.style.minWidth = '0';
      const t = document.createElement('span');
      t.className = 'mpr-title';
      t.textContent = it.title;
      const meta = document.createElement('span');
      meta.className = 'mpr-meta';
      meta.textContent = [it.author, fmtDur(it.duration)].filter(Boolean).join(' · ');
      info.append(t, meta);
      b.append(img, info);
      b.onclick = () => pickMusicResult(it);
      box.appendChild(b);
    }
  }

  function pickMusicResult(it) {
    if (addMusic('https://www.youtube.com/watch?v=' + it.id, true)) {
      toast('Sıraya eklendi: ' + it.title);
      $('#music-input').value = '';
      hideMusicResults();
    }
  }

  function submitMusic() {
    const input = $('#music-input');
    const v = input.value.trim();
    if (!v) return;
    if (isMusicLink(v) || !S.music.search) {
      if (addMusic(v)) {
        input.value = '';
        hideMusicResults();
      }
      return;
    }
    // Aynı arama zaten listelendiyse Enter ilk sonucu ekler
    if (msearch.q === v && msearch.items && msearch.items.length) return pickMusicResult(msearch.items[0]);
    startMusicSearch(v);
  }

  // ---------------------------------------------------------------------
  // Oynatıcılar: YouTube (video + ses) ve SoundCloud (sadece ses, ~5 kat az internet).
  // İkisi de aynı arayüzü sunar; senkron mantığı kaynaktan bağımsızdır.
  //   load(cur, pos, play) play() pause() seek(sn) time() duration() state() currentId()
  //   setVolume(0-100) setMuted(bool) destroy()
  //   state(): 'unstarted' | 'cued' | 'buffering' | 'playing' | 'paused' | 'ended'
  // ---------------------------------------------------------------------
  const sourceOf = (item) => (item && item.source === 'sc' ? 'sc' : 'yt');
  /** Hangi oynatıcı: SoundCloud widget'ı, sunucu ses akışı (yt-dlp) ya da gömülü YouTube */
  const playerKindFor = (item) => (sourceOf(item) === 'sc' ? 'sc' : S.music.stream ? 'stream' : 'yt');

  /**
   * Sunucu ses akışı oynatıcısı (sadece ses). YouTube şarkıları sunucudan /music/audio ile gelir:
   * gömme/telif engeli yok, video yok, reklam yok.
   */
  async function createStreamPlayer(cur, pos, play, ev) {
    const el = document.createElement('audio');
    el.preload = 'auto';
    if (S.outId && el.setSinkId) el.setSinkId(S.outId).catch(() => {});
    const box = $('#player-box');
    box.replaceChildren(el);
    box.classList.remove('sc');
    box.classList.add('stream');
    let state = 'unstarted';
    let id = null;
    const srcFor = (c) => `/music/audio/${encodeURIComponent(c.id)}?k=${encodeURIComponent(S.streamToken || '')}`;
    el.addEventListener('playing', () => {
      state = 'playing';
      ev.onState('playing');
    });
    el.addEventListener('pause', () => {
      if (state === 'ended') return;
      state = 'paused';
      ev.onState('paused');
    });
    el.addEventListener('waiting', () => (state = 'buffering'));
    el.addEventListener('ended', () => {
      state = 'ended';
      ev.onState('ended');
    });
    el.addEventListener('error', () => {
      if (el.getAttribute('src')) ev.onError('stream-error');
    });
    el.addEventListener('loadedmetadata', () => ev.onDuration && ev.onDuration());
    const load = (c, p, pl) => {
      id = c.id;
      state = pl ? 'buffering' : 'cued';
      el.src = srcFor(c);
      try {
        el.currentTime = Math.max(0, p);
      } catch {}
      if (pl)
        el.play().catch((err) => {
          if (err && err.name === 'NotAllowedError') showAudioUnlock();
        });
    };
    load(cur, pos, play);
    return {
      kind: 'stream',
      load,
      play: () =>
        el.play().catch((err) => {
          if (err && err.name === 'NotAllowedError') showAudioUnlock();
        }),
      pause: () => el.pause(),
      seek: (t) => {
        try {
          el.currentTime = t;
        } catch {}
      },
      time: () => el.currentTime || 0,
      duration: () => (isFinite(el.duration) ? el.duration : 0),
      state: () => state,
      currentId: () => id,
      setVolume: (v) => (el.volume = Math.max(0, Math.min(1, v / 100))),
      setMuted: (m) => (el.muted = m),
      volume: () => Math.round(el.volume * 100),
      muted: () => el.muted,
      setSink: (sink) => el.setSinkId && el.setSinkId(sink || '').catch(() => {}),
      destroy: () => {
        el.pause();
        el.removeAttribute('src');
        el.load(); // indirmeyi gerçekten durdur
        box.classList.remove('stream');
        el.remove();
      },
    };
  }

  function loadScript(src, ready, timeoutMsg) {
    return new Promise((resolve, reject) => {
      if (ready()) return resolve();
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onerror = () => reject(new Error(timeoutMsg));
      document.head.appendChild(tag);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (ready()) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - t0 > 15000) {
          clearInterval(iv);
          reject(new Error(timeoutMsg));
        }
      }, 100);
    });
  }

  let ytApi = null;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!ytApi) {
      ytApi = loadScript('https://www.youtube.com/iframe_api', () => !!(window.YT && window.YT.Player), 'YouTube yüklenemedi').then(() => window.YT);
      ytApi.catch(() => (ytApi = null));
    }
    return ytApi;
  }

  let scApi = null;
  function loadSoundCloudApi() {
    if (window.SC && window.SC.Widget) return Promise.resolve(window.SC);
    if (!scApi) {
      scApi = loadScript('https://w.soundcloud.com/player/api.js', () => !!(window.SC && window.SC.Widget), 'SoundCloud yüklenemedi').then(() => window.SC);
      scApi.catch(() => (scApi = null));
    }
    return scApi;
  }

  /** YouTube oynatıcısı. İlk şarkıyla oluşturulur (boş oluşturulan oynatıcı hata 2 verir). */
  async function createYouTubePlayer(cur, pos, play, ev) {
    const YT = await loadYouTubeApi();
    const box = document.createElement('div');
    $('#player-box').replaceChildren(box);
    $('#player-box').classList.remove('sc', 'stream');
    const names = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube oynatıcı hazır olmadı')), 15000);
      const yt = new YT.Player(box, {
        width: '100%',
        height: '100%',
        videoId: cur.id,
        playerVars: {
          autoplay: play ? 1 : 0,
          start: Math.max(0, Math.floor(pos)),
          controls: 0,
          disablekb: 1,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            clearTimeout(timer);
            resolve(api);
          },
          onStateChange: (e) => ev.onState(names[e.data] || 'unstarted'),
          onError: (e) => ev.onError(e.data),
        },
      });
      const safe = (fn, d) => {
        try {
          return fn();
        } catch {
          return d;
        }
      };
      const api = {
        kind: 'yt',
        load: (c, p, pl) =>
          pl ? yt.loadVideoById({ videoId: c.id, startSeconds: Math.max(0, p) }) : yt.cueVideoById({ videoId: c.id, startSeconds: Math.max(0, p) }),
        play: () => yt.playVideo(),
        pause: () => yt.pauseVideo(),
        seek: (s) => yt.seekTo(s, true),
        time: () => safe(() => yt.getCurrentTime(), 0) || 0,
        duration: () => safe(() => yt.getDuration(), 0) || 0,
        state: () => names[safe(() => yt.getPlayerState(), -1)] || 'unstarted',
        currentId: () => safe(() => yt.getVideoData().video_id, null),
        setVolume: (v) => yt.setVolume(v),
        setMuted: (m) => (m ? yt.mute() : yt.unMute()),
        volume: () => safe(() => yt.getVolume(), null),
        muted: () => safe(() => yt.isMuted(), null),
        destroy: () => safe(() => yt.destroy()),
      };
    });
  }

  /**
   * SoundCloud oynatıcısı (sadece ses). Widget API olay tabanlıdır; konum/durum önbellekte tutulur.
   * Büyük plak şirketlerinin bazı parçaları gömülü oynatıcıda sadece 30 sn önizleme verir
   * (policy SNIP); bu "oynatılamadı" olarak bildirilir.
   */
  async function createSoundCloudPlayer(cur, pos, play, ev) {
    const SC = await loadSoundCloudApi();
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.className = 'sc-frame';
    iframe.title = 'SoundCloud';
    const widgetUrl = (url, auto) =>
      'https://w.soundcloud.com/player/?' +
      new URLSearchParams({ url, auto_play: auto ? 'true' : 'false', visual: 'false', show_comments: 'false', show_user: 'true', hide_related: 'true', buying: 'false', sharing: 'false', download: 'false' });
    iframe.src = widgetUrl(cur.id, false);
    $('#player-box').replaceChildren(iframe);
    $('#player-box').classList.add('sc');
    const w = SC.Widget(iframe);
    const st = { state: 'unstarted', time: 0, duration: 0, id: cur.id, volume: 100, muted: false, pendingSeek: null };
    const applyVol = () => w.setVolume(st.muted ? 0 : st.volume);

    // Yeni parça yüklenince: önizleme kontrolü, süre, başlangıç konumu
    const afterLoad = (c, p, pl) => {
      w.getCurrentSound((sound) => {
        if (st.id !== c.id) return;
        if (!sound || sound.policy === 'BLOCK') return ev.onError('sc-block');
        if (sound.policy === 'SNIP') return ev.onError('sc-snip');
        st.duration = (sound.full_duration || sound.duration || 0) / 1000;
        ev.onDuration && ev.onDuration(st.duration);
        applyVol();
        if (p > 0.5) w.seekTo(p * 1000);
        if (pl) w.play();
        else st.state = 'cued';
      });
    };

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SoundCloud oynatıcı hazır olmadı')), 15000);
      w.bind(SC.Widget.Events.READY, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    w.bind(SC.Widget.Events.PLAY, () => {
      st.state = 'playing';
      ev.onState('playing');
    });
    w.bind(SC.Widget.Events.PAUSE, () => {
      if (st.state === 'ended') return;
      st.state = 'paused';
      ev.onState('paused');
    });
    w.bind(SC.Widget.Events.FINISH, () => {
      st.state = 'ended';
      ev.onState('ended');
    });
    w.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => {
      st.time = e.currentPosition / 1000;
    });
    w.bind(SC.Widget.Events.ERROR, () => ev.onError('sc-error'));
    afterLoad(cur, pos, play);

    return {
      kind: 'sc',
      load: (c, p, pl) => {
        st.id = c.id;
        st.state = 'buffering';
        st.time = 0;
        w.load(c.id, { auto_play: false, visual: false, show_comments: false, hide_related: true, callback: () => afterLoad(c, p, pl) });
      },
      play: () => w.play(),
      pause: () => w.pause(),
      seek: (s) => {
        st.time = s;
        w.seekTo(s * 1000);
      },
      time: () => st.time,
      duration: () => st.duration,
      state: () => st.state,
      currentId: () => st.id,
      setVolume: (v) => {
        st.volume = v;
        applyVol();
      },
      setMuted: (m) => {
        st.muted = m;
        applyVol();
      },
      volume: () => st.volume,
      muted: () => st.muted,
      destroy: () => {
        try {
          w.pause();
        } catch {}
        iframe.remove();
      },
    };
  }

  /** Çalan şarkının kaynağına uygun oynatıcıyı hazırlar; kaynak değiştiyse yenisini kurar. */
  function ensurePlayer(cur) {
    const kind = playerKindFor(cur);
    if (S.player && S.player.kind === kind) return Promise.resolve({ player: S.player, fresh: false });
    if (S.playerCreating && S.playerCreatingKind === kind) return S.playerCreating;
    if (S.player) destroyPlayer();
    const pos = musicPos(cur);
    const play = cur.pausedAt == null && pos >= 0;
    S.playKey = cur.key;
    S.endSent = false;
    const ev = {
      onState: (s) => onPlayerState(s),
      onError: (code) => onPlayerError(code),
      onDuration: () => reportDuration(),
    };
    S.playerCreatingKind = kind;
    S.playerCreating = ({ sc: createSoundCloudPlayer, stream: createStreamPlayer, yt: createYouTubePlayer }[kind])(cur, pos, play, ev)
      .then((player) => {
        S.player = player;
        applyMusicVolume();
        return { player, fresh: true };
      })
      .catch((err) => {
        S.playKey = null;
        throw err;
      })
      .finally(() => (S.playerCreating = null));
    return S.playerCreating;
  }

  function destroyPlayer() {
    clearTimeout(S.startTimer);
    if (S.player) S.player.destroy();
    S.player = null;
    S.playKey = null;
    $('#player-box').replaceChildren();
  }

  async function syncPlayer() {
    const cur = S.music.current;
    clearTimeout(S.startTimer);
    renderMusicOff();
    if (!cur || S.musicOff) {
      // Müzik yok ya da bu kişi müziği kendinde kapattı: oynatıcıyı tamamen kapat (hiç internet harcamaz)
      if (S.player) destroyPlayer();
      return;
    }
    let p;
    try {
      ({ player: p } = await ensurePlayer(cur));
    } catch (err) {
      console.warn('müzik oynatıcı', err);
      $('#music-note').textContent =
        playerKindFor(cur) === 'stream'
          ? 'Müzik akışı başlatılamadı.'
          : (sourceOf(cur) === 'sc' ? 'SoundCloud' : 'YouTube') + ' oynatıcısı yüklenemedi. Reklam engelleyici engelliyor olabilir.';
      $('#music-note').hidden = false;
      return;
    }
    $('#music-note').hidden = true;
    if (S.music.current !== cur || S.musicOff || S.player !== p) return; // bu arada değişti; yeni çağrı halleder
    const pos = musicPos(cur);

    if (S.playKey !== cur.key) {
      S.playKey = cur.key;
      S.endSent = false;
      const play = cur.pausedAt == null && pos >= 0;
      p.load(cur, Math.max(0, pos), play);
      if (pos < 0 && cur.pausedAt == null) S.startTimer = setTimeout(syncPlayer, -pos * 1000);
      return;
    }

    const st = p.state();
    if (cur.pausedAt != null) {
      if (st === 'playing' || st === 'buffering') p.pause();
      if (Math.abs(p.time() - pos) > 1.5) p.seek(pos);
      return;
    }
    if (pos < 0) {
      S.startTimer = setTimeout(syncPlayer, -pos * 1000);
      return;
    }
    reportDuration();
    if (adLikely(cur)) return; // reklam sırasında konum düzeltmesi yapma
    if (st === 'ended') {
      // Güvenlik ağı: oynatıcı bitti ama sunucu hâlâ bu şarkıda (bildirim kaybolduysa
      // ya da erken sayıldıysa) — her eşitlemede (5 sn) tekrar bildir.
      const dur = p.duration();
      if (dur > 0 && pos >= dur - 1) {
        S.endSent = false;
        onPlayerState('ended');
      }
      return;
    }
    if (st !== 'playing' && st !== 'buffering') {
      if (Math.abs(p.time() - pos) > 1.5) p.seek(pos);
      p.play();
    } else if (st === 'playing' && Math.abs(p.time() - pos) > 2) {
      // Herkes aynı yerde olsun (kayma düzeltmesi)
      p.seek(pos);
    }
  }

  /** Oynatıcıdaki parça gerçekten çalınan şarkı mı (geçiş anlarında eski parça olabilir) */
  function playerOnCurrent(cur) {
    const id = S.player && S.player.currentId();
    return !id || id === cur.id;
  }

  /**
   * Reklam oynuyor olabilir mi (sadece YouTube)? Gömülü oynatıcı reklamı ayrıca bildirmez;
   * reklam sırasında süre olarak reklamın süresi döner. Bilinen süreden belirgin kısaysa reklam varsayılır.
   */
  function adLikely(cur) {
    if (!S.player || S.player.kind !== 'yt' || !cur.duration) return false;
    const d = S.player.duration();
    return d > 0 && d < cur.duration - 3;
  }

  /**
   * Gerçek süreyi sunucuya bildir (sunucu şarkının bitişini buna göre yönetir).
   * YouTube'da reklam süresi karışmasın diye ancak videoda 20 sn'yi geçtikten sonra bildirilir;
   * SoundCloud'da süre parça yüklenince kesin bilinir.
   */
  function reportDuration() {
    const cur = S.music.current;
    const p = S.player;
    if (!cur || !p || S.playKey !== cur.key || !playerOnCurrent(cur)) return;
    const d = p.duration();
    if (p.kind === 'yt' && p.time() < 20) return;
    if (!(d > 0) || (S.durReported.key === cur.key && d <= S.durReported.d + 0.5)) return;
    if (cur.duration && d <= cur.duration + 0.5) return;
    S.durReported = { key: cur.key, d };
    wsSend({ t: 'music-duration', key: cur.key, duration: d });
  }

  function onPlayerState(state) {
    const cur = S.music.current;
    const p = S.player;
    if (!cur || !p || S.playKey !== cur.key) return;
    if (state === 'playing') {
      reportDuration();
      // Çalmaya başlar başlamaz herkesle aynı yere getir (yükleme süresi kadar geride kalmasın)
      if (!adLikely(cur) && cur.pausedAt == null) {
        const pos = musicPos(cur);
        if (pos > 0 && Math.abs(p.time() - pos) > 1.5) p.seek(pos);
      }
    }
    if (state === 'ended' && !S.endSent) {
      const duration = p.duration();
      const pos = musicPos(cur);
      // Reklam bitişi, eski parçanın bitişi ya da süresi dolmamış şarkı: bildirme.
      // (Sunucu şarkıyı süresi dolunca zaten kendisi geçer.)
      if (!playerOnCurrent(cur) || adLikely(cur) || (cur.duration && pos < cur.duration - 5)) {
        console.info('müzik: erken/şüpheli bitiş yok sayıldı', JSON.stringify({ id: cur.id, duration, known: cur.duration, pos }));
        return;
      }
      S.endSent = true;
      console.info('müzik bitti bildirimi', JSON.stringify({ key: cur.key, id: cur.id, duration, known: cur.duration, pos }));
      wsSend({ t: 'music-ended', key: cur.key, duration });
    }
  }

  function onPlayerError(code) {
    console.warn('müzik oynatıcı hatası', code);
    const cur = S.music.current;
    if (!cur || S.playKey !== cur.key) return;
    // YouTube: 2 geçersiz, 5 tarayıcı oynatamadı, 100 video yok, 101/150/152 gömmeye kapalı / yaş sınırı.
    // SoundCloud: sc-snip (sadece 30 sn önizleme), sc-block, sc-error.
    // Sunucuya bildirilir; şarkı sadece odadakilerin çoğunda oynatılamıyorsa değiştirilir/geçilir.
    if (!S.endSent) {
      S.endSent = true;
      wsSend({ t: 'music-failed', key: cur.key, code });
    }
  }

  function applyMusicVolume() {
    $('#m-vol').value = S.musicVol;
    $('#m-vol-val').textContent = S.musicVol + '%';
    if (!S.player) return;
    try {
      S.player.setVolume(S.musicVol);
      S.player.setMuted(S.deafened || S.musicVol === 0);
    } catch {}
  }

  /** "Müzik bende kapalı" durumunu göster */
  function renderMusicOff() {
    const b = $('#m-off');
    if (!b) return;
    b.classList.toggle('on', S.musicOff);
    b.setAttribute('aria-checked', String(S.musicOff));
    b.textContent = S.musicOff ? 'Müzik sende kapalı' : 'Bende kapat';
    b.title = S.musicOff
      ? 'Müzik sadece sende kapalı; diğerlerinde çalıyor. Tıklayınca kaldığı yerden açılır.'
      : 'Müziği sadece kendinde kapat: hiç internet harcamaz, diğerlerinde çalmaya devam eder.';
    renderArtVisibility();
  }

  function addMusic(url, quiet) {
    url = (url || '').trim();
    if (!url) return false;
    if (!wsSend({ t: 'music-add', url })) {
      toast('Sunucuya bağlı değil.');
      return false;
    }
    if (!quiet && S.music.search && !isMusicLink(url) && !/^[A-Za-z0-9_-]{11}$/.test(url)) toast('🔎 Aranıyor: ' + url, 2500);
    return true;
  }

  /** Sohbet komutları: /play <link>, /skip, /stop, /pause, /resume */
  function chatCommand(text) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case 'play':
      case 'p':
      case 'çal':
        addMusic(rest.join(' '));
        return true;
      case 'skip':
      case 's':
      case 'geç':
        wsSend({ t: 'music-skip' });
        return true;
      case 'stop':
      case 'dur':
        wsSend({ t: 'music-stop' });
        return true;
      case 'pause':
        wsSend({ t: 'music-pause' });
        return true;
      case 'resume':
        wsSend({ t: 'music-resume' });
        return true;
      case 'prev':
      case 'önceki':
        wsSend({ t: 'music-prev' });
        return true;
      case 'loop':
      case 'tekrar': {
        const arg = (rest[0] || '').toLowerCase();
        const mode = { off: 'off', kapalı: 'off', all: 'all', liste: 'all', one: 'one', tek: 'one' }[arg] || (LOOP_INFO[S.music.loop] || LOOP_INFO.off).next;
        wsSend({ t: 'music-loop', mode });
        return true;
      }
      default:
        toast('Komutlar: /play <link ya da şarkı adı>, /skip, /prev, /stop, /pause, /resume, /loop [kapalı|liste|tek]', 5000);
        return true;
    }
  }

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  let bindingPtt = false;
  function onKeyDown(e) {
    if (bindingPtt) {
      e.preventDefault();
      if (e.code !== 'Escape') setPttKey(e.code, e.key.length === 1 ? e.key.toUpperCase() : e.code);
      bindingPtt = false;
      return;
    }
    if (!S.joined || isTyping(e) || $('#settings-dialog').open) return;
    if (S.mode === 'ptt' && e.code === S.pttKey) {
      e.preventDefault();
      if (!S.pttDown) {
        S.pttDown = true;
        applyTransmit();
      }
      return;
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM') toggleMute();
    else if (e.code === 'KeyD') toggleDeafen();
  }

  function onKeyUp(e) {
    if (S.mode === 'ptt' && e.code === S.pttKey && S.pttDown) {
      S.pttDown = false;
      applyTransmit();
    }
  }

  function onMouse(e, down) {
    // Farenin yan tuşları (Mouse4/Mouse5) bas-konuş için kullanılabilir.
    if (e.button < 3) return;
    const code = 'Mouse' + (e.button + 1);
    if (down && bindingPtt) {
      e.preventDefault();
      setPttKey(code, code);
      bindingPtt = false;
      return;
    }
    if (S.joined && S.mode === 'ptt' && code === S.pttKey) {
      e.preventDefault();
      S.pttDown = down;
      applyTransmit();
    }
  }

  function setPttKey(code, label) {
    S.pttKey = code;
    S.pttLabel = label;
    store.set('pttKey', code);
    store.set('pttLabel', label);
    $('#ptt-key-btn').textContent = label;
    renderSelf();
  }

  function renderSettings() {
    for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === S.mode;
    $('#ptt-row').hidden = S.mode !== 'ptt';
    $('#ptt-hint').hidden = S.mode !== 'ptt';
    $('#ptt-key-btn').textContent = S.pttLabel;
    $('#gate-range').value = S.gate;
    const g = effectiveGate();
    $('#auto-gate-check').checked = S.autoGate;
    $('#gate-range').value = S.autoGate ? Math.max(g, GATE_OFF) : S.gate;
    $('#gate-val').textContent = autoGateActive()
      ? 'otomatik · konuşma algılama'
      : S.autoGate
        ? 'otomatik · yapay zekâ kapalıyken devre dışı'
        : g <= GATE_OFF
          ? 'kapalı'
          : `${g} dB`;
    $('#gate-val').textContent = '(' + $('#gate-val').textContent + ')';
    $('#gate-mark').style.left = ((Math.max(g, GATE_OFF) + 80) / 80) * 100 + '%';
    $('#ai-ns-check').checked = S.aiNs;
    $('#ns-check').checked = S.ns && !S.aiNs;
    $('#ns-check').disabled = S.aiNs;
    $('#ns-check').parentElement.title = S.aiNs ? 'Yapay zekâ gürültü engelleme açıkken kapalıdır (ikisi birlikte daha kötü sonuç veriyor).' : '';
    $('#ec-check').checked = S.ec;
    $('#agc-check').checked = S.agc;
  }

  // =====================================================================
  // Giriş / çıkış
  // =====================================================================
  function showJoinError(text) {
    const el = $('#join-error');
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
  }

  function showRoom() {
    $('#join-view').hidden = true;
    $('#room-view').hidden = false;
    $('#room-name').textContent = S.room;
    $('#vs-room').textContent = S.room;
    $('#stage-room').textContent = S.room;
    document.title = `${S.room} · Yankı`;
    const btn = $('#join-btn');
    btn.disabled = false;
    btn.textContent = 'Kanala katıl';
    $('#listen-only-btn').hidden = true;
    showJoinError(null);
    updateCount();
  }

  async function joinRoom(listenOnly) {
    showJoinError(null);
    const name = $('#name-input').value.replace(/\s+/g, ' ').trim().slice(0, 24);
    const room = $('#room-input').value.trim().toLowerCase();
    if (!name) return showJoinError('Kullanıcı adı gerekli.');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(room)) return showJoinError('Oda adı yalnızca harf, rakam ve tire içerebilir.');
    if (!window.isSecureContext || !navigator.mediaDevices || !window.RTCPeerConnection) {
      return showJoinError('Bu sayfa HTTPS üzerinden açılmalı ve tarayıcı WebRTC desteklemeli (Chrome, Edge, Firefox, Safari).');
    }
    store.set('name', name);
    store.set('lastRoom', room);
    S.name = name;
    S.room = room;
    S.micId = $('#join-mic').value || S.micId;

    const btn = $('#join-btn');
    btn.disabled = true;
    btn.textContent = 'Mikrofon açılıyor…';

    // AudioContext kullanıcı etkileşimi içinde oluşturulmalı.
    if (!S.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        try {
          // RNNoise 48 kHz ile çalışır
          S.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
        } catch {
          S.ctx = new AC({ latencyHint: 'interactive' });
        }
        S.ctx.onstatechange = () => {
          // Ses bağlamı askıya alınırsa (uyku vb.) işlenmiş mikrofon sessizleşir; geri aç.
          if (S.joined && S.ctx.state !== 'running' && S.ctx.state !== 'closed') S.ctx.resume().catch(() => {});
        };
        if (S.outId && S.ctx.setSinkId) S.ctx.setSinkId(S.outId).catch(() => {});
      } catch {}
    }
    if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});

    if (!listenOnly) {
      try {
        const stream = await acquireMic();
        S.joined = true; // setMicStream içindeki kontroller için
        await setMicStream(stream);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Kanala katıl';
        S.joined = false;
        showJoinError(micErrorText(err));
        $('#listen-only-btn').hidden = false;
        return;
      }
    }

    S.joined = true;
    S.welcomed = false;
    S.wsAttempt = 0;
    btn.textContent = 'Bağlanılıyor…';
    history.replaceState(null, '', '/r/' + encodeURIComponent(room) + location.search);

    S.selfEl = makeCard(name, true);
    S.selfEl.classList.add('self');
    $('#participants').prepend(S.selfEl);
    renderSelf();
    connectWs();
  }

  function leaveRoom(sendLeave = true) {
    if (S.screen) stopShare();
    if (S.cam) stopCam();
    if (sendLeave) wsSend({ t: 'leave' });
    S.joined = false;
    S.welcomed = false;
    clearTimeout(S.wsTimer);
    stopPing();
    if (S.ws) {
      const ws = S.ws;
      S.ws = null;
      ws.onclose = ws.onmessage = ws.onopen = null;
      try {
        ws.close(1000);
      } catch {}
    }
    for (const p of [...S.peers.values()]) removePeer(p);
    // Sadece ham mikrofonu kapat; işlenmiş iz (RNNoise çıkışı) sonraki katılımda tekrar kullanılır.
    if (S.rawStream) S.rawStream.getTracks().forEach((t) => t.stop());
    if (S.procSrc) {
      try {
        S.procSrc.disconnect();
      } catch {}
    }
    if (S.analysisTrack) S.analysisTrack.stop();
    if (S.meterSrc && S.meterNode) {
      try {
        S.meterSrc.disconnect(S.meterNode);
      } catch {}
    }
    S.stream = S.track = S.analysisTrack = S.meterSrc = S.rawStream = S.rawTrack = S.procSrc = null;
    S.music = { queue: [], current: null, history: [], loop: 'off', search: false };
    destroyPlayer();
    renderMusic();
    if (S.selfEl) S.selfEl.remove();
    S.selfEl = null;
    S.id = randomId(); // yeni katılım = yeni kimlik
    S.deafened = false;
    $('#participants').innerHTML = '';
    $('#side-members').innerHTML = '';
    $('#screens').innerHTML = '';
    $('.stage').classList.remove('has-screens', 'focus');
    $('.user-panel').classList.remove('speaking');
    resetChat();
    clearPending();
    hideMusicResults();
    $('#music-panel').classList.remove('open');
    banner(null);
    $('#room-view').hidden = true;
    $('#join-view').hidden = false;
    const btn = $('#join-btn');
    btn.disabled = false;
    btn.textContent = 'Kanala katıl';
    document.title = 'Yankı';
  }

  // =====================================================================
  // Başlatma
  // =====================================================================
  const ADJ = ['mavi', 'gece', 'kahve', 'yildiz', 'bulut', 'deniz', 'ruzgar', 'gunes', 'ay', 'kirmizi'];
  const NOUN = ['odasi', 'kosesi', 'meclisi', 'kanali', 'ekibi'];
  function randomRoom() {
    const r = (a) => a[Math.floor(Math.random() * a.length)];
    return `${r(ADJ)}-${r(NOUN)}-${Math.floor(100 + Math.random() * 900)}`;
  }

  function init() {
    const m = location.pathname.match(/^\/r\/([^/]+)/);
    const fromUrl = m ? decodeURIComponent(m[1]).toLowerCase() : '';
    $('#name-input').value = store.get('name', '');
    $('#room-input').value = fromUrl || randomRoom();
    if (fromUrl) $('#join-btn').textContent = 'Kanala katıl';
    (store.get('name', '') ? $('#join-btn') : $('#name-input')).focus();

    // "Sadece dinleyici" butonu (mikrofon açılamazsa görünür)
    const lo = document.createElement('button');
    lo.type = 'button';
    lo.id = 'listen-only-btn';
    lo.className = 'btn ghost';
    lo.style.width = '100%';
    lo.style.marginTop = '8px';
    lo.textContent = 'Mikrofonsuz (sadece dinleyici) katıl';
    lo.hidden = true;
    lo.onclick = () => joinRoom(true);
    $('#join-btn').after(lo);

    $('#join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      joinRoom(false);
    });
    $('#random-room').onclick = () => ($('#room-input').value = randomRoom());

    $('#mute-btn').onclick = toggleMute;
    $('#deafen-btn').onclick = toggleDeafen;
    $('#leave-btn').onclick = () => {
      leaveRoom(true);
      history.replaceState(null, '', '/r/' + encodeURIComponent(S.room) + location.search);
    };
    $('#copy-link').onclick = async () => {
      const link = `${location.origin}/r/${encodeURIComponent(S.room)}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link kopyalandı: ' + link);
      } catch {
        window.prompt('Linki kopyala:', link);
      }
    };
    $('#invite-btn').onclick = () => $('#copy-link').click();
    // Kişi menüsü
    const mm = $('#member-menu');
    const mmVol = mm.querySelector('.vol');
    mmVol.oninput = () => menuPeer && setPeerVolume(menuPeer, Number(mmVol.value));
    mmVol.ondblclick = () => {
      mmVol.value = 100;
      mmVol.oninput();
    };
    mm.querySelector('.local-mute').onclick = () => {
      if (!menuPeer) return;
      menuPeer.localMuted = !menuPeer.localMuted;
      applyPeerAudio(menuPeer);
      renderPeer(menuPeer);
    };
    document.addEventListener('mousedown', (e) => {
      if (!mm.hidden && !mm.contains(e.target) && !e.target.closest('.sm-more')) closeMemberMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !mm.hidden) closeMemberMenu();
    });
    // Kutu düzeni: sahne boyutu ya da kişi sayısı değişince
    if (window.ResizeObserver) new ResizeObserver(() => layoutTiles()).observe($('#participants'));
    new MutationObserver(() => layoutTiles()).observe($('#participants'), { childList: true });
    $('#share-btn').onclick = () => (S.screen ? stopShare() : startShare());
    $('#cam-btn').onclick = () => (S.cam ? stopCam() : startCam());
    renderSelfCam();
    $('#cam-select').onchange = (e) => {
      S.camId = e.target.value;
      store.set('camId', S.camId);
      if (S.cam) {
        stopCam();
        startCam();
      }
    };
    $('#share-btn').hidden = !canShare;
    $('#stage-invite').onclick = () => $('#copy-link').click();
    initChat();

    // Müzik paneli
    $('#music-btn').onclick = () => $('#music-panel').classList.toggle('open');
    $('#music-close').onclick = () => $('#music-panel').classList.remove('open');
    $('#np-pill').onclick = () => $('#music-panel').classList.add('open');
    $('#music-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitMusic();
    });
    $('#music-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideMusicResults();
    });
    $('#music-input').addEventListener('input', (e) => {
      if (!e.target.value.trim()) hideMusicResults();
    });
    $('#np-bar').onclick = (e) => {
      const cur = S.music.current;
      const dur = cur && musicDuration(cur);
      if (!dur) return;
      const r = e.currentTarget.getBoundingClientRect();
      wsSend({ t: 'music-seek', pos: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur });
    };
    $('#np-bar').onmousemove = (e) => {
      const cur = S.music.current;
      const dur = cur && musicDuration(cur);
      if (!dur) return;
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.title = 'Herkes için ' + (fmtDur(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur) || '0:00') + ' konumuna sar';
    };
    $('#m-shuffle').onclick = () => wsSend({ t: 'music-shuffle' });
    setInterval(() => S.joined && updateProgress(), 500);
    $('#m-pause').onclick = () => {
      const cur = S.music.current;
      if (cur) wsSend({ t: cur.pausedAt != null ? 'music-resume' : 'music-pause' });
    };
    $('#m-skip').onclick = () => wsSend({ t: 'music-skip' });
    $('#m-prev').onclick = () => wsSend({ t: 'music-prev' });
    $('#m-loop').onclick = () => wsSend({ t: 'music-loop', mode: (LOOP_INFO[S.music.loop] || LOOP_INFO.off).next });
    $('#m-stop').onclick = () => wsSend({ t: 'music-stop' });
    $('#m-off').onclick = () => {
      S.musicOff = !S.musicOff;
      store.set('musicOff', S.musicOff);
      syncPlayer();
    };
    $('#m-vol').oninput = (e) => {
      S.musicVol = Number(e.target.value);
      store.set('musicVol', S.musicVol);
      applyMusicVolume();
    };
    applyMusicVolume();
    renderMusicOff();
    setInterval(() => {
      if (S.joined && S.music.current && S.player) syncPlayer();
    }, 5000);

    // Ayarlar
    const dlg = $('#settings-dialog');
    $('#settings-btn').onclick = () => {
      renderSettings();
      refreshDevices();
      dlg.showModal();
    };
    $('#mic-select').onchange = (e) => {
      S.micId = e.target.value;
      store.set('micId', S.micId);
      if (S.joined) switchMic();
    };
    $('#out-select').onchange = (e) => {
      S.outId = e.target.value;
      store.set('outId', S.outId);
      applyOutput();
    };
    for (const r of document.querySelectorAll('input[name=mode]')) {
      r.onchange = () => {
        S.mode = r.value;
        S.pttDown = false;
        store.set('mode', S.mode);
        renderSettings();
        applyTransmit();
        renderSelf();
      };
    }
    $('#ptt-key-btn').onclick = () => {
      bindingPtt = true;
      $('#ptt-key-btn').textContent = 'Bir tuşa bas…';
    };
    $('#gate-range').oninput = (e) => {
      // Kaydırıcıyı elle oynatmak manuel moda geçirir
      S.gate = Number(e.target.value);
      S.autoGate = false;
      store.set('gate', S.gate);
      store.set('autoGate', false);
      renderSettings();
    };
    $('#auto-gate-check').onchange = (e) => {
      S.autoGate = e.target.checked;
      store.set('autoGate', S.autoGate);
      renderSettings();
    };
    $('#ai-ns-check').onchange = (e) => {
      S.aiNs = e.target.checked;
      store.set('aiNs', S.aiNs);
      renderSettings();
      // Tarayıcının gürültü engellemesi de değiştiği için mikrofon yeniden açılır
      if (S.joined && S.rawTrack) switchMic().then(renderSettings);
    };
    for (const [id, key] of [
      ['#ns-check', 'ns'],
      ['#ec-check', 'ec'],
      ['#agc-check', 'agc'],
    ]) {
      $(id).onchange = (e) => {
        S[key] = e.target.checked;
        store.set(key, S[key]);
        if (S.joined && S.track) switchMic();
      };
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', (e) => onMouse(e, true), true);
    window.addEventListener('mouseup', (e) => onMouse(e, false), true);
    window.addEventListener('blur', () => {
      // Pencere odak kaybederse bas-konuş takılı kalmasın.
      if (S.pttDown) {
        S.pttDown = false;
        applyTransmit();
      }
    });
    window.addEventListener('online', () => {
      if (S.joined && !S.ws) {
        S.wsAttempt = 0;
        connectWs();
      }
    });
    window.addEventListener('pagehide', () => {
      if (S.joined) wsSend({ t: 'leave' });
    });
    window.addEventListener('pageshow', (e) => {
      // Geri/ileri önbelleğinden dönülürse bağlantılar ölüdür; temiz başla.
      if (e.persisted) location.reload();
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    }

    setInterval(watchdog, 2000);
    setInterval(remoteLevels, 100);
    setInterval(collectStats, 3000);
    setInterval(reportStats, 10000);
    refreshDevices();
  }

  init();
})();
