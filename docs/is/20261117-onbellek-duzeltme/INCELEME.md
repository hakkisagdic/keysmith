# İNCELEME: 20261117-onbellek-duzeltme

Karar: **inmez** (1 büyük bulgu). Büyük bulgu düzeltilip testi eklenince iner; ikinci tur istenmez, düzeltmeyi test eden doğrular.

İncelenen: `git diff origin/main...is/20261117-onbellek-duzeltme` (taban 0877d91), değişen 15 dosyanın hepsi okundu. `node --test test/prompt-cache*.test.js` yerelde koşuldu: 24 test, fail 0, 2 todo. Asgari tablosu gerçek model kimlikleriyle denendi (tarih ekli, noktalı ve `[1m]` ekli yazımlar doğru satıra düşüyor). Tablo rakamlarını resmî sayfayla ben karşılaştırmadım; bu karşılaştırma TEST.md'de test edenin.

## Bakış açıları
1. Veri güvenliği: göç yok. Günlük satırına yalnız kuru çalışmada isteğe bağlı `cachePlan` alanı ekleniyor, eski satırlar aynı okunuyor. Varsayılan kapalı, ayar yoksa gövde bayt bayt aynı (K1 altın testi geçiyor).
2. Erişim: yeni uç yok. `cachePlanScope` istek başına ayrı bir `AsyncLocalStorage` deposu açıyor, istekler arasında plan sızmıyor.
3. Para ve kişisel veri: 1 saatlik önbellek yazımı aktarma yolunda fiyatlanmıyor (aşağıda, büyük). `cachePlan` içinde yalnız sayı var, kişisel veri yok.
4. Dürüstlük: K8 "yürütülmedi" olarak açıkça yazılmış. Kod düzeldiği hâlde iki eski `todo` testi duruyor. Belge eski asgari değerini söylüyor.
5. Sırlar: eklenen satırlarda anahtar, özel yol ya da e-posta yok. Testlerde `literal-test-value` kullanılmış.

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| büyük | src/server.js:1775 (`extractRelayedUsage`), src/server.js:2028 (`mergeUsage`) | `cacheWrite1h` yalnız bağdaştırıcının kendi ayrıştırıcılarında (`http-adapter.js` 1067, 1303, 1332) çıkarılıyor. Oysa `/v1/messages` ve passthrough aktarmasının kullanım satırı `extractRelayedUsage` ile yazılıyor ve bu fonksiyon `usage.cache_creation.ephemeral_1h_input_tokens` alanını okumuyor. Sunucudaki `mergeUsage` da bu alanı taşımıyor (gateway.js'deki kopyasına eklendi, buradakine eklenmedi). Sonuç: `ttl: "1h"` ile, ya da istemci kendisi 1h işareti koyduğunda, aktarma yolunda 1 saatlik yazım 5 dakikalık oranla (1,25x) fiyatlanıyor, oysa doğrusu 2x. `list-equiv` düşük, "saved at list price" yüksek çıkıyor. CHANGELOG'daki "cacheWrite1h is priced at 2x input" cümlesi bu yolda doğru değil, K8'in koşulacağı gerçek yol da bu yol. | `extractRelayedUsage` içindeki `pull` fonksiyonunda `raw.cache_creation?.ephemeral_1h_input_tokens` sayıysa `cacheWrite1h` olarak eklensin. Sunucudaki `mergeUsage`'a da gateway.js:1915'teki satırın aynısı (`Math.max`) eklensin. `/v1/messages` üzerinden 1h yazımlı bir yanıtın satırında `cacheWrite1h` bulunduğunu ve `tokensToUsd` sonucunun 2x oranla çıktığını doğrulayan bir test yazılsın (akışlı ve akışsız iki durum için). |
| küçük | docs/adapters.md:1071-1072 | Belge hâlâ "default 1024, 2048 for Haiku" diyor. Kod artık model tablosunu kullanıyor ve tabloda olmayan modelde en büyük asgariyi uyguluyor. Belge K5 düzeltmesiyle çelişiyor. | Cümle şöyle olsun: "asgari model tablosundan gelir (`src/prompt-cache.js`, kaynak ve okunma tarihi yanında); tabloda olmayan model en büyük asgariyi alır; `minTokens` tabloyu geçersiz kılar". |
| küçük | test/prompt-cache-tester.test.js:83, :89 | İki test hâlâ `todo` ve "code uses 2048 / default 1024" diyor. Kod düzeldi ama testler bir şey doğrulamıyor, TEST.md de "2 todo" diye geçiyor. | `todo` seçenekleri kaldırılsın, iki test gerçek doğrulama olarak koşsun (şu an geçmeleri gerekiyor). |
| küçük | src/prompt-cache.js:30 | Opus 5 deseninde (`opus[-.]5([-.]5)?(?!\d)`) Sonnet satırlarındaki koruma yok. `claude-opus-5-1` gibi tabloda olmayan bir sürüm 512 alıyor, kuralın istediği en büyük asgariyi (4096) almıyor. Denemede `claude-opus-5-50` da 512 döndü. | `opus${V}5(?!${V}\d(?!\d))` ve ayrıca `opus${V}5${V}5(?!\d)` olarak ikiye ayrılsın, `claude-opus-5-1` için 4096 bekleyen bir test eklensin. |
| küçük | src/usage.js:3632 | "estimated saving per reuse" diye gösterilen rakam tüm kuru çalışma isteklerinin toplamı, istek başına bir tekrar varsayılarak hesaplanıyor. Yazma primi de düşülmüyor. Rakam "tahmin" diye işaretli, ama "per reuse" ifadesi yanıltıcı. | Metin şöyle olsun: "estimated saving if each request were reused once, write premium not subtracted". Ya da yazma primi (`cacheWrite - input`) bir kez düşülsün. |

## Kabul kontrolleri
- K5a, K5b, K5c: kodda ve testte görüldü, geçiyor (opus 5.x için küçük not yukarıda).
- K6: kuru çalışmada gövde değişmiyor (K1 altın testi dry-run'ı da kapsıyor), satırda `cachePlan` var, çıktıda "ESTIMATE" satırı çıkıyor.
- K4: `checkAdapters` testi ve `cli.js` satırı tutarlı. `mode` yoksa ya da `off` ise uyarı çıkmıyor.
- K1-K3, K7, K9: geçiyor.
- K8: yöneticinin. Gerçek istek sonucu yok, bu yüzden geçti sayılmadı.
