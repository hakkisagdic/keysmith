# TEST: 20261117-onbellek-duzeltme

Dal `is/20261117-onbellek-duzeltme`, yerelde koşuldu (canlı adres kanıt sayılmadı). Mod: function.
Koşular: `node --test test/prompt-cache*.test.js` (24 test, fail 0, 2 todo); `node --test test/messages-relay.test.js test/relay.test.js test/cli-usage.test.js test/batch*.test.js test/prompt-cache*.test.js` (74 test, fail 0); `node --test test/usage*.test.js test/cli-usage.test.js test/batch*.test.js test/source*.test.js` (48 test, fail 0, 1 atlandı). Tam paket koşulmadı (geliştiricinin ve releaser'ın kapısı).

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K5a satır başına altında işaret yok, üstünde var | geçti | `test/prompt-cache-duzeltme.test.js` "K5a" iki test; tablo resmî sayfayla elle karşılaştırıldı: 512 (Fable/Mythos 5.x, Opus 5/5.5, Sonnet 5.5, Haiku 5.5), 2048 (Mythos Preview, Opus 4.7), 4096 (Opus 4.6/4.5, Haiku 4.5), 1024 (Opus 4.8/4.1/4, Sonnet 5/4.6/4.5/4) birebir aynı |
| K5b bilinmeyen modelde en büyük asgari; minTokens kazanır | geçti | "K5b" testi; `UNKNOWN_MODEL_MIN_TOKENS = max(tablo)` kodda görüldü |
| K5c kaynak adresi ve okunma tarihi | geçti | `src/prompt-cache.js` tablo yorumu: platform.claude.com ... prompt-caching, "Read on 2026-11-17"; "K5c" testi |
| K6 kuru çalışma gövdeyi değiştirmez, günlükte cachePlan, usage'da tahmin işaretli satır | geçti | "K6" iki test; `src/usage.js` satırı "cache dry-run (ESTIMATE, not spent or saved)"; planı olmayan satırda alan yok |
| K4 openai wire + promptCache açık uyarı; anthropic/kapalı/ayarsız uyarı yok | geçti | Elle: dört ayarla `keysmith adapters check` (geçici yapılandırma, sahte anahtar): yalnız openai+on iken `! x: promptCache is on but its wire is openai ...` satırı; `checkAdapters` testi "K4" |
| K1 kapalı ayar bayt bayt aynı | geçti | `prompt-cache-tester.test.js`, `prompt-cache.test.js` geçti |
| K2 istemci cache_control aynen geçer | geçti | "K3: the client sets its own cache_control" testi |
| K3 tasarruf hesabı tutar | geçti | "K7: usage reads the cache fields and prices them" testi |
| K7/K9 paket fail 0, özel yol/e-posta/anahtar yok | geçti | koşular yukarıda; eklenen satırlarda `/Users/`, e-posta, `sk-` taraması boş (TEST.md eski dosyasındaki tek eşleşme tarama notunun kendisi) |
| K8 gerçek istekte cacheRead > 0 | yürütülmedi | yöneticinin; çalışan ağ geçidine dokunulmadı |
| Regresyon /v1/messages aktarma (rawMessages, failover) | geçti | `messages-relay.test.js`, `relay.test.js` fail 0 |
| Regresyon OpenAI araç çağrısı çevirisi | geçti | "K4: OpenAI-shaped tool history becomes tool_use/tool_result" testi |
| Regresyon usage hücre toplamları | geçti | `cli-usage.test.js`, usage testleri fail 0 |
| Regresyon toplu iş (0877d91) ve kaynaklar (c1c130e) | geçti | ikisi de dalın atasında; `batch*.test.js`, `source*.test.js` fail 0 |

## Kalanlar
- Kabul kontrollerinde kalan yok. K8 yöneticiye ait.
- Not: tablo değerleri güncel sayfayla bugün (2026-11-17) tutuyor; sayfa değişirse yeniden okunmalı.

## İnceleme düzeltmeleri

Bulgu 1 [büyük] aktarma yolunda 1h önbellek yazımı (`extractRelayedUsage`, `mergeUsage`): düzeltme b417208. Yerelde doğrulandı (canlı adres kanıt sayılmadı).

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| `extractRelayedUsage` `cache_creation.ephemeral_1h_input_tokens` okuyor, `mergeUsage` alanı düşürmüyor | geçti | `src/server.js` satır 1812-1818 ve 2043 (gateway.js'teki Math.max ile aynı biçim) |
| /v1/messages, akışsız ve akışlı: satırda `cacheWrite1h` = 400, `cacheWrite` = 500 | geçti | `test/messages-relay.test.js` "a 1h cache write reaches the row as cacheWrite1h and is priced at 2x input, streamed or not" geçti |
| `tokensToUsd` 1h yazımı 2x girdi oranından fiyatlıyor (400 x 6 = 400 x 2 x 3, 5m kısmı 100 x 3,75) | geçti | aynı test, beklenen tutarla 1e-9 içinde eşit |
| Test düzeltmeyi gerçekten yakalıyor | geçti | düzeltme geri alınınca (b417208^ `server.js`) test kaldı, geri konunca geçti; çalışma ağacı temiz geri döndü |
| Kapı: önbellek, kullanım, aktarma, toplu iş testleri | geçti | `messages-relay`, `relay`, `cli-usage`, `usage*`, `batch*`, `source*`, `prompt-cache*` dosyaları fail 0 |
| Ayarsız ağ geçidi bayt bayt aynı | geçti | `prompt-cache.test.js`, `prompt-cache-tester.test.js` geçti; düzeltme yalnız `cache_creation` alanı varken değer ekler |
| Tablo değerleri/kaynak/tarih | geçti | değişmedi; `src/prompt-cache.js` kaynak ve "Read on 2026-11-17" yorumu duruyor |
| Özel yol/e-posta/anahtar | geçti | dalın eklenen satırlarında `/Users/`, e-posta, `sk-` taraması: yalnız TEST.md'deki tarama notlarının kendisi eşleşti |

Tam paket (`node --test`): 987 test, 810-812 geçti, 1-3 kaldı, koşudan koşuya değişiyor. Kalanlar bu işle ilgisiz: (a) `test/wire-conformance*.test.js` ailesi, bu çalışma ağacında `node_modules` yok (`ai is not installed: run npm ci`), ortam eksiği; (b) "foreign tool while the result waits" ve "reloadAgent bootstraps" testleri yük altında bir koşuda kaldı, tek başına koşulunca geçti (`bridge-*`, `service-reload`, `cli-usage` fail 0). `npm ci` ile SDK testleri yürütülmedi.
