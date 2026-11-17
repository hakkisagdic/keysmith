# 20261117-saglayicilari-ac: Yeni kaynakları yapılandırma elle düzenlenmeden aç/kapat

## Bugün ne var
- `src/cli.js`: `set <adapter> <alan>` yalnız bir adaptörün alanını değiştirir (cmdSet). Üst düzey anahtar (`discovery.enabled`, `catalogue`) için komut yok.
- `discover` (cmdDiscover) `catalogueSettings(cfg)` ile `discovery.enabled` ister; kapalıysa "discovery is off". Canlı `~/.config/keysmith/config.json` üst anahtarları: host, port, auth, log, limits, pricing, tunnel, adapters, aliases, virtualModels. `catalogue` ve `discovery` yok.
- `src/profiles.js` HTTP_PROFILES: `tokenrouter`, `mistral`, `groq` var (apiKey `{env:...}`). Cloudflare Workers AI profili YOK (SONUC.md'de geçse de kodda "workers" araması boş); hesap kimliği URL içinde.
- `freeOnly` (http-adapter.js:486) `discover` çıktısındaki liste yoksa isteği 400 ile reddeder; liste fiyat alanından (`pricing.prompt`) türer. Groq/Mistral `/models` yanıtında fiyat yok: orada freeOnly her modeli reddeder.
- Limitler adaptörde değil, `catalogue` dosyasında (`src/catalogue.js`): requestsPerMinute, requestsPerDay, tokensPerMonth. Günlük token alanı yok.
- Anahtar başvurusu: `{exec:/usr/bin/security find-generic-password -s <servis> -w}` (claude-api böyle).
- `parseFlags` `--help` ve `-h` için özel durum bilmez; `add tokenrouter --help` adaptörü ekledi (dün kanıtlandı). Yalnız komutsuz `-h/--help` yardım basar.
- Dört Keychain kaydı (hesap keysmith) mevcut (değer okunmadan doğrulandı).

## Ne değişecek
1. `cli.js` main: `--help`/`-h` HER alt komutta, komut çalışmadan önce yardımı basar, hiçbir şey yazmaz. Alt komuta özel yardım metinleri.
2. Yeni `src/config-edit.js`: şema (bilinen anahtarlar, tip, izinli değer), `config get|set|unset <noktalı.anahtar> [değer]`, `--dry-run` (fark basar), yazmadan önce `config.json.bak-<zaman>` yedeği, geçici dosya + rename (0600 korunur). Bilinmeyen anahtar: bilinenlerin listesiyle ret. Sırlar (`auth.keys`) get'te maskeli.
3. Yeni `src/source.js` + `source enable|disable`: profilden adaptör, anahtar exec başvurusu (`--key-ref`), `discovery.enabled` + kaynağa özel fiyat yolu, hiçbir alias zincirine ekleme, katalog dosyasına (`catalogue`) muhafazakâr limitler, ne değiştiğini yazdırma + "gateway yeniden başlatılmalı". Keychain kaydı yoksa ret. Cloudflare için `--account-id`.
4. `profiles.js`: `cloudflare` profili (`https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1`), her profile belgeli ücretsiz kota ve freeOnly işareti.
5. Katalog: `tokensPerDay` alanı eklenmeli (istek "günlük token" diyor); eski dosyalar bozulmamalı.
6. Testler: `test/` altında sahte upstream, geçici Keychain kaydı, her alt komut `--help` bayt-özdeş sınaması.
7. Canlı HAZIRLIK (yeniden başlatma yok): gerçek dosyada dört kaynağı aç, doğrula, çalışan gateway ile dosya adaptör farkı (yalnız adlar), SONUC.md'ye yeniden başlatma sonrası kontroller.

## Kabul kontrolleri
- K1: Verilen geçici config; `keysmith add tokenrouter --help`, sonra tüm alt komutlar `--help` ve `-h` -> yardım basar, çıkış 0, config sha256 öncesi/sonrası aynı. Gözlem: `shasum` + `node --test test/help-safe.test.js`.
- K2: `config set discovery.enabled true --dry-run` fark basar, dosya değişmez; `config set discovery.enabled true` -> `config get discovery.enabled` true, yanında `config.json.bak-*` var, mod 0600.
- K3: `config set foo.bar 1` -> ret, bilinen anahtar listesi çıkar, dosya değişmez. `config set port abc` -> tip hatası.
- K4: Geçici Keychain kaydıyla `source enable tokenrouter --key-ref <servis>` -> config'te adaptör var, apiKey `{exec:...security...}` (düz değer yok), `freeOnly:true`, `discovery.enabled:true`, hiçbir `aliases.*` onu içermez, katalogda limit satırı var; çıktı "yeniden başlat" der. Gözlem: `jq` ile config.
- K5: Var olmayan Keychain servisiyle enable -> ret, config bayt-özdeş.
- K6: `source disable tokenrouter` -> adaptör ve katalog satırı gider, başka adaptörler dokunulmamış (`diff` yalnız o adı gösterir).
- K7: Sahte upstream + ikinci örnek (başka port, kendi PID'i ile durdurulur): `discover tokenrouter` ücretsiz listeyi yazar; ücretli model adı istenirse 400 (freeOnly); ücretsiz model 200 ve `usage` satırı.
- K8: Canlı dosya: dört kaynak `config`/`doctor` doğrulamasından geçer; `keysmith adapters` fark listesi yalnız adla; log/diff/dosyada anahtar değeri yok (`gitleaks`, `grep`).
- K9: Yeniden başlatma sonrası (yönetici): her kaynak için `discover <ad>` sayısı > 0 (groq/mistral için kural K'de), tek küçük istek 200, `keysmith usage --by adapter` o adaptör için satır.

## Riskler
- Para: freeOnly yalnız fiyat verisi olan kaynakta işler (tokenrouter, openrouter türü). Groq/Mistral/Cloudflare `/models` fiyat vermez; freeOnly koyarsak her şey reddedilir, koymazsak ücretli modele düşülebilir. Bu kaynaklarda koruma: alias dışı + günlük limit + açık model listesi (karar 3).
- Erişim/sır: anahtar yalnız exec başvurusu; `config get/set` sırrı basmamalı, yedek dosyalar 0600; test çıktısına sızmamalı.
- Gerileme: `set`, `add`, `enable/disable` (mevcut adaptör komutu, ad çakışması: `source` ayrı kök), `catalogue` testleri (catalogue*.test.js, discover.test.js), 911 testlik kapı, `--help` değişimi eski `help` kullanımını bozmasın.
- Canlı config yazımı: yedek şart; çalışan gateway dosyayı yeniden yüklemez, yeniden başlatma öncesi kaynaklar etkisiz (beklenen).
- Cloudflare hesap kimliği: token `accounts` uç noktasını okuyamayabilir (izin yoksa yönetici verir); betik yalnız kimliği basar.

## Kararlar
1. `source` yeni kök komut; mevcut `enable/disable` (adaptör aç/kapat) aynen kalır.
2. Şema bilinen anahtarlar: host, port, auth.enabled, log.*, limits.*, tunnel.*, catalogue, discovery.enabled, discovery.<ad>.{inputPricePath,outputPricePath}. `adapters.*`, `aliases.*`, `auth.keys` `config` ile değil mevcut komutlarla değişir.
3. freeOnly yalnız profilde fiyat yolu olan kaynakta (tokenrouter). Diğerleri: alias dışı, katalog limiti, açık model adı; discover yine çalışır, boş liste uyarısı basar.
4. Limit varsayılanı belgeli ücretsiz kotanın en çok yarısı; kaynaklar arasında `tokensPerDay` yeni katalog alanı.
5. Katalog dosyası yoksa `~/.config/keysmith/catalogue.json` oluşturulur (0600) ve `catalogue` anahtarı ona bağlanır.
6. Yedek adı `config.json.bak-<YYYYMMDD-HHMMSS>-config`; mevcut adlandırmayla uyumlu.
7. Cloudflare hesap kimliği sır değil, `--account-id` değeri olarak alınır.

## Sahibe sorular
- Yok. Anahtarlar sahipte, yeniden başlatma yöneticide; kararların hepsi geri alınabilir (config yedeği, `source disable`).

## Boyut
M ama sınırda: tek alan (keysmith CLI), ~500-650 satır ürün + test, bir geliştirici dilimi. Riskli: erişim (anahtar) ve para (ücretli modele düşme), gözden geçiren ve config yedeği gerekli. Dilim önerisi: (a) --help güvenliği + config komutu, (b) source komutu + profil + katalog, (c) canlı hazırlık. 600 satırı aşarsa L.
