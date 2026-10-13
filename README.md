# RiftVoice

Oyun (LoL vb.) sırasında kullanmak için hafif, kurulum gerektirmeyen, **çökmemesi için tasarlanmış** web tabanlı sesli sohbet.

Linki aç → adını yaz → **Kanala katıl**. Aynı oda linkini açan herkes aynı kanaldadır.

## Neden çökmez?

| Sorun | RiftVoice'ta ne olur |
|---|---|
| Sunucu çöker / yeniden başlar / yeni sürüm deploy edilir | Ses **kesilmez**. Ses sunucudan değil, oyuncular arasında doğrudan (WebRTC P2P) akar. İstemciler sunucuya otomatik yeniden bağlanıp odaya geri döner. |
| İnternetin bir anlığına gider | Sinyal bağlantısı üstel geri çekilmeyle yeniden kurulur; sunucu seni 20 sn boyunca odada tutar. |
| İki oyuncu arasındaki bağlantı kopar | Her bağlantıyı bir "bekçi" izler; kopan bağlantı birkaç saniye içinde sıfırdan yeniden kurulur. |
| Mikrofon çıkar / değişir | Otomatik yeniden yakalanır; ayarlardan cihaz değiştirmek bağlantıyı koparmaz. |
| Sunucu bozuk/kötü niyetli mesaj alır | Doğrulanır, hız sınırına tabidir, süreç düşmez. |

Bu senaryoların hepsi `test/e2e.test.js` içinde gerçek Chrome örnekleriyle test edilir (sunucuyu kapatıp açmak dahil).

## Özellikler

- Opus ses, yankı/gürültü engelleme, otomatik kazanç (ayarlardan kapatılabilir)
- **Ses eşiği** (noise gate): klavye/fan sesi gönderilmez. Sekme arka plandayken de çalışır (AudioWorklet)
- Açık mikrofon veya bas-konuş (klavye tuşu ya da farenin yan tuşları)
- Kişi bazlı ses seviyesi ve yerel susturma
- Konuşan kişinin kartı yeşil parlar, her kişinin gecikmesi (ms) görünür
- Mikrofon (M) / kulaklık (D) kısayolları, susturma ve katılma/ayrılma için bip sesleri (oyundayken ekrana bakmadan anlarsın)
- Yazılı sohbet, kopyalanabilir oda linki, mobil uyumlu arayüz
- Hesap yok, veritabanı yok, tek bağımlılık (`ws`)

## Oyun sırasında kullanım ipuçları

- **Chrome veya Edge** önerilir. Sekmeyi açık bırakın (küçültebilirsiniz).
- Tarayıcılar, oyun tam ekrandayken klavyeyi dinleyemez. Bu yüzden **bas-konuş yalnızca sekme odaktayken çalışır**.
  Oyunda **Açık mikrofon + Ses eşiği** kullanın: Ayarlar → Ses eşiğini, konuşmadığınızda çubuğun hemen sağına gelecek şekilde ayarlayın.
- Yankı olmaması için kulaklık kullanın.

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
npm test              # hepsi
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

Mesh yapısı 2–8 kişilik oyun grupları için idealdir (LoL takımı 5 kişi). Çok daha büyük kanallar için SFU gerekir.
