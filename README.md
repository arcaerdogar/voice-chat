# Yankı

Arkadaşlarla oyun oynarken ya da takılırken kullanmak için hafif, kurulum gerektirmeyen, **çökmemesi için tasarlanmış** web tabanlı sesli sohbet ve ortak müzik. Arayüz Discord tarzındadır.

Linki aç → adını yaz → **Kanala katıl**. Aynı oda linkini açan herkes aynı kanaldadır.

## Neden çökmez?

| Sorun | Yankı'ta ne olur |
|---|---|
| Sunucu çöker / yeniden başlar / yeni sürüm deploy edilir | Ses **kesilmez**. Ses sunucudan değil, oyuncular arasında doğrudan (WebRTC P2P) akar. İstemciler sunucuya otomatik yeniden bağlanıp odaya geri döner. |
| İnternetin bir anlığına gider | Sinyal bağlantısı üstel geri çekilmeyle yeniden kurulur; sunucu seni 20 sn boyunca odada tutar. |
| İki oyuncu arasındaki bağlantı kopar | Her bağlantıyı bir "bekçi" izler; kopan bağlantı birkaç saniye içinde sıfırdan yeniden kurulur. |
| Mikrofon çıkar / değişir | Otomatik yeniden yakalanır; ayarlardan cihaz değiştirmek bağlantıyı koparmaz. |
| Sunucu bozuk/kötü niyetli mesaj alır | Doğrulanır, hız sınırına tabidir, süreç düşmez. |

Bu senaryoların hepsi `test/e2e.test.js` içinde gerçek Chrome örnekleriyle test edilir (sunucuyu kapatıp açmak dahil).

## Özellikler

- Opus ses, yankı engelleme, otomatik kazanç (ayarlardan kapatılabilir)
- **Yapay zekâ gürültü engelleme (RNNoise)**: hoparlörden mikrofona giren oyun efektleri, klavye, fan sesi silinir; konuşma korunur
- **Otomatik ses eşiği**: konuşmadığın anlarda mikrofon tamamen susar (RNNoise'un konuşma algılamasıyla). Sekme arka plandayken de çalışır (AudioWorklet)
- **Müzik botu**: YouTube / SoundCloud linki ya da (API anahtarıyla) şarkı adı ekle, odadaki herkeste aynı anda çalar. Ortak sıra, önceki şarkı, liste/tek şarkı tekrarı, son çalınanlar, duraklat/geç/durdur, kişisel müzik sesi; sohbette `/play`, `/skip`, `/prev`, `/loop`, `/stop`, `/pause`, `/resume`
- **Kişi sesi %0–200**: sessiz konuşan arkadaşını iki katına kadar yükselt (sınırlayıcıyla, patlamadan). Tüm ses kaydırıcıları yüzde olarak gösterilir
- Açık mikrofon veya bas-konuş (klavye tuşu ya da farenin yan tuşları)
- Kişi bazlı ses seviyesi ve yerel susturma
- Konuşan kişinin kartı yeşil parlar, her kişinin gecikmesi (ms) ve bağlantının röle (TURN) üzerinden olup olmadığı görünür
- Bağlantı kurulamazsa kartta sebebi yazar ("ağ kısıtlaması")
- Mikrofon (M) / kulaklık (D) kısayolları, susturma ve katılma/ayrılma için bip sesleri (oyundayken ekrana bakmadan anlarsın)
- Yazılı sohbet, kopyalanabilir oda linki, mobil uyumlu arayüz
- Hesap yok, veritabanı yok, tek bağımlılık (`ws`)

## Oyun sırasında kullanım ipuçları

- **Chrome veya Edge** önerilir. Sekmeyi açık bırakın (küçültebilirsiniz).
- Tarayıcılar, oyun tam ekrandayken klavyeyi dinleyemez. Bu yüzden **bas-konuş yalnızca sekme odaktayken çalışır**.
  Oyunda **Açık mikrofon + Ses eşiği** kullanın: Ayarlar → Ses eşiğini, konuşmadığınızda çubuğun hemen sağına gelecek şekilde ayarlayın.
- Hoparlörden oyun oynuyorsanız **Yapay zekâ gürültü engelleme** ve **Otomatik eşik** açık kalsın (varsayılan).
  En iyi sonuç yine de kulaklıkla alınır.

## Gürültü engelleme: ne yapar, ne yapamaz?

Tarayıcının yankı engellemesi sadece tarayıcının kendi çaldığı sesi (arkadaşlarının sesi) bilir; oyunun sesini bilemez.
Bu yüzden mikrofon sesi gönderilmeden önce RNNoise'dan (konuşmayı tanıyan küçük bir yapay sinir ağı) geçirilir.

Ölçüm (`test/noise.test.js`, gerçek Chrome, karşı tarafın duyduğu seviye):

| Mikrofona giren | Kapalı | Açık |
|---|---|---|
| Oyun efektleri (patlama, vuruş, rüzgâr, klavye) | -34 dB | **-100 dB** (sessizlik, mikrofon %0 açık) |
| Konuşma | -21 dB | -21 dB (kayıp yok) |

Sınırlar:
- **Konuşma içeren oyun sesleri** (şampiyon replikleri, duyurucu) ve **vokalli müzik** konuşma gibi algılanabilir ve kısmen geçebilir.
- Siz konuşurken arkadaki oyun sesi azalır ama tamamen sıfırlanmaz.
- Yapay zekâ engelleme açıkken tarayıcının kendi gürültü engellemesi kapatılır; ikisi birlikte çalışınca sonuç ölçülebilir şekilde kötüleşiyor.

## Müzik botu nasıl çalışır?

Arkadaşlar arası özel kullanım içindir. Sunucu ortak sırayı ve "şu şarkı şu saniyede başladı" bilgisini tutar;
herkes aynı şarkıyı aynı konumda duyar (testlerde ±0.1–2 sn).

**Varsayılan: sunucudan sadece ses (yt-dlp).** Docker imajında yt-dlp kuruludur. YouTube şarkılarının ses akışını
sunucu alır ve odadakilere iletir:
- Telif / "başka sitelerde oynatılamaz" engeli yok (gömülü oynatıcı kullanılmaz), reklam yok.
- Video yok: Opus ses ~130 kbit/sn, şarkı başına ~5 MB, **saatte ~60 MB** (gömülü YouTube oynatıcısında 350–450 MB).
- Şarkı adıyla arama API anahtarı olmadan çalışır.
- Akış sadece odadaki kişilere ve sadece o odanın sırasındaki şarkılar için açıktır.
- yt-dlp sunucu açılışında ve her gün kendini günceller. YouTube sunucuyu "bot" sanarsa çerez eklenir (bkz. DEPLOY.md).
- `MUSIC_STREAM=off` ile kapatılırsa (ya da yt-dlp yoksa) resmi gömülü YouTube oynatıcısına dönülür.

Diğer ayrıntılar:
- YouTube (`youtube.com/watch`, `youtu.be`, `music.youtube.com`, `shorts`) ve SoundCloud parça linkleri ya da şarkı adı.
- SoundCloud resmi oynatıcısıyla çalar (sadece ses, ~70 MB/saat); bazı plak şirketi parçaları orada sadece 30 sn önizleme verir,
  uygulama bunu algılayıp YouTube versiyonuna geçer.
- **🔔 Bende kapat:** müziği sadece kendinde kapatır, hiç veri harcamaz; diğerlerinde çalmaya devam eder.
- Bir şarkı sadece bir kişide çalınamıyorsa diğerlerinde devam eder; çoğunlukta çalınamazsa başka bir yüklemesi denenir ya da atlanır.
- Şarkının bitişini sunucu yönetir. Kulaklık (sağırlaştırma) müziği de susturur.
- Sunucu yeniden başlarsa sıra sıfırlanır (sesli sohbet etkilenmez).

## Yerelde çalıştırma

```bash
npm install
npm start
```

Ardından http://localhost:3000 adresini açın. (Mikrofon için tarayıcılar HTTPS ister; `localhost` istisnadır.)

## Deploy

Sunucu tek bir Node.js sürecidir ve HTTP + WebSocket'i aynı porttan (`PORT`) sunar. HTTPS'i barındırma platformu sağlar.

### Kendi sunucunda (nginx + Docker)

Adım adım kurulum: [deploy/DEPLOY.md](deploy/DEPLOY.md). Nginx ayarı: [deploy/riftvoice.conf](deploy/riftvoice.conf).
`docker-compose.yml` uygulamayla birlikte bir TURN sunucusu (coturn, [deploy/turnserver.conf](deploy/turnserver.conf)) da çalıştırır.

### Seçenek 1: Render (önerilen, ücretsiz katman var)

1. Projeyi bir GitHub deposuna gönderin.
2. https://dashboard.render.com → **New → Blueprint** → depoyu seçin. `render.yaml` her şeyi ayarlar.
3. Deploy bitince `https://riftvoice-xxxx.onrender.com` adresini arkadaşlarınıza gönderin.

Not: Render'ın ücretsiz katmanı 15 dk hiç trafik olmazsa uykuya geçer; ilk açılış ~30-60 sn sürebilir. Biri odadayken uyumaz.
Uyku/yeniden başlatma devam eden konuşmayı kesmez.

### Seçenek 2: Docker (Fly.io, Railway, VPS, vb.)

```bash
docker build -t riftvoice .
docker run -d --restart=always -p 3000:3000 riftvoice
```

Bir VPS'te HTTPS için önüne Caddy koymak en kolayıdır (`caddy reverse-proxy --from ses.alanadiniz.com --to localhost:3000`).

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Dinlenecek port |
| `MAX_ROOM_SIZE` | `12` | Oda başına en fazla kişi |
| `RECONNECT_GRACE_MS` | `20000` | Bağlantısı kopan kişinin odada tutulma süresi |
| `STUN_URLS` | Google + Cloudflare STUN | Virgülle ayrılmış STUN adresleri |
| `TURN_URLS` | (yok) | Virgülle ayrılmış TURN adresleri, ör. `turn:turn.ornek.com:3478,turns:turn.ornek.com:5349` |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | (yok) | Sabit TURN kimlik bilgileri |
| `TURN_SECRET` | (yok) | coturn `use-auth-secret` kullanıyorsanız paylaşılan gizli anahtar (süreli kimlik bilgisi üretilir) |

### TURN sunucusu gerekli mi?

Çoğu ev internetinde gerek yoktur. Ancak bazı mobil operatörler / CGNAT arkasındaki bağlantılarda iki oyuncu doğrudan bağlanamayabilir
(kart "Bağlanıyor…" durumunda kalır). Bu durumda bir TURN sunucusu ekleyin, örneğin
Metered (https://www.metered.ca/stun-turn, ücretsiz katman) veya kendi coturn sunucunuz, ve yukarıdaki `TURN_*` değişkenlerini ayarlayın.

## Testler

```bash
npm run test:server   # sunucu protokol testleri
npm run test:e2e      # gerçek Chrome/Edge ile uçtan uca testler (sahte mikrofon)
npm run test:turn     # gerçek coturn (Docker) ile röle testi
npm run test:noise    # yapay zekâ gürültü engelleme ölçümü
npm run test:music    # gerçek YouTube/SoundCloud oynatıcısıyla müzik testi (erişilemezse atlanır)
npm run test:stream   # yt-dlp ses akışı testi (YTDLP_BIN ya da PATH'te yt-dlp gerekir, yoksa atlanır)
npm test              # hepsi (Docker yoksa TURN testi atlanır)
```

Uçtan uca testler kurulu Chrome'u veya Edge'i kullanır.

## Mimari

```
 Tarayıcı A  ◄──── WebRTC ses (P2P, DTLS-SRTP şifreli) ────►  Tarayıcı B
     │                                                            │
     └──────── WebSocket /ws (sadece sinyal: SDP/ICE) ─── Sunucu ─┘
```

- `server.js`: statik dosyalar, `/healthz`, `/ws` sinyal sunucusu. Odalar bellekte tutulur.
- `public/app.js`: istemci (WebRTC mesh, perfect negotiation, yeniden bağlanma, bekçi, ses eşiği).
- `public/meter-worklet.js`: mikrofon seviyesi ölçer (ses iş parçacığında çalışır).
- `public/vendor/rnnoise/`: RNNoise (WebAssembly) gürültü engelleme; @sapphi-red/web-noise-suppressor'dan alınmıştır, konuşma olasılığını iletmek için küçük bir yama içerir (bkz. README.txt).

Mesh yapısı 2–8 kişilik oyun grupları için idealdir (LoL takımı 5 kişi). Çok daha büyük kanallar için SFU gerekir.
