# 20261117-onbellek: Test sonucu

Dal `is/20261117-onbellek`, ana dal birleştirilmiş geçici kopyada (toplu iş dahil) koşuldu. Testler: `test/prompt-cache.test.js` (geliştirici), `test/prompt-cache-tester.test.js` (testçi). Çalışan gateway yeniden başlatılmadı; gerçek anahtar kullanılmadı.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 ayar yok/off/dry-run: gövde bayt bayt aynı | geçti | main (özelliksiz) ile dal aynı betikle `complete()` ve `rawMessages()` gövdesi üretti, `cmp` aynı; sha256 altın değerleri `prompt-cache-tester.test.js` "K1 golden" |
| K2 on/5m: son tool, system son blok, son-tur-öncesi blokta ephemeral; metin/sıra aynı | geçti (adaptör düzeyinde; gateway uçtan uca yürütülmedi) | `prompt-cache.test.js` K2; `prompt-cache-tester.test.js` "K2/K5" (3 işaret, son tur işaretsiz, girdi değişmez) |
| K3 istemci cache_control koymuş: gövde aynen, toplam en çok 4 | geçti | tester "K3" (mesajda 1 işaret -> aynı nesne; 4 istemci işareti -> 4) |
| K4 wire anthropic: tool_use/tool_result doğru yerde | geçti | `prompt-cache.test.js` "K4: OpenAI-shaped tool history" |
| K4 wire openai: işaret yok, uyarı | kısmen geçti | işaret eklenmiyor, başlangıçta stderr uyarısı var (test). `keysmith adapters check` uyarısı yok; wire geçişi yapılmadı (açık nokta, belgelenmiş) |
| K5 ttl 1h yazılır, ttl yoksa alan yok; kısa istekte işaret yok | geçti | tester "K2/K5", `prompt-cache.test.js` K5 |
| K5 API belgesi: model başına asgari uzunluk | kaldı | Aşağıda Kalanlar 1; tester todo testleri |
| K6 dry-run gövdeyi değiştirmez, plan adaptör istatistiğinde | geçti | tester "K6", K1 golden dry-run |
| K6 günlük satırında `cachePlan`, `keysmith usage` "olacaktı" | kaldı | Kalanlar 2 (açık nokta olarak bildirilmişti; kabul metni bunu istiyor) |
| K7 usage okuma/yazma, okunan pay %, tasarruf $, elle hesap | geçti | tester "K7 by hand": 9000x(2-0,1) - 1000x(2,5-2) = 0,0166 $, pay 9000/10100 = %89,1, tabloda görünür; 1h yazma için 0,0151 (`prompt-cache.test.js`) |
| K8 gerçek anahtarla cacheRead > 0 | yürütülmedi | Yöneticinin canlı kontrolü, yeniden başlatma sonrası |
| K9 `node --test` fail 0 | geçti (koşullu) | Tam paket paralel yük altında 5 başarısız + 145 iptal verdi; başarısız dosyalar (keysec, credit-guard, service-reload, wire-conformance, bridge-*, agents, scopes, integration) tek tek koşuldu: fail 0; aynı kümede main de yükte aynı biçimde düşüyor. Tam koşu temiz sonuç borç (ağır slot alınmadı) |
| K9 gitleaks | geçti | `gitleaks git --log-opts main..HEAD`: no leaks |
| K9 özel yol/e-posta/anahtar | geçti | eklenen satırlarda `/Users/`, `sk-ant`, kişi adı taraması 0 |
| API doğrulaması: cache_control yeri, TTL, fiyat çarpanları, usage alanları | geçti | Resmî belge: yazma 5m 1,25x, 1h 2x, okuma 0,1x (Sonnet 5.5 ve Opus 5.5 için 0,05x); `config.js` tablosu Sonnet 5.5 girdi 2 / okuma 0,1 / yazma 2,5 ile uyumlu; `cache_creation.ephemeral_1h_input_tokens` doğru okunuyor, en çok 4 nokta, thinking bloğu işaretlenmiyor |
| Regresyon: /v1/messages aktarma, claude-api-oai/media/streamUsage, usage hücre testleri | geçti | messages-relay 8, relay 10, media-http 18, tools-faces 28, usage-record 7, cli-usage 11, audit 50: hepsi geçti |
| Regresyon: toplu iş (main 0877d91) birleşik | geçti | batch 10, batch-review 2, batch-tester 8; birleştirme çakışmasız |
| Regresyon: ayarsız gateway bayt aynı | geçti | K1 |

## Kalanlar

1. Asgari uzunluk belgeyle çelişiyor. Gözlenen: kod her model için 1024, Haiku için 2048 (`src/prompt-cache.js` `minFor`). Beklenen (resmî belge): 512 (Sonnet 5.5, Opus 5.5, Haiku 5.5, Fable/Mythos 5.x), 1024 (Sonnet 5, Sonnet 4.6/4.5, Opus 4.8), 2048 (Opus 4.7), 4096 (Opus 4.6/4.5, Haiku 4.5). Etki: 4096 gereken modellerde 1024-4095 arası istekte işaret konuyor, API sessizce önbelleklemiyor (hata yok, zarar küçük); 5.5 modellerinde 512-1023 arası fırsat kaçıyor. Tester todo testleri bu iki durumu içeriyor (`prompt-cache-tester.test.js`).
2. K6: günlük satırında `cachePlan` ve `keysmith usage` "olacaktı" satırı yok; dry-run planı yalnız bellekteki `cacheStats`'ta (yeniden başlatmada kaybolur), yönetici "önce dry-run bir gün" kararını günlükten okuyamaz. Gözlenen: günlükte alan yok. Beklenen: `cachePlan:{breakpoints,estTokens}` ve usage satırı.
3. K4: wire `openai` kalan bağdaştırıcı için `keysmith adapters check` uyarısı yok (yalnız başlangıç stderr).
4. Gateway uçtan uca (gerçek `/v1/chat/completions` ve `/v1/messages` istekleriyle çalışan dal) yürütülmedi; kanıt adaptör düzeyinde stub'a giden gövde.
