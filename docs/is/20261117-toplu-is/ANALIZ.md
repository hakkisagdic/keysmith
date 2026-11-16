# 20261117-toplu-is: Batch iş türü (yarı fiyat, bekleyebilir işler)

## Bugün ne var
- `src/http-adapter.js`: `wire: anthropic` adaptörü canlı `/messages` çağırır; kullanım (input/output/cacheRead/cacheWrite) okunur. Batch yolu yok (kodda "batch" geçmiyor).
- `src/usage.js`: fiyat tablosu (`*/claude-opus-5-5*` vb.) ve maliyet hesabı; `usage.jsonl` yazımı. Batch fiyatı kavramı yok.
- `src/keys.js`: çağıran anahtar başına allow/deny ve günlük istek sınırı (`perDay`). `src/credit-guard.js` kredi koruması.
- `src/cli.js`: komut anahtarı (`switch`), `batch` komutu yok. `src/config.js`: `dataDir()` (iş durumu için yer), `configPath()`.
- Ölçüm (our-own-spend.md): üç Anthropic anahtarlı adaptörde cacheRead = 0; haftada ~6,5 M önbelleksiz girdi. Promosyon kredisi 9 Aralık'ta yanar.

## Ne değişecek
Yeni alan; hepsi yapılandırmada kapalı (`batch.enabled`, varsayılan false), açılmazsa çalışan gateway'de hiçbir şey değişmez.
- `src/batch.js` (yeni): Message Batches istemcisi (gönder, sorgula, sonuç, iptal), tahmin ve tavan hesabı, durum dosyası.
- `src/cli.js`: `keysmith batch submit|status|results|cancel`. Gönderim: JSONL dosyası, adaptör, iş adı, `--cap-usd`, `--key` (çağıran anahtar).
- Durum diskte `dataDir()/batch/<iş>.json` (id, adaptör, tahmin, tavan, durum, son yoklama); yoklama yeniden başlatmadan sonra kaldığı yerden sürer (`batch status` ya da açık gateway döngüsü).
- Sonuçlar girdi dosyasının yanına `<girdi>.results.jsonl`, aynı `custom_id` ile.
- `src/usage.js`: batch fiyatı = liste fiyatının %50'si (girdi, çıktı, önbellek okuma/yazma); her istek `usage.jsonl`'a `batch: true` ile yazılır.
- `src/keys.js` ile aynı kapı: çağıran anahtarın allow/deny'ı ve sınırları batch için de uygulanır.
- Batch arayüzü olmayan adaptör (anthropic wire değilse) net mesajla reddedilir.
- Önbellek: batch içinde `cache_control` yalnız dokümanın izin verdiği yerde; kodlamadan önce Anthropic resmi dokümanından (cache_control yeri, 5 dk/1 sa TTL ve fiyatları, model başına en az uzunluk, usage alanları; Batches: istek biçimi, sınırlar, sonuç alma, fiyat, promosyon kredisi geçerli mi) doğrulanacak; hafızadan kodlanmaz.
- Ucuzsa: `POST /v1/keysmith/batches` HTTP formu (aynı kod).
- `docs/`: README bölümü + sonuçta yönetici için iş örneği (eval harness referans koşusu) ve tam komutlar.

## Kabul kontrolleri
- K1: Verilen JSONL, anthropic wire'lı adaptör, tavan yeterli iken `keysmith batch submit` iş adını ve tahmini USD'yi basar, stub'a bir batch gider. Gözlem: komut çıktısı + stub günlüğü.
- K2: Tahmin tavanı aşıyorsa submit reddeder, stub'a hiçbir istek gitmez. Gözlem: çıkış kodu ≠ 0, mesajda tahmin ve tavan, stub sayacı 0.
- K3: Batch'siz upstream'li adaptör (openai wire) seçilince açık mesajla reddedilir.
- K4: Kısmi hata: stub 3 istekten 1'ini hatalı döndürür; `batch results` 3 satır yazar, aynı `custom_id`, hata satırı işaretli. `batch status` sayıları (başarılı/hatalı/süresi dolmuş) gösterir.
- K5: Süre dolumu ve iptal: stub `expired` döndürünce durum `expired`; `batch cancel <iş>` stub'a iptal gönderir, durum `canceled`.
- K6: Yeniden başlatma: submit sonrası süreç öldürülür (kendi PID'i), yeniden `batch status` aynı işi diskten bulur ve yoklamayı sürdürür; çift gönderim olmaz.
- K7: `usage.jsonl`'da her istek için bir satır, maliyet = canlı fiyatın yarısı; önbellek okuma/yazma sayıları ayrı. Gözlem: `keysmith usage` ya da dosya.
- K8: Çağıran anahtarın allow listesi adaptörü/modeli kapsamıyorsa submit reddedilir; `batch.enabled` kapalıyken komut "kapalı" der ve hiçbir şey yapmaz.
- K9: Tüm paket (`npm test`) yeşil; mevcut testler değişmeden geçer.
- K10: Depoda özel yol, e-posta, host adı, anahtar yok (`grep` ile).

## Riskler
- Para: tahmin yanlışsa tavan aşılabilir; tavan göndermeden önce hesaplanır, tahmin yukarı yuvarlanır (karakter/3,5 gibi temkinli) ve gerçek maliyet sonuçta karşılaştırılır. Batch fiyatı yanlış yazılırsa kayıt şişer/eksilir.
- Erişim: batch yolu çağıran anahtar kapılarını atlamamalı (K8). Anahtar değeri okunmaz/yazılmaz; mevcut exec referansı kullanılır.
- Kişisel veri: Anthropic batch 29 gün saklar, ZDR dışı; gizli/özel ürün verisi gönderilmez, README'ye uyarı.
- Göç yok. Bozulabilecek mevcut özellik: canlı `/messages` yolu, kullanım kaydı ve fiyat tablosu (regresyon: mevcut `usage-record`, `credit-guard`, `scopes` testleri).
- Çalışan gateway yeniden başlatılmaz; test örneği başka portta, kendi PID'iyle durdurulur.

## Kararlar
- Önce yalnız anthropic wire'ı; Gemini batch sonraki iş.
- Yoklama CLI'dan ve gateway açıksa arka plan döngüsünden; durum tek kaynak dosya.
- HTTP formu yalnız CLI kodunu çağıran ince katman; pahalı çıkarsa atlanır ve sonuçta söylenir.
- Önbellek yalnız doğrulanan yerde; asgari uzunluk altı istekte işaret konmaz.
- Tam test paketi öncesi `heavy_slot.sh acquire`; slot yoksa hedefli test, tam koşu borç olarak yazılır.
- Ayrı Opus incelemesi yok (sahip kararı); test kontrolleri belirler.

## Sahibe sorular
- Yok. Promosyon kredisinin batch'te geçerliliği doküman/ilk küçük gönderimle doğrulanır; geçmiyorsa gerçek maliyet raporda yazılır (geri alınabilir).

## Boyut
L: yeni alan (batch istemcisi, durum, CLI, kullanım muhasebesi, HTTP), 600 satırı geçer. Risk: para ve erişim dokunuşlu, yedek gerekmez (göç yok).
