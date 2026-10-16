'use strict';
/*
 * RiftVoice istemcisi.
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
    music: { queue: [], current: null },
    musicVol: store.get('musicVol', 35),
    yt: null,
    ytCreating: null,
    ytKey: null,
    ytEndedSent: false,
    ytReported: { key: null, d: 0 },
    ytStartTimer: null,
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
    transmitting: false,
    unread: 0,
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

  function chatAppend(name, text, ts, sys) {
    const log = $('#chat-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const div = document.createElement('div');
    div.className = 'chat-msg' + (sys ? ' sys' : '');
    if (sys) {
      div.textContent = text;
    } else {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = name;
      const tx = document.createElement('span');
      tx.className = 'text';
      tx.textContent = text;
      const tm = document.createElement('span');
      tm.className = 'time';
      tm.textContent = fmtTime(ts);
      div.append(who, tx, tm);
    }
    log.appendChild(div);
    while (log.children.length > 300) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
    const chatHidden =
      $('#tab-chat').classList.contains('tab-off') ||
      (!$('#chat-panel').classList.contains('open') && getComputedStyle($('#chat-btn')).display !== 'none');
    if (!sys && chatHidden) {
      S.unread++;
      const badge = $('#chat-badge');
      badge.textContent = S.unread;
      badge.hidden = false;
    }
  }

  function makeCard(name, isSelf) {
    const el = $('#participant-tpl').content.firstElementChild.cloneNode(true);
    el.querySelector('.initial').textContent = (name || '?').trim().charAt(0).toUpperCase();
    el.querySelector('.name').textContent = name;
    el.querySelector('.you').hidden = !isSelf;
    if (!isSelf) el.querySelector('.p-volume').hidden = false;
    return el;
  }

  function setCardStatus(el, kind, text) {
    const dot = el.querySelector('.dot');
    dot.className = 'dot ' + (kind || '');
    el.querySelector('.status-text').textContent = text;
  }

  function setSpeaking(el, on) {
    if (el && el.classList.contains('speaking') !== on) el.classList.toggle('speaking', on);
  }

  function updateCount() {
    $('#member-count').textContent = `${S.peers.size + 1} kişi`;
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

    $('#mute-btn').classList.toggle('off', S.muted || S.deafened || !S.track);
    $('#mute-btn .ico').textContent = S.muted || S.deafened || !S.track ? '🔇' : '🎙️';
    $('#deafen-btn').classList.toggle('off', S.deafened);
    $('#deafen-btn .ico').textContent = S.deafened ? '🙉' : '🎧';
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
    const lm = p.el.querySelector('.local-mute');
    lm.classList.toggle('on', p.localMuted);
    lm.textContent = p.localMuted ? '🔇' : '🔈';
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
    if (fill && $('#settings-dialog').open) fill.style.width = pct + '%';
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
      wsSend({ t: 'join', room: S.room, id: S.id, name: S.name, muted: S.muted || !S.track, deafened: S.deafened });
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
    ws.onclose = () => {
      clearTimeout(openTimeout);
      if (S.ws !== ws) return;
      S.ws = null;
      stopPing();
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
        chatAppend(m.name, m.text, m.ts, false);
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
    if (first && S.peers.size === 0) chatAppend('', 'Odada şu an kimse yok. Linki arkadaşlarına gönder!', 0, true);
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
    if (p.online) p.absentSince = 0;
    renderPeer(p);
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
        el: null,
      };
      S.peers.set(p.id, p);
      p.el = makeCard(p.name, false);
      const vol = p.el.querySelector('.vol');
      vol.value = p.volume;
      vol.oninput = () => {
        p.volume = Number(vol.value);
        store.set('vol:' + p.name, p.volume);
        applyPeerAudio(p);
      };
      p.el.querySelector('.local-mute').onclick = () => {
        p.localMuted = !p.localMuted;
        applyPeerAudio(p);
        renderPeer(p);
      };
      $('#participants').appendChild(p.el);
      updateCount();
    } else {
      p.name = info.name;
      p.muted = !!info.muted;
      p.deafened = !!info.deafened;
      p.online = info.online !== false;
    }
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
    if (p.el) p.el.remove();
    S.peers.delete(p.id);
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
      attachRemote(p, e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        p.attempts = 0;
        p.badSince = 0;
        tuneSenders(pc);
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
    renderPeer(p);
    // negotiationneeded olayı teklifi gönderecek.
  }

  function attachLocalTrack(p) {
    const pc = p.pc;
    if (!pc) return;
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track.kind !== 'audio' || t.stopped) continue;
      if (t.sender.track !== S.track) t.sender.replaceTrack(S.track).catch(() => {});
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
    }
  }

  function tuneSenders(pc) {
    for (const s of pc.getSenders()) {
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
      } catch (err) {
        console.warn('analyser', err);
      }
    }
  }

  function applyPeerAudio(p) {
    if (!p.audio) return;
    p.audio.volume = Math.max(0, Math.min(1, p.volume / 100));
    p.audio.muted = S.deafened || p.localMuted;
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
  function publishState() {
    wsSend({ t: 'state', muted: S.muted || !S.track, deafened: S.deafened });
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
    for (const p of S.peers.values()) applyPeerAudio(p);
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
    S.music = { queue: Array.isArray(m.queue) ? m.queue : [], current: m.current || null };
    if (m.event) chatAppend('', m.event, 0, true);
    renderMusic();
    syncPlayer();
  }

  function renderMusic() {
    const cur = S.music.current;
    $('#now-playing').hidden = !cur;
    $('#music-empty').hidden = !!cur;
    if (cur) {
      $('#np-title').textContent = cur.title;
      $('#np-sub').textContent = (cur.author ? cur.author + ' · ' : '') + 'ekleyen: ' + cur.by;
      $('#m-pause').textContent = cur.pausedAt != null ? '▶️' : '⏸️';
      $('#m-pause').title = cur.pausedAt != null ? 'Devam ettir (herkes için)' : 'Duraklat (herkes için)';
    }
    const pill = $('#np-pill');
    pill.hidden = !cur;
    if (cur) pill.querySelector('span').textContent = cur.title;
    $('#music-dot').hidden = !cur;

    const list = $('#music-queue');
    list.innerHTML = '';
    for (const item of S.music.queue) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 'q-title';
      t.textContent = item.title;
      const by = document.createElement('span');
      by.className = 'q-by';
      by.textContent = item.by;
      const rm = document.createElement('button');
      rm.className = 'btn tiny ghost';
      rm.textContent = '✕';
      rm.title = 'Sıradan çıkar';
      rm.onclick = () => wsSend({ t: 'music-remove', key: item.key });
      li.append(t, by, rm);
      list.appendChild(li);
    }
    $('#queue-head').hidden = S.music.queue.length === 0;
  }

  let ytApi = null;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApi) return ytApi;
    ytApi = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('YouTube yüklenemedi'));
      document.head.appendChild(tag);
      setTimeout(() => reject(new Error('YouTube zaman aşımı')), 15000);
    });
    ytApi.catch(() => (ytApi = null));
    return ytApi;
  }

  /** Oynatıcıyı ilk şarkıyla birlikte oluşturur (boş oluşturulan oynatıcı YouTube'da hata 2 verir). */
  function ensurePlayer(cur) {
    if (S.yt) return Promise.resolve(S.yt);
    if (S.ytCreating) return S.ytCreating;
    S.ytCreating = loadYouTubeApi()
      .then(
        (YT) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('oynatıcı hazır olmadı')), 15000);
            const pos = musicPos(cur);
            const playNow = cur.pausedAt == null && pos >= 0;
            S.ytKey = cur.key;
            S.ytEndedSent = false;
            const player = new YT.Player('yt-player', {
              width: '100%',
              height: '100%',
              videoId: cur.id,
              playerVars: {
                autoplay: playNow ? 1 : 0,
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
                  S.yt = player;
                  applyMusicVolume();
                  resolve(player);
                },
                onStateChange: onYtState,
                onError: onYtError,
              },
            });
          })
      )
      .catch((err) => {
        S.ytKey = null;
        throw err;
      })
      .finally(() => (S.ytCreating = null));
    return S.ytCreating;
  }

  function destroyPlayer() {
    clearTimeout(S.ytStartTimer);
    if (S.yt) {
      try {
        S.yt.destroy();
      } catch {}
    }
    S.yt = null;
    S.ytKey = null;
    $('#player-box').innerHTML = '<div id="yt-player"></div>';
  }

  async function syncPlayer() {
    const cur = S.music.current;
    clearTimeout(S.ytStartTimer);
    if (!cur) {
      S.ytKey = null;
      if (S.yt) {
        try {
          S.yt.stopVideo();
        } catch {}
      }
      return;
    }
    let p;
    try {
      p = await ensurePlayer(cur);
    } catch (err) {
      console.warn('youtube', err);
      $('#music-note').textContent = 'YouTube oynatıcısı yüklenemedi. Reklam engelleyici YouTube\'u engelliyor olabilir.';
      $('#music-note').hidden = false;
      return;
    }
    $('#music-note').hidden = true;
    if (S.music.current !== cur) return; // bu arada değişti; yeni çağrı halleder
    const YTS = window.YT.PlayerState;
    const pos = musicPos(cur);

    if (S.ytKey !== cur.key) {
      S.ytKey = cur.key;
      S.ytEndedSent = false;
      if (cur.pausedAt != null || pos < 0) p.cueVideoById({ videoId: cur.id, startSeconds: Math.max(0, pos) });
      else p.loadVideoById({ videoId: cur.id, startSeconds: pos });
      if (pos < 0 && cur.pausedAt == null) S.ytStartTimer = setTimeout(syncPlayer, -pos * 1000);
      return;
    }

    const st = p.getPlayerState();
    if (cur.pausedAt != null) {
      if (st === YTS.PLAYING || st === YTS.BUFFERING) p.pauseVideo();
      if (Math.abs((p.getCurrentTime() || 0) - pos) > 1.5) p.seekTo(pos, true);
      return;
    }
    if (pos < 0) {
      S.ytStartTimer = setTimeout(syncPlayer, -pos * 1000);
      return;
    }
    reportDuration();
    if (adLikely(cur)) return; // reklam sırasında konum düzeltmesi yapma
    if (st === YTS.ENDED) {
      // Güvenlik ağı: oynatıcı bitti ama sunucu hâlâ bu şarkıda (bildirim kaybolduysa
      // ya da erken sayıldıysa) — her eşitlemede (5 sn) tekrar bildir.
      let dur = 0;
      try {
        dur = p.getDuration();
      } catch {}
      if (dur > 0 && pos >= dur - 1) {
        S.ytEndedSent = false;
        onYtState({ data: YTS.ENDED });
      }
      return;
    }
    if (st !== YTS.PLAYING && st !== YTS.BUFFERING) {
      if (Math.abs((p.getCurrentTime() || 0) - pos) > 1.5) p.seekTo(pos, true);
      p.playVideo();
    } else if (st === YTS.PLAYING && Math.abs(p.getCurrentTime() - pos) > 2) {
      // Herkes aynı yerde olsun (kayma düzeltmesi)
      p.seekTo(pos, true);
    }
  }

  /** Oynatıcıdaki video gerçekten çalınan şarkı mı (geçiş anlarında eski video olabilir) */
  function playerOnCurrent(cur) {
    try {
      const vid = S.yt.getVideoData().video_id;
      return !vid || vid === cur.id;
    } catch {
      return true;
    }
  }

  /**
   * Reklam oynuyor olabilir mi? Gömülü oynatıcı reklamı ayrıca bildirmez; reklam sırasında
   * getDuration() reklamın süresini döndürür. Sunucunun bildiği (en büyük) süreden belirgin
   * şekilde kısaysa reklam varsayılır.
   */
  function adLikely(cur) {
    if (!S.yt || !cur.duration) return false;
    let d = 0;
    try {
      d = S.yt.getDuration();
    } catch {}
    return d > 0 && d < cur.duration - 3;
  }

  /**
   * Gerçek video süresini sunucuya bildir (sunucu şarkının bitişini buna göre yönetir).
   * Reklam sırasında oynatıcı reklamın süresini verebildiği için, ancak videoda 20 sn'yi
   * geçtikten sonra bildirilir (reklamlar genelde daha kısadır).
   */
  function reportDuration() {
    const cur = S.music.current;
    if (!cur || !S.yt || S.ytKey !== cur.key || !playerOnCurrent(cur)) return;
    let d = 0;
    let t = 0;
    try {
      d = S.yt.getDuration();
      t = S.yt.getCurrentTime();
    } catch {}
    if (t < 20) return;
    if (!(d > 0) || (S.ytReported.key === cur.key && d <= S.ytReported.d + 0.5)) return;
    if (cur.duration && d <= cur.duration + 0.5) return;
    S.ytReported = { key: cur.key, d };
    wsSend({ t: 'music-duration', key: cur.key, duration: d });
  }

  function onYtState(e) {
    const cur = S.music.current;
    if (!cur || S.ytKey !== cur.key) return;
    const YTS = window.YT.PlayerState;
    if (e.data === YTS.PLAYING) reportDuration();
    if (e.data === YTS.ENDED && !S.ytEndedSent) {
      let duration = null;
      try {
        duration = S.yt.getDuration();
      } catch {}
      const pos = musicPos(cur);
      // Reklam bitişi, eski videonun bitişi ya da süresi dolmamış şarkı: bildirme.
      // (Sunucu şarkıyı süresi dolunca zaten kendisi geçer.)
      if (!playerOnCurrent(cur) || adLikely(cur) || (cur.duration && pos < cur.duration - 5)) {
        console.info('müzik: erken/şüpheli bitiş yok sayıldı', JSON.stringify({ id: cur.id, duration, known: cur.duration, pos }));
        return;
      }
      S.ytEndedSent = true;
      console.info('müzik bitti bildirimi', JSON.stringify({ key: cur.key, id: cur.id, duration, known: cur.duration, pos }));
      wsSend({ t: 'music-ended', key: cur.key, duration });
    }
  }

  function onYtError(e) {
    console.warn('YouTube oynatıcı hatası', e.data);
    const cur = S.music.current;
    if (!cur || S.ytKey !== cur.key) return;
    // 2: geçersiz kimlik, 5: tarayıcı oynatamadı, 100: video yok/özel,
    // 101/150/152: sahibi başka sitelerde oynatmayı kapatmış ya da yaş sınırlı.
    // Sunucuya bildirilir; şarkı sadece odadakilerin çoğunda oynatılamıyorsa geçilir.
    if (!S.ytEndedSent) {
      S.ytEndedSent = true;
      wsSend({ t: 'music-failed', key: cur.key, code: e.data });
    }
  }

  function applyMusicVolume() {
    $('#m-vol').value = S.musicVol;
    if (!S.yt || !S.yt.setVolume) return;
    try {
      S.yt.setVolume(S.musicVol);
      if (S.deafened || S.musicVol === 0) S.yt.mute();
      else S.yt.unMute();
    } catch {}
  }

  function setSideTab(name) {
    for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === name);
    // Müzik sekmesi gizlenirken display:none yerine ekran dışına alınır ki oynatıcı çalmaya devam etsin.
    $('#tab-chat').classList.toggle('tab-off', name !== 'chat');
    $('#tab-music').classList.toggle('tab-off', name !== 'music');
    if (name === 'chat') {
      S.unread = 0;
      $('#chat-badge').hidden = true;
    }
  }

  function addMusic(url) {
    url = (url || '').trim();
    if (!url) return false;
    if (!wsSend({ t: 'music-add', url })) {
      toast('Sunucuya bağlı değil.');
      return false;
    }
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
      default:
        toast('Komutlar: /play <youtube linki>, /skip, /stop, /pause, /resume', 4000);
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
    document.title = `${S.room} · RiftVoice`;
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
    $('#participants').prepend(S.selfEl);
    renderSelf();
    connectWs();
  }

  function leaveRoom(sendLeave = true) {
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
    S.music = { queue: [], current: null };
    destroyPlayer();
    renderMusic();
    if (S.selfEl) S.selfEl.remove();
    S.selfEl = null;
    S.id = randomId(); // yeni katılım = yeni kimlik
    S.deafened = false;
    $('#participants').innerHTML = '';
    $('#chat-log').innerHTML = '';
    banner(null);
    $('#room-view').hidden = true;
    $('#join-view').hidden = false;
    const btn = $('#join-btn');
    btn.disabled = false;
    btn.textContent = 'Kanala katıl';
    document.title = 'RiftVoice';
  }

  // =====================================================================
  // Başlatma
  // =====================================================================
  const ADJ = ['baron', 'ejder', 'nexus', 'kule', 'orman', 'koridor', 'rift', 'elder', 'herald', 'minyon'];
  const NOUN = ['takimi', 'ekibi', 'kadrosu', 'mangasi', 'grubu'];
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
    $('#chat-btn').onclick = () => {
      const panel = $('#chat-panel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open') && !$('#tab-chat').classList.contains('tab-off')) {
        S.unread = 0;
        $('#chat-badge').hidden = true;
        $('#chat-input').focus();
      }
    };
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      if (text.startsWith('/')) {
        chatCommand(text);
        input.value = '';
        return;
      }
      if (!wsSend({ t: 'chat', text })) return toast('Sunucuya bağlı değil, mesaj gönderilemedi.');
      input.value = '';
    });

    // Yan panel sekmeleri + müzik
    for (const b of document.querySelectorAll('.side-tab')) b.onclick = () => setSideTab(b.dataset.tab);
    $('#np-pill').onclick = () => {
      setSideTab('music');
      $('#chat-panel').classList.add('open');
    };
    $('#music-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (addMusic($('#music-input').value)) $('#music-input').value = '';
    });
    $('#m-pause').onclick = () => {
      const cur = S.music.current;
      if (cur) wsSend({ t: cur.pausedAt != null ? 'music-resume' : 'music-pause' });
    };
    $('#m-skip').onclick = () => wsSend({ t: 'music-skip' });
    $('#m-stop').onclick = () => wsSend({ t: 'music-stop' });
    $('#m-vol').oninput = (e) => {
      S.musicVol = Number(e.target.value);
      store.set('musicVol', S.musicVol);
      applyMusicVolume();
    };
    applyMusicVolume();
    setInterval(() => {
      if (S.joined && S.music.current && S.yt) syncPlayer();
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
    refreshDevices();
  }

  init();
})();
