# Sunucuya kurulum (IP: 212.64.215.98)

Bu kurulum mevcut sitelere dokunmaz:
- nginx bloğu `default_server` kullanmaz, sadece `Host: 212.64.215.98` ile gelen istekleri karşılar.
- Uygulama Docker'da yalnızca `127.0.0.1:4010` üzerinde dinler.
- TURN sunucusu (coturn) kendi portlarını kullanır: `3478` (UDP+TCP) ve `49160-49260` (UDP).
  İç ağa / localhost'a aktarım yapması engellidir.

> Daha önce TURN olmadan kurduysan doğrudan **"Mevcut kurulumu güncelleme"** bölümüne geç.

## 1. Port ve IP kontrolü
```bash
sudo ss -ltnup | grep -E ':4010|:3478|:4916[0-9]|:492[0-5][0-9]|:49260'
```
Çıktı boş olmalı. Doluysa haber ver, portları değiştirelim.

```bash
ip -4 addr | grep 212.64.215.98
```
Bir satır görmelisin (genel IP doğrudan sunucunun ağ kartında). Boşsa sunucu bir NAT arkasındadır;
`deploy/turnserver.conf` içindeki `external-ip` satırını `external-ip=212.64.215.98/<sunucunun özel IP'si>` yap.

## 2. Kodu çek, gizli anahtarı oluştur, başlat
```bash
cd /opt && sudo git clone https://github.com/arcaerdogar/voice-chat.git
cd /opt/voice-chat
echo "TURN_SECRET=$(openssl rand -hex 32)" | sudo tee .env > /dev/null
sudo chmod 600 .env
sudo docker compose up -d --build
curl http://127.0.0.1:4010/healthz     # {"ok":true,...} dönmeli
sudo docker logs riftvoice-turn 2>&1 | grep -E "ERROR|Bad configuration"   # boş olmalı
```

## 3. IP için sertifika üret
```bash
sudo mkdir -p /etc/ssl/riftvoice
sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout /etc/ssl/riftvoice/ip.key -out /etc/ssl/riftvoice/ip.crt \
  -subj "/CN=212.64.215.98" -addext "subjectAltName=IP:212.64.215.98"
sudo chmod 600 /etc/ssl/riftvoice/ip.key
```

## 4. Nginx ayarını ekle
```bash
sudo cp /opt/voice-chat/deploy/riftvoice.conf /etc/nginx/conf.d/riftvoice.conf
sudo nginx -t && sudo systemctl reload nginx
```
`nginx -t` hata verirse reload yapılmaz, mevcut siteler eski ayarla çalışmaya devam eder.

## 5. Firewall
```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49260/udp
```
(80/443 diğer siteler için zaten açık olmalı.) Bulut sağlayıcının panelinde ayrı bir güvenlik grubu /
firewall varsa aynı portları orada da aç.

## 6. Kullanım ve test
Link: **https://212.64.215.98/r/oda-adi**

İlk girişte tarayıcı sertifika uyarısı verir (kendinden imzalı olduğu için):
- Chrome/Edge: **Gelişmiş → 212.64.215.98 adresine ilerle**
- Firefox: **Gelişmiş → Riski kabul et ve devam et**

**TURN testi:** iki farklı cihazdan `https://212.64.215.98/r/turn-test?relay=1` aç.
`?relay=1` bağlantıyı zorla TURN üzerinden kurar. Kartta **"Bağlı · xx ms · röle"** görünüyor ve
birbirinizi duyuyorsanız TURN çalışıyor. (Normal kullanımda `?relay=1` ekleme; doğrudan bağlantı
mümkünse o kullanılır, değilse otomatik olarak röleye geçilir.)

---

## Mevcut kurulumu güncelleme (TURN eklemek dahil)
```bash
cd /opt/voice-chat
sudo git pull
# Sadece ilk kez (TURN eklerken): gizli anahtar oluştur
[ -f .env ] || { echo "TURN_SECRET=$(openssl rand -hex 32)" | sudo tee .env > /dev/null; sudo chmod 600 .env; }
sudo docker compose up -d --build
```
TURN'ü ilk kez ekliyorsan ayrıca **adım 1'deki IP kontrolünü** ve **adım 5'i (firewall)** yap,
sonra **adım 6'daki TURN testini** uygula. Nginx ve sertifika adımları tekrar gerekmez.

Güncelleme sırasında devam eden konuşmalar kesilmez (ses P2P akar). Odadakiler yeni özellikleri
görmek için sayfayı bir kez yenilemeli.

Not: Müzik botu, eklenen videonun başlığını almak için sunucudan `https://www.youtube.com` adresine
istek atar. Sunucunun dışarıya HTTPS çıkışı kapalıysa müzik yine çalışır, sadece başlık yerine
"YouTube videosu (kimlik)" yazar.

## Müzik: YouTube "bot değilim" engeli (gerekirse)

Müzik botu Docker imajındaki yt-dlp ile çalışır; ek ayar gerekmez. YouTube bazen sunucu IP'lerine
"bot olmadığını doğrula" engeli koyar. Olursa sohbette **"YouTube sunucuyu bot sandı"** yazar. Çözüm:

1. Chrome'a **"Get cookies.txt LOCALLY"** eklentisini kurun. (Ana hesabınız yerine ayrı, boş bir Google hesabı önerilir.)
2. youtube.com'a o hesapla girin, eklentiyle **youtube.com** çerezlerini dışa aktarın (Netscape formatı).
3. Dosyayı sunucuya kopyalayın:
```bash
sudo mkdir -p /opt/voice-chat/data
sudo cp youtube-cookies.txt /opt/voice-chat/data/youtube-cookies.txt
sudo chmod 644 /opt/voice-chat/data/youtube-cookies.txt
cd /opt/voice-chat && sudo docker compose up -d --force-recreate riftvoice
```
`sudo docker logs riftvoice` çıktısında "çerez dosyası kullanılıyor" görünmeli. Çerezler zamanla geçersizleşirse aynı adımlarla yenileyin.

Müzik akışını tamamen kapatmak (resmi gömülü YouTube oynatıcısına dönmek) için `.env`'e `MUSIC_STREAM=off` ekleyin.

## Müzik: YouTube API anahtarı (isteğe bağlı)

Müzik akışı (yt-dlp) açıkken gerekmez: arama ve çalma onunla yapılır. Sadece `MUSIC_STREAM=off` kullanıyorsanız
şarkı adıyla arama ve gömülemeyen videolara alternatif bulma için işe yarar. Ücretsizdir.

1. https://console.cloud.google.com adresine Google hesabınla gir, üstten **yeni proje** oluştur (ör. `riftvoice`).
2. **APIs & Services → Library** → "YouTube Data API v3" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**. Oluşan anahtarı kopyala.
4. (Önerilir) Anahtara tıkla → **API restrictions → Restrict key → YouTube Data API v3** → Kaydet.
5. Sunucuda:
```bash
cd /opt/voice-chat
echo "YOUTUBE_API_KEY=BURAYA_ANAHTAR" | sudo tee -a .env > /dev/null
sudo docker compose up -d
```
Ücretsiz kota günde 10.000 birimdir; bir arama ~100 birim (günde ~100 arama), link ekleme ~1 birim.
Aynı arama 6 saat önbellekte tutulur. Kota dolarsa uygulama bunu söyler ve linklerle çalışmaya devam eder.

## Domain geri geldiğinde
1. `/etc/nginx/conf.d/riftvoice.conf` içinde iki `server_name` satırını domain ile değiştir (ör. `voice.ituacm.com`).
2. Sertifika satırlarını gerçek sertifikayla değiştir (Cloudflare Origin / Let's Encrypt).
3. `sudo nginx -t && sudo systemctl reload nginx`

TURN, IP üzerinden çalışmaya devam eder; değiştirmen gerekmez. (Domain Cloudflare proxy'si arkasında
olacaksa TURN adresi yine IP kalmalı, çünkü Cloudflare TURN trafiğini taşımaz.)

## Sorun giderme
- **Bir kişinin kartı "Bağlantı kurulamıyor (ağ kısıtlaması)" diyor:** TURN çalışıyor mu kontrol et (adım 6). 3478 ve 49160-49260 portlarının firewall'da açık olduğundan emin ol.
- **Loglar:** `sudo docker logs -f riftvoice` (uygulama), `sudo docker logs -f riftvoice-turn` (TURN)
