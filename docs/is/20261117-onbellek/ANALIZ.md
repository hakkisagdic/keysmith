# 20261117-onbellek: Claude API yollarında istem önbelleği (prompt caching)

## Bugün ne var
- Üç Anthropic anahtarlı bağdaştırıcı (`claude-api`, `claude-api-yahoo`: wire `anthropic`; `claude-api-oai`: wire `openai`, Anthropic'in OpenAI-uyumlu ucu `/v1` üzerinden) ve failover'ın ücretli ayağı. 10-16 Kas ölçümü: haftada ~6,5M önbelleksiz girdi, üç bağdaştırıcıda cacheRead = 0 (PLAN.md #4).
- Hiçbir yerde `cache_control` konmuyor. `src/http-adapter.js` `complete()` (satır ~500-560) Messages gövdesini kuruyor: `system` düz metin, `messages` `anthropicWireMessages` ile; `rawMessages()` (~425) istemcinin Messages gövdesini olduğu gibi aktarıyor (Claude Code / failover yolu; istemci kendi `cache_control`'ünü koyuyorsa geçiyor).
- Kullanım okuması hazır: `usageFrom` (~1000-1035) `cache_read_input_tokens` / `cache_creation_input_tokens` alıp `usage.cacheRead/cacheWrite` yazıyor; `src/usage.js` (~774) maliyeti `config.js` fiyat tablosundan hesaplıyor, `keysmith usage` hücrelerde cacheRead/cacheWrite topluyor. Eksik: 5 dk / 1 sa yazma ayrımı yok, tablodaki `cacheWrite` 5 dk fiyatı (1,25x), `keysmith usage`'da "önbellekten okunan girdi payı" ve tasarruf $ yok.
- Yapılandırma: `adapters.<id>` alanları `src/cli.js` ~506 listesinde (`modelParams`, `headers`...).
- Önemli bulgu: `claude-api-oai` (haftalık 4,64M, en büyük pay) OpenAI-uyumlu uçtan gidiyor; o uç `cache_control` taşımaz. Önbellek için bu bağdaştırıcının wire'ı `anthropic` olmalı (gateway OpenAI gövdesini zaten Messages'a çeviriyor, `complete()` yolu).

## Ne değişecek
- Yeni `src/prompt-cache.js`: saf fonksiyon `planCache(body, setting, model)` -> {body, report}. Ayar `adapters.<id>.promptCache`: `{ mode: "off"|"dry-run"|"on", ttl: "5m"|"1h", minTokens }`; varsayılan yok = kapalı.
- Kural (muhafazakâr): istemci gövdede herhangi bir `cache_control` koyduysa dokunma (aynen geç). Yoksa en çok 3 kesme noktası: son `tools` öğesi, `system`'in son bloğu (string ise tek metin bloğuna çevir, metin aynı), `messages`'ta ardışık tur çifti öncesindeki son kararlı blok (son kullanıcı turunun bir önceki asistan/kullanıcı mesajının son bloğu; son tur kesinlikle değil). Sıra ve içerik değişmez; yalnız `cache_control: {type:"ephemeral"[,ttl:"1h"]}` eklenir. Tahmini uzunluk modelin asgarisinin altındaysa (resmî belgeden doğrulanacak; PLAN 512 diyor) ekleme.
- `complete()` ve `rawMessages()` bu planı gövde kurulduktan sonra çağırır; OpenAI-uyumlu rota `anthropicWireMessages` çıktısı üzerinden çevrilir. Kesme noktası en fazla 4 sınırı aşılmaz (istemcinin sayısı sayılır).
- TTL: varsayılan 5m; 1h yalnız ayarla. Fiyat kararı: okuma 0,05x, 5m yazma 1,25x, 1h yazma 2x. 1h, tur aralığı >5 dk olan ajan istemcilerde ve prefix en az bir kez daha okunacaksa kazandırır (1h = 5m + 0,75x; ikinci okumada başa baş). Belgelerden kod öncesi doğrulanır.
- Kullanım günlüğü: `usage.cacheWrite1h` (ve `cacheWrite5m` varsa `usage_details`'ten `cache_creation.ephemeral_*`) yazılır; fiyat tablosuna `cacheWrite1h` (2x) eklenir, yoksa 2x tabandan türetilir.
- `keysmith usage`: sütun/satır "önbellek okuma, yazma (token), girdinin önbellekten okunan payı, liste fiyatıyla tasarruf $" (okunan token x (girdi - okuma fiyatı) - yazma ek maliyeti).
- Dry-run: gövde değişmez; günlüğe `cachePlan: {breakpoints, estTokens}` yazılır, `keysmith usage` "olacaktı" satırını gösterir.
- Test: `test/prompt-cache.test.js`, stub upstream giden gövdeyi doğrular (aşağıdaki kontroller). README + docs/adapters.md + CHANGELOG. Toplu işlem (Message Batches) bu işin kapsamı DEĞİL: ayrı iş (bkz. Kararlar).

## Kabul kontrolleri
- K1: Given ayar kapalı (veya yok), when istek geçer, then stub'un aldığı gövde bugünkü ile bayt bayt aynı (golden karşılaştırma testi; `node --test test/prompt-cache.test.js`).
- K2: Given `claude-api` mode on ttl 5m, istemci kesme noktası koymamış uzun system+tools+geçmiş, when `/v1/chat/completions` ile istek, then stub'un aldığı gövdede son tool'da, system son bloğunda ve son-tur-öncesi bloğunda `cache_control:{type:"ephemeral"}` var, hiçbir metin/sıra değişmemiş (içerik diff'i boş).
- K3: Given istemci kendi `cache_control`'ünü koymuş (Messages yüzü, `/v1/messages`), when mode on, then gövde aynen geçer, gateway ek nokta eklemez (en fazla 4 toplamı).
- K4: Given `claude-api-oai` wire `anthropic`'e alınmış, OpenAI biçiminde (tool_calls, tool mesajları içeren) istek, when mode on, then stub Messages biçiminde `tool_use`/`tool_result` ile ve doğru yerlerde `cache_control` ile alır; wire `openai` kalırsa gövdeye `cache_control` eklenmez ve `keysmith adapters check`/günlük uyarı verir.
- K5: Given ttl 1h, then işaretler `ttl:"1h"`; given ttl verilmemiş, then ttl alanı hiç yok. Asgari uzunluğun altındaki kısa istekte hiç işaret yok.
- K6: Given dry-run, when istek, then stub gövdesi K1'deki gibi aynı ve günlük satırında `cachePlan` var; `keysmith usage` "olacaktı" satırını gösterir.
- K7: Given stub yanıtı `usage` içinde `cache_creation_input_tokens: 1000`, `cache_read_input_tokens: 9000` (ve `cache_creation.ephemeral_1h_input_tokens`), when `keysmith usage --by adapter`, then okuma/yazma token'ları, "girdinin okunan payı %" ve liste fiyatıyla tasarruf $ görünür; Sonuç elle hesapla uyuşur (Sonnet 5.5: 9000 x (2 - 0,1)/1M = 0,0171 $ eksi yazma ek maliyeti).
- K8: Given gerçek anahtarla (ikinci örnek, başka port) iki ardışık aynı-prefix istek, when ikinci yanıt, then günlükte cacheRead > 0. Yeniden başlatma sonrası ertesi gün: `keysmith usage --since 1d --by adapter` ile cacheRead > 0 ve pay yüzdesi.
- K9: Given tüm paket, then `node --test` "fail 0" (todo'lar hariç), gitleaks temiz, kodda/belgede özel yol-e-posta-anahtar yok.

## Riskler
- Para: yanlış fiyat (1h yazma 2x, 5m 1,25x) tasarruf raporunu şişirir; 1h yazma kısa ömürlü prefix'te zarar eder. Para: `touches.money` -> en az M, inceleme+yedek.
- Bozma: sistem string'i bloğa çevirmek ve kesme noktası eklemek bazı istemcilerde (ör. thinking, `output_config`) uyumsuz olabilir; "kararlı" tanımı sıkı, sapma halinde kapalı yedek: ayar off.
- Regresyon: `/v1/messages` aktarma yolu (`rawMessages`, Claude Code, failover) bozulmamalı; OpenAI-uyumlu araç çağrısı çevirisi (`anthropicWireMessages`); mevcut `usage` hücre/aşırı sayım testleri; `claude-api-oai` wire değişimi başka istemcileri etkiler (görüntü/akış davranışı: `media`, `streamUsage`).
- Kişisel veri: günlüğe gövde yazılmaz (`log.body` kapalı); `cachePlan` yalnız sayılar.
- Göç yok; erişim kontrolü değişmez.

## Kararlar
- Varsayılan KAPALI: iniş çalışan gateway'i değiştirmez; yeniden başlatma yönetici saatinde.
- Önbellek yalnız wire `anthropic` bağdaştırıcılarda; OpenAI-uyumlu uçta işlevsiz, o yüzden `claude-api-oai` için wire anthropic'e geçiş önerilir (ayrı yapılandırma adımı, geri alınabilir).
- Önce `dry-run` bir gün, sonra `on`. Başlangıç TTL: 5m; 1h yalnız Claude Code/ajan istemcisi bağdaştırıcılarında.
- Tüm API ayrıntıları (kesme yeri, TTL fiyatları, model başına asgari uzunluk, usage alanları) kodlamadan önce resmî belgeden doğrulanır; Message Batches (istek biçimi, 50 % fiyat, limitler, promosyon kredisi geçerliliği) AYRI iş: istek metnindeki "Toplu işlem" ve Google kredisi kalemleri bu öğede yok.
- Failover ücretli ayağı: istemci kesme koyuyorsa geçer; koymuyorsa aynı kural `rawMessages`'ta ayar açıksa uygulanır.
- Kesme noktası: en fazla 3 gateway, 4 toplam; mesaj noktası son turu hariç tutar.

## Sahibe sorular
- Yok (hepsi geri alınabilir ayar). Bilgi: yapılandırma komutu inişten sonra sonuçta yazılacak.

## Boyut
M: mevcut alanda tek özellik (yeni modül + iki yola kanca + usage), ~500-650 satır testlerle. Risk (para) nedeniyle S değil.
