# TEST: 20261117-toplu-is (batch iş türü)

Yöntem: dal yerelde, her test kendi geçici HOME/dataDir'i ve ayrı portta stub Message Batches upstream'i ile çalıştı (CLI alt süreç olarak). Çalışan gateway'e dokunulmadı, yeniden başlatılmadı. Canlı URL kanıt sayılmadı. Para ve erişim kontrolleri (K2, K7, K8) bağımsız yazılmış testlerle, elle hesaplanmış rakamlarla sınandı.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 submit: stub'a tek batch POST, tahmini USD basılır | geçti | `test/batch-tester.test.js` T-K1; `test/batch.test.js` K1 |
| K2 tavan aşılırsa red, stub'a istek yok, iş dosyası kalmaz; tavan yeterliyse geçer | geçti | T-K2 (stub çağrı sayısı 0) |
| K3 openai wire adaptör açık mesajla reddedilir, istek yok | geçti | T-K3 |
| K4 kısmi hata: 3 satır, aynı custom_id, hata satırı `failed`; status sayıları | geçti | T-K4 |
| K5 süre dolumu `expired`, cancel stub'a gider ve `canceled` | geçti | T-K5 |
| K6 yeni süreçte iş diskten bulunur, yoklama sürer, aynı ada ikinci gönderim reddedilir (POST sayısı 1) | geçti | T-K6 |
| K7 usage.jsonl: istek başına bir satır, maliyet liste fiyatının yarısı (elle: 1000 girdi, 500 çıktı, 2000 okuma, 400 yazma = 0,0082 USD), önbellek sayıları ayrı, ikinci `results` satırı çoğaltmaz | geçti | T-K7 |
| K8 anahtar kapısı: allow dışı, deny, perDay aşımı reddedilir (stub'a istek yok); izinli anahtar geçer; `batch.enabled` yokken "batch is off", hiçbir dosya/istek yok | geçti | T-K8 |
| K9 `npm test` | geçti | 939 test, 913 geçti, 0 kaldı, 26 todo (önceden var olan); mevcut test dosyaları değişmedi (dal farkı yalnız test/batch.test.js ekliyor) |
| K10 eklenen satırlarda özel yol/e-posta/host/anahtar yok | geçti | T-K10 (git diff eklenen satırları taranır). Not: README'de önceden var olan bir `hakkisagdic` geçişi bu işin değil |
| Regresyon: usage-record ve fiyat tablosu | geçti | `npm test` tam koşu, usage-record/cli-usage/spend-window yeşil |
| Regresyon: credit-guard | geçti | `npm test` tam koşu |
| Regresyon: scopes (allow/deny, perDay) | geçti | `npm test` tam koşu; batch aynı `requestDecision` kapısını kullanır |
| Regresyon: canlı anthropic /messages yolu | geçti | `npm test` tam koşu (relay, messages-relay, wire-conformance); src farkı yalnız batch.js ve cli.js, http-adapter/server/usage dokunulmadı |

Eklenen test: `test/batch-tester.test.js` (9 test, ayrı `test:` commit'i). Ekran görüntüsü yok (CLI).

## Kalanlar

Başarısız kontrol yok. Yürütülmedi (stub dışı): gerçek Anthropic'e küçük gönderim ve promosyon kredisinin batch'te geçerliliği; analizde zaten ilk küçük gönderimle doğrulanacak diye ertelenmiş. Gateway arka plan yoklama döngüsü ve HTTP formu (`POST /v1/keysmith/batches`) bu dalda yok (yalnız CLI yoklaması); analizde "ucuzsa" koşullu olduğundan kabul kontrolü değil.

## İnceleme düzeltmeleri

Düzeltme commit'i: `e56afff` (src/batch.js, test/batch-review.test.js). Kontrol zamanı K1-K10 ayrı portlu stub ile yeniden koşuldu; çalışan gateway (pid 36453) yeniden başlatılmadı, `batch.enabled` yoksa "batch is off" (T-K8) geçti.

| Bulgu | Sonuç | Kanıt |
|---|---|---|
| 1. K10 özel desenleri repoda taşıyordu, sabit hash'e göre fark alıyordu | geçti | Desenler `KEYSMITH_PRIVATE_PATTERNS` ortam değişkeninden okunuyor, tanımsızken test atlanıyor (`skipped 1`); fark `git merge-base origin/main HEAD` ile alınıyor. `6a8b510` dal geçmişinde yok ve uzakta yok; `git log origin/main..HEAD -p` içinde sunucu IP'si / port / `/Users/` yok; depoda `grep -rn` boş. Ortam değişkeni (IP, port, kullanıcı adı deseni) ayarlıyken T-K10 geçti |
| 2. Kullanıcının kendi `cache_control`'u 1x sayılıyordu | geçti | `estimateUsd` artık kullanıcı işaretli isteğin tüm girdisini yazma oranında (yarım girdi x 2) sayar. Test `estimate counts a cache_control the user wrote...`: 0,3 USD tavan, işaretli girdi reddedilir ve stub'a 0 istek gider, işaretsiz aynı girdi geçer (1 istek). Eski `batch.js` (fe98e26) ile test kalır, yeni kodla geçer |
| 3. `todaysRequests` UTC günü kıyaslıyor, TERMINAL işleri saymıyordu | geçti | `Date.parse(createdAt) >= Date.parse(start) && !usageRecorded`, TERMINAL süzgeci kalktı. Test `perDay cap holds across consecutive batches`: perDay 4, 3'er istek, ikinci gönderim `daily cap` ile reddedilir, stub'a toplam 1 istek; `TZ=Europe/Istanbul` altında koşuldu. Eski kodla kalır, yeni kodla geçer |

Kapı: `node --test` batch dosyaları (batch, batch-tester, batch-review) 21/21 geçti; TZ=Europe/Istanbul altında batch-review 2/2. Tam `npm test`: 941 test; iki koşuda 3 ve 4 test kaldı (ör. toolResultTimeoutMs, spend okuma, reloadAgent, opencode stopAtToolCall), her koşuda farklı kümeler; bu testleri içeren 14 dosya tek başına koşunca 515 testin hepsi geçti (0 kaldı). Bu dalın src farkı yalnız `src/batch.js` ve `src/cli.js`, yani kalanlar yük kaynaklı dalgalanma, batch ile ilgisiz. Zorunlu K2, K7, K8: geçti.
