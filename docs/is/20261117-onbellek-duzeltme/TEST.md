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
