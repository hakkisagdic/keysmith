# 20261116-keysmith-fuel: Test sonucu (uçtan uca, işlev modu)

Dal `is/20261116-keysmith-fuel`, yerelde çalıştırıldı; canlı URL kanıt değil. Elle yürüyüşler ayrı `KEYSMITH_CONFIG`/`KEYSMITH_DATA`
ile, 8788 (config kopyası), 8790 (stub upstream 8799) portlarında yapıldı. Canlı config ve canlı veri dizinine dokunulmadı.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 tam paket yeşil | geçti | `machine-resources.sh check` rc=0; `node --test`: 911 test, 885 geçti, 0 kaldı, 26 todo (önceden bilinen wire-conformance boşlukları); `gitleaks detect --no-git --source src`: sızıntı yok |
| K2 8788 örneği: evren, claude-api-oai, claude-failover, kiro | geçti (kiro notlu) | config kopyası ile `serve --port 8788`; curl: `evren/deepseek-v4-flash` 200, `claude-failover` 200 ("Ok"), `claude-api-oai/claude-haiku-5-5` 200, `kiro/auto` 429 (kiro kredi koruması: plan %112,8, `creditGuardThreshold` 112; bu dalda değişmeyen mevcut kod, rota yanıtlıyor, hata biçimi eskisi gibi) |
| K3 yapılandırma yokken kullanım satırı bayt bayt aynı | geçti | `test/catalogue-gateway.test.js` "K3 ...", `test/slice2-checks.test.js` "K3 ..." ; elle: 8788 satırlarında `source`/`sourceTier` yok |
| K4 usage record, `--id` tekrarı tek satır, `usage --by adapter` sayar | geçti (ayrı veri dizini) | `usage record --source qoder --model m --tag job/1 --id r1` iki kez: "recorded 1 external row" / "already recorded: r1"; dosyada tek satır `face:external`; `usage --by adapter` qoder=1; sunucu açılmadı. `--accepted` farklıysa ek (amends) satır, tasarım gereği. Ana checkout'un gerçek veri dizinine yazılmadı: o adım sahibin onayında |
| K5 dakika/gün limit 429 + retry-after, cooldown | geçti | stub, dakika=1: 1. istek 200, 2. istek 429 `retry-after: 60`, 62 sn sonra 200; stub 429 (`retry-after: 5`) sonrası cooldown içinde yerel 429 (`retry-after: 5`, stub'a gitmedi), 6 sn sonra 200. Testler: K5 x4. Gün sınırı yalnız birim testinde (`catalogue.test.js`), elle yürütülmedi |
| K6 freeOnly ret, discovered değişince kabul | geçti | `fo/free-a` 400 "not on the discovered free list"; `discovered/fo.json` yazılınca aynı süreçte 200; `paid-b` 400 |
| K7 discover fiyat 0, switch kapalı ret, 401 renew key | geçti | stub 3 model (2 ücretsiz, biri `"0"` dizgesi, biri 0 sayı): "2 free models written", dosya 0600, `free-a`,`free-c`; switch kapalı: "discovery is off", rc=1, dosya yok; 401: "renew key: tokenrouter", stub anahtarı çıktıda yok |
| K8 özel yol/e-posta yok, gitleaks temiz, anahtar logda yok | geçti | gitleaks "no leaks found"; `git diff main...` eklenen satırlarda özel yol/e-posta yok (tek eşleşme PLAN.md'deki grep komutunun kendi metni); `sk-test-STUBSECRET123` sayısı: sunucu logu 0, usage.jsonl 0, discovered 0, discover çıktısı 0 |
| Reg: evren, claude-api-oai, claude-failover, kiro rotaları | geçti | K2 ile aynı |
| Reg: mevcut adaptör, takma ad, anahtar, sanal modeller | geçti | 8788: `claude-failover` takma adı 200; 8 kapsamlı anahtar yüklendi, `/v1/models` listesi geldi; testte groq profili 200 ve eski profiller değişmedi |
| Reg: katalog yokken kullanım satırı biçimi | geçti | K3 ile aynı |
| Reg: anahtar redaksiyonu loglarda | geçti | K8 anahtar sayımı; 8788 sunucu logu ve usage.jsonl'de gateway anahtarı yok |

## Kalanlar
Başarısız kontrol yok. Notlar:
- Kiro rotası bu makinede kredi koruması nedeniyle 429 verdi; K2'nin "kiro eskisi gibi" ölçütü yanıt biçimi için karşılandı, gerçek kiro yanıtı (200) alınamadı.
- Gün sınırı (requestsPerDay) ve tokensPerMonth yalnız birim/test düzeyinde; elle çalışan sunucuda yürütülmedi.
- K4'ün "ana checkout" adımı canlı veri dizinine yazmayı gerektirir; yürütülmedi (ayrı dizinde aynı komutlar geçti).
