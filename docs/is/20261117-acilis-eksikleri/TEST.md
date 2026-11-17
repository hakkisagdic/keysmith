# TEST: 20261117-acilis-eksikleri

Dal `is/20261117-acilis-eksikleri`, mod `function`. Dal yerelde, ayrı portlarda ve geçici HOME/config ile çalıştırıldı; canlı gateway'e ve canlı config'e yazılmadı. Tam paket çalıştırılmadı (geliştirici kapısı); hedefli paket ve audit/unit koşuldu.

Eklenen test: `test/acilis-eksikleri-tester.test.js` (ayrı commit `test: ...`). Komut: `node --test test/acilis-eksikleri-tester.test.js`.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 batch.enabled set/get/unset, bool dışı red, batch status | geçti | test K1; "maybe" reddedilir ve eski değer kalır; kapalıyken "batch is off", açıkken "no batch jobs". Not: unset sonrası config'te boş `"batch": {}` kalır (zararsız). Unset komutu `config unset`, `--unset` değil |
| K2 tokenrouter discover /api/pricing | geçti | test K2+K3: 8 satırlık tabloda yalnız quota_type/model_price/model_ratio üçü de sayı 0 ve tiered'da olmayan 2 model yazıldı; ücretli, quota_type 1, tiered, eksik alan, "0" metin reddedildi; katalogta `source` (yalnız host+yol) ve `at` zaman damgası |
| K2 ücretli modele istek reddi | geçti | test "through a running gateway": paid model 400 (stream ve değil), yukarı akışa 0 çağrı; listedeki 200 |
| K3 dünkü ücretsiz bugün ücretli | geçti | test K2+K3: model_ratio değişince sonraki discover listeden düşürdü; pricing 500 verince liste boşaldı |
| K4 varsayılan model sağlayıcı listesinden | geçti | test K4: whisper/guard/70b dışlandı, küçük sohbet modeli seçildi; `--model` üstün; listede olmayan model hata, config bayt bayt aynı |
| K5 Mistral notu | geçti | test K5: `source enable` çıktısı ve `source list` "429 / no free rate / left out" der |
| K6 SIGHUP ile promptCache | geçti | test K6: ayrı portta gerçek `keysmith serve` süreci, gerçek SIGHUP; açılır, kapanır, baseUrl değişikliği uygulanmaz, geçersiz değerde eski kalır |
| K7 doctor temiz, fuel-test.key 600 | yürütülmedi | Canlı config henüz hazırlanmamış: `~/.config/keysmith/fuel-test.key` yok; groq, cloudflare, kiro-api adaptörleri yok; `batch` ve claude-api `promptCache` ayarlı değil (yalnız adlar okundu). Operatör adımları (a-e) sonra |
| K8 fuel-test ile dört kaynağa istek | yürütülmedi | Anahtar ve restart yok; canlı gateway yeniden başlatılmaz, restart sonrası çalıştırılacak |
| K9 claude-api cache read | yürütülmedi | Aynı neden; para harcar, restart sonrası |
| K10 batch tek satır, --cap-usd 0.10 | yürütülmedi | Aynı neden |
| K11 allow listeleri, alias zincirleri, SIGHUP anahtar yenileme | geçti | `keysec` (12 SIGHUP/reload testi), audit.test.js ve unit.test.js (107 test), integration, tools-router: hepsi geçti. Canlı allow listesi karşılaştırması restart öncesi/sonrası için yürütülmedi |
| K11 venizelos/reviewer rota tablosu HTTP kodları (canlı) | yürütülmedi | Canlı gateway'e bağlı, restart sonrası |
| K11 halka açık depoda özel yol/adres/anahtar yok | geçti | Düzeltme turu 2: kendi dosyasını dışarıda bırakan filtre silindi, test artık kendini de tarar; özel değerler depo dışından (KEYSMITH_PRIVATE_PATTERNS) okunur; eski kanıt yanlıştı. Yeniden koşuldu: geçti |

Hedefli regresyon: config-edit, discover, integration, keysec, prompt-cache*, qa-saglayicilari, service-reload, source, tools-router, catalogue*, cli-settings, batch* = 190 test, 189 geçti, 0 kaldı (1 atlanan/todo). audit + unit = 107/107.

## Kalanlar

1. K7-K10 ve canlı rota/allow karşılaştırması: yürütülmedi. Gözlenen: `~/.config/keysmith/fuel-test.key` hâlâ yok, canlı gateway restart edilmedi. Beklenen: restart sonrası ayrı koşu; K9 ve K10 para harcar.
2. Gözlem (kaldı sayılmadı): `source enable --models-url` verilirse Keychain anahtarı o adrese Bearer olarak gider; yalnız sahibin verdiği adres, ama belgede belirtilmeli.

Yeniden kontrol (tur 1): `node --test test/acilis-eksikleri-tester.test.js` 7/7 geçti; unit + audit 107/107 geçti.
