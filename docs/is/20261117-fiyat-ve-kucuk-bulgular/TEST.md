# TEST: 20261117-fiyat-ve-kucuk-bulgular

Mod: function. Dal `is/20261117-fiyat-ve-kucuk-bulgular`, yerel çalıştırma (canlı adres kanıt sayılmadı). Testler `test/price-tester.test.js` (ayrı `test:` commit'i). Canlı yapılandırmaya ve geçit yeniden başlatmasına dokunulmadı; canlı `pricing` yalnız okunup bir kopyada denendi.

Çalıştırılan: `node --test test/price-tester.test.js test/price.test.js test/discover.test.js test/source.test.js` (44/44 geçti); `batch*`, `cli-usage`, `config-edit`, `acilis-eksikleri-tester`, `catalogue*`, `help-safe` (67 test, 66 geçti, 0 kaldı, 1 atlandı). Tam paket geliştiricinin kapısıdır, koşulmadı.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 usage --by model: Haiku 4.5 fiyatlı, "saved at list price" > 0.00 (8.617 cache-read) | geçti | test "K1 usage --by model" (CLI çıktısı, "unpriced" yok) |
| K2 15 modelin tamamı girdi/çıktı/cache okuma/yazma 5dk+1sa/batch, sayfa adresi ve tarih | geçti | test "K2 price list" (15 model tek tek; platform.claude.com/docs/en/about-claude/pricing, 2026-11-17); rakamlar geliştiricinin sayfa kaydına dayanır, ben sayfayı açmadım |
| K3 kayıtsız model "unpriced" + token sayısı, doctor adını söyler | geçti | test "K3 an unpriced model" (usage ve `doctor` çıktısı) |
| K4 batch submit --dry-run Haiku 4.5 fiyat yüzünden reddetmez | geçti (2. tur) | `--dry-run` artık tanınıyor: elle koşuldu, `dry run: d1 (1 requests); estimate $0.002507 of cap $1.00 (nothing was sent, nothing saved)`, çıkış 0, iş dosyası yazılmadı; test "K4 batch submit" (sahte sunucuya 0 istek, dry-run sonrası iş dosyası yok, gerçek gönderim çalışır, "no price" yok) |
| K5 price set: tarihli yedek, doğrulama, kötü girdide dosya değişmez | geçti | test "K5 price set" (-3, abc, 1e9, batch 1.5 reddedildi, dosya aynı, yedek `.bak-YYYYMMDD-HHMMSS`) |
| K6 http pricingUrl reddedilir; bozuk adres tek satır, yığın izi yok | geçti | test "K6 discover" |
| K7 --models-url: anahtar yalnız https ve baseUrl ile aynı kök | geçti (kısmen) | Başka köke (https) ve http'ye anahtar gitmedi, liste çekildi (yerel sahte sunucular). Aynı kök olumlu dalı uçtan uca denenemedi: profil baseUrl'leri herkese açık adres; o dal yalnız birim testte (`modelsRequest`, geliştirici testi) doğrulandı |
| K8 source yardımı --models-url ve anahtar kuralını anlatır | geçti | test "K8 source help" |
| Regresyon: canlı `*/claude-*-5-5*` ve Gemini kayıtları değerini ve önceliğini korur | geçti | canlı `pricing` kopyası `price list`'te aynı değerler; test "custom pricing entries" (özel kayıt varsayılanı ezer, dosya değişmedi). Not: canlı kayıtlarda `cacheWrite1h` yok, 1 sa oranı girdinin 2 katı sayılır (varsayılan tablodaki 8 / 4 ile aynı sonuç) |
| Regresyon: Tokenrouter https ücretsiz liste keşfi | geçti | test "tokenrouter-style https free-list discovery" + `discover.test.js` |
| Regresyon: source enable (--models-url yok, --model ile) eskisi gibi | geçti | `source.test.js` 44/44; test "source enable ... as before" |
| Regresyon: eski usage satırları yeniden yazılmaz | geçti | test "old usage rows are not rewritten" (dosya baytı aynı, usage+doctor sonrası) |

## Kalanlar

Tekrar kontrol (düzeltme turu 1): K4 kapandı. Ilgili 111 testin 110'u geçti, 0 kaldı, 1 atlandı (price-tester, price, discover, source, batch*, cli-usage, config-edit, acilis-eksikleri-tester, help-safe, catalogue*).

1. K7 aynı-kök olumlu dalı (https + aynı kök = anahtar gider) yalnız birim testle görüldü; uçtan uca sahte sunucuyla görülemedi (profil baseUrl'i sabit herkese açık adres). Engelleyici değil, not olarak kalır.

Canlı için not: değişen fiyat tablosu geçidin yeniden başlatılmasını ister; yönetici listesine yazılır, launchd işi yeniden başlatılmadı.
