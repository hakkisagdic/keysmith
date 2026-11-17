# 20261117-onbellek-duzeltme: istem önbelleği düzeltme turu

## Bugün ne var
- Dal `is/20261117-onbellek` (uç 28d273f) üstünde; ana dalda önbellek işi yok. Bu dal ondan açıldı. Ayrıntı: `docs/is/20261117-onbellek/ANALIZ.md` (K1-K9), `TEST.md`, `test/prompt-cache-tester.test.js`.
- Bağımsız test K1, K2, K3, K7, K9 ve regresyon listesini geçti; K4, K5, K6 kaldı.
- K5: `src/prompt-cache.js` `minFor` her model için 1024, Haiku için 2048 kullanıyor; resmî belgeyle çelişiyor (tester: 5.5 kuşağı 512, Sonnet 5/4.6/4.5 ve Opus 4.8 1024, Opus 4.7 2048, Opus 4.6/4.5 ve Haiku 4.5 4096).
- K6: kuru çalışma `planCache` raporunu üretiyor ama günlük satırına `cachePlan` yazılmıyor, `keysmith usage` "olacaktı" satırı göstermiyor.
- K4: `src/http-adapter.js` ~98-101 yalnız açılışta stderr mesajı veriyor; `gateway.checkAdapters` (çağrı `src/cli.js` ~889) bu durumu uyarmıyor.

## Ne değişecek
- Bu iki ayrı turda yapılan işin kapsamı yalnız üç düzeltme; K1-K3, K7, K9 aynen geçmeli.
- Düzeltme 1: `src/prompt-cache.js`: asgari uzunluk tek veri tablosu (model deseni -> token), tablonun üstünde kaynak sayfa adresi ve okunma tarihi yorumu. Rakamlar geliştirici tarafından güncel resmî belgeden okunur (bu belgedeki ya da istekteki sayılardan kopyalanmaz). Tabloda olmayan model: tablodaki en büyük asgari (işaret yok sayılıp yine yazma ücreti çıkmasın). `promptCache.minTokens` ayarı yine tabloyu geçer. Her satır için test.
- Düzeltme 2: `complete()`/`rawMessages()` kuru çalışma raporunu kullanım günlüğü satırına `cachePlan: {breakpoints, estTokens}` olarak yazar; `src/usage.js` + `keysmith usage` "önbellekle olacaktı" satırı ve tahmini tasarruf $ gösterir, açıkça "tahmin" diye işaretli. Gövde değişmez.
- Düzeltme 3: `checkAdapters` (ve `keysmith adapters check` çıktısı) `promptCache` açık + wire `openai` bağdaştırıcıda uyarı verir (açılış mesajı kalır). `claude-api-oai`'yi Anthropic wire'ına almak kapsam dışı; sonuçta ne gerektirdiği yazılır: wire `anthropic`, taban adres `/v1/messages` ucu, `complete()` yolunun OpenAI gövdesini Messages'a çevirmesi, görüntü/akış (`media`, `streamUsage`) denemesi, geri alınabilir ayar.
- Her düzeltme için önce başarısız test. Sonra main (0877d91 toplu iş, c1c130e kaynaklar) birleştirilir; önbellek, kullanım, aktarma, toplu iş testleri; iniş, push, bu dal + eski dal + iki worktree silinir.

## Kabul kontrolleri
- K5a: Given tablodaki her model satırı, when `planCache` o modelle ve satırın asgarisinin hemen altı/üstü uzunlukta çağrılır, then altında işaret yok, üstünde var (`node --test test/prompt-cache*.test.js`).
- K5b: Given tabloda olmayan model adı, when kısa-orta uzunlukta istek, then en büyük asgari uygulanır; `minTokens` ayarı varsa o kazanır.
- K5c: Given `src/prompt-cache.js`, then tablonun yanında kaynak adresi ve tarih var (dosyaya bak).
- K6: Given mode dry-run, when istek geçer, then stub gövdesi değişmemiş ve kullanım günlüğü satırında `cachePlan` var; `keysmith usage` çıktısında "tahmin" işaretli olacaktı satırı ve tasarruf görünür.
- K4: Given `promptCache` açık, wire `openai` bağdaştırıcı, when `keysmith adapters check`, then uyarı satırı çıkar; kapalı veya wire `anthropic` iken uyarı yok.
- K1-K3, K7, K9 yeniden: kapalı ayar bayt bayt aynı, istemci işareti aynen geçer, tasarruf hesabı elle tutar, paket "fail 0", özel yol/e-posta/anahtar yok.
- K8 (yönetici): iki ardışık aynı-prefix gerçek istek sonrası günlükte cacheRead > 0; komutları sonuçta yazılır. Çalışan ağ geçidi (`dev.keysmith.gateway`) durdurulmaz.

## Riskler
- Para: yanlış asgari yüzünden işaret yok sayılır ve yazma ücreti çıkar; en büyük asgari varsayılan bunu önler. Tahmini tasarruf gerçek sanılmasın diye işaretli.
- Bozma: ayarsız ağ geçidi öncekiyle bayt bayt aynı kalmalı (K1 regresyon). Günlük satırına yeni alan yalnız kuru çalışmada; eski satırlar okunmaya devam eder.
- Regresyon: `/v1/messages` aktarma yolu, usage hücre toplamları, toplu iş türü (main'den gelen), kaynaklar özelliği.
- Kişisel veri: `cachePlan` yalnız sayı; kodda/belgede özel yol, e-posta, anahtar yok (depo açık). Göç yok, erişim değişmez.

## Kararlar
- Tablo değerleri belgeden okunur, bu dosyada rakam verilmez.
- Bilinmeyen model = en büyük asgari (güvenli taraf).
- Uyarı `checkAdapters`'ta; açılış mesajı da kalır.
- Her şey kapalı; ayar yoksa davranış aynı. Tam paket için `heavy_slot.sh` yuvası; yoksa dokunulan alan testleri, tam koşu borç diye yazılır; zaman aşımı yeniden denenmez.

## Sahibe sorular
- Yok.

## Boyut
M: tek alanda üç küçük düzeltme (~250-350 satır testlerle); para etkisi (`touches.money`) olduğundan S değil, inceleme + yedek.
