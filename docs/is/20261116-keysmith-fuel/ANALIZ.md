# 20261116-keysmith-fuel: Katalog bilinçli limitler, TokenRouter/Mistral, discover, usage record

## Bugün ne var
- `src/profiles.js` HTTP profilleri: `groq` var (satır ~904); `tokenrouter` ve `mistral` yok. Katalog kavramı yok.
- Anahtarlar mtime ile yeniden okunuyor (`src/keys.js`); aynı desen katalog için yok. Config: `src/config.js`.
- Kullanım satırları `src/usage.js` (`UsageLog`, ay dosyası `monthFile`); `tier`/`source` alanı yok, `face: "external"` yok.
- `keysmith usage` yalnız okur (`src/cli.js`, `usage` komutu); `usage record` yok. `discover` komutu yok.
- Upstream 429 `src/http-adapter.js` içinde geçirilir (retry-after korunur) ama bekleme (cooldown) ve yerel dakika/gün/ay sınırı yok.
- Sunucu tarafı yerel 429 örneği: `src/server.js` (anahtar başına `perDay`).

## Ne değişecek
1. Yeni `src/catalogue.js`: isteğe bağlı config anahtarı `catalogue`; mtime ile yeniden okur; yalnız `sources[].reach.keysmith`, `limits`, `models[].tier` okunur. Adaptör başına requestsPerMinute/Day, tokensPerMonth sayaçları; aşımda yerel 429 + `retry-after`; upstream 429 sonrası cooldown. Geçersiz/eksik dosya: tek uyarı, başka değişiklik yok. Kullanım satırına bilindiğinde `tier`, `source`. Dokunulan: `gateway.js`/`http-adapter.js` (kanca), `usage.js`, `config.js`.
2. `profiles.js`: `tokenrouter` (https://api.tokenrouter.com/v1, wire openai) ve `mistral`. Adaptör seçeneği `freeOnly`: keşfedilen ücretsiz listede olmayan id reddedilir (mtime ile, yeniden başlatmasız).
3. `cli.js`: `keysmith discover tokenrouter`: `GET /v1/models`, giriş ve çıkış fiyatı 0 olanlar (fiyat alan yolları ayarlanabilir), `<data>/discovered/tokenrouter.json`; `discovery.enabled` false ise reddeder; 401 = "renew key".
4. `cli.js` + `usage.js`: `keysmith usage record` (`--source --model --tag --requests --credits --input --output --ms --accepted --id --from FILE`), `face: "external"`, tek O_APPEND yazım, `--id` ile tekrar yok, sunucusuz çalışır; `usage --by adapter` sayar.
5. Dokümanlar: README bölümleri, `docs/adapters.md` profil satırları, CHANGELOG. Testler `test/` altında (stub upstream, sağlayıcı trafiği yok).

## Kabul kontrolleri
- K1: Given worktree, when `machine-resources.sh check && node --test` çalışır, then tüm paket yeşil (yeni testler dahil).
- K2: Given mevcut diskteki config'in kopyası (`KEYSMITH_CONFIG`, ayrı `KEYSMITH_DATA`), when `serve --port 8788` açılıp evren, claude-api-oai, claude-failover, kiro rotalarına istek atılır, then eskisi gibi yanıt (gözlem: curl + status).
- K3: Given `catalogue`/`freeOnly`/`discovery` yok, when sabit bir istek yapılır, then kullanım satırı eski sürümle bayt bayt aynı (test + `keysmith usage --format json` karşılaştırması).
- K4: Given ana checkout, when `keysmith usage record --source qoder --model m --tag job/1 --id r1` iki kez çalışır, then ay dosyasında tek geçerli satır (`face: external`); `keysmith usage --by adapter` onu sayar; sunucu yeniden başlatılmaz.
- K5: Given stub katalog dakika=1, when iki istek ardışık gelir, then ikincisi 429 + retry-after; süre sonra 200; stub 429 sonrası cooldown içinde yerel 429.
- K6: Given `freeOnly:true`, when ücretsiz olmayan id istenir then reddedilir; `discovered` dosyası değişince kabul (yeniden başlatmasız).
- K7: Given stub /v1/models, when `discover tokenrouter` (switch açık) then yalnız fiyat 0 olanlar yazılır; switch kapalıyken ret; 401 çıktısı "renew key".
- K8: Given diff, when `grep` özel yol/e-posta ve `gitleaks detect --no-git --source src`, then bulgu yok; stub anahtar loglarda görünmez.

## Riskler
- Canlı gateway (Venizelos, polyctl reviewer, keyflip failover, tunnel) bozulması: regresyon kontrolü K2 + K3; var olan adaptör, takma ad, anahtar, sanal model değişmez.
- Sıcak yola eklenen sayaç/kanca gecikmesi ve hatalı yerel 429 (yanlış reddetme); katalog yoksa kod yolu atlanır.
- Kullanım dosyasına eşzamanlı yazım: tek O_APPEND yazım, satır < PIPE_BUF değilse bölünme riski; satırı kısa tut, test et.
- Halka açık repo: özel yol/e-posta/anahtar kodda ve testte olamaz; katalog yolu yalnız yerel config'te.
- `~/.config/keysmith/config.json`'a dokunulmaz (yalnız ikinci örneğin kopyası). Canlı yeniden başlatma bu işte yok.
- Para/kişisel veri/göç/erişim: yok (maliyet satırı yalnız kayıt; limitler kota koruması).

## Kararlar
- Katalog sürümü 1 şeması; bilinmeyen alanlar yok sayılır. Adaptör eşleme: `reach.keysmith` = adaptör id.
- Sayaçlar bellekte; sunucu yeniden başlayınca sıfırlanır (günlük/aylık için kullanım dosyasından yeniden hesap istenirse takip işi; bu öğe: tokensPerMonth ay dosyasından başlangıçta okunur, mümkünse).
- Cooldown süresi retry-after varsa o, yoksa 60 sn.
- `usage record --accepted` düzeltmesi aynı `--id` ile ek satır olarak eklenir.
- Hata dalları: geçersiz katalog = tek uyarı, davranış değişmez.

## Sahibe sorular
- Yok (tüm değerler geri alınabilir varsayılan; canlı yeniden başlatma ve 13 Kas config onayı bu işin dışında).

## Boyut
L: dört özellik, iki geliştirici dilimi (limit/katalog + CLI/usage), tahmini 600+ satır, test dahil. Risk işareti yok (para, kişisel veri, göç, erişim: hayır); inceleme canlı gateway nedeniyle yine önerilir.
