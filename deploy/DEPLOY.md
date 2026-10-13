# Sunucuya kurulum (IP: 212.64.215.98)

Bu kurulum mevcut sitelere dokunmaz: nginx bloğu `default_server` kullanmaz,
sadece `Host: 212.64.215.98` ile gelen istekleri karşılar. Uygulama Docker'da
yalnızca `127.0.0.1:4010` üzerinde dinler.

## 1. Port kontrolü
```bash
sudo ss -ltnp | grep ':4010'
```
Çıktı boş olmalı. Doluysa `docker-compose.yml` ve `deploy/riftvoice.conf` içindeki 4010'u boş bir portla değiştir.

## 2. Kodu çek ve uygulamayı başlat
```bash
cd /opt && sudo git clone https://github.com/arcaerdogar/voice-chat.git
cd /opt/voice-chat && sudo docker compose up -d --build
curl http://127.0.0.1:4010/healthz     # {"ok":true,...} dönmeli
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
80 ve 443 portlarının açık olduğundan emin ol (diğer siteler için zaten açıksa bir şey yapma):
```bash
sudo ufw status
```
Bulut sağlayıcının güvenlik grubunda da 80/443 açık olmalı.

## 6. Kullanım
Link: **https://212.64.215.98/r/oda-adi**

İlk girişte tarayıcı sertifika uyarısı verir (kendinden imzalı olduğu için):
- Chrome/Edge: **Gelişmiş → 212.64.215.98 adresine ilerle**
- Firefox: **Gelişmiş → Riski kabul et ve devam et**

Her tarayıcıda bir kez yeterli. Bağlantı yine şifrelidir.

## Güncelleme
```bash
cd /opt/voice-chat && sudo git pull && sudo docker compose up -d --build
```
Güncelleme sırasında devam eden konuşmalar kesilmez (ses P2P akar).

## Domain geri geldiğinde
1. `deploy/riftvoice.conf` içinde iki `server_name` satırını domain ile değiştir (ör. `voice.ituacm.com`).
2. Sertifika satırlarını gerçek sertifikayla değiştir (Cloudflare Origin / Let's Encrypt).
3. `sudo nginx -t && sudo systemctl reload nginx`
