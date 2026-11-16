# 20261116-keysmith-fuel: Plan

## Tasarım
- **Tek yeni modül `src/catalogue.js`, `config.js`'e dokunulmaz.** Katalog, discovered listesi ve sayaçlar burada; `DEFAULTS`'a anahtar eklenmez.
  `saveConfig` yeni alan yazmaz, yapılandırma yokken eski kod yolu birebir kalır (K3).
- **Limit kontrolü HTTP adaptöründe, fetch'ten hemen önce.** `gateway.js`'te beş ayrı leg çağrısı var, `HttpAdapter.complete` ise tek yer.
  Yerel ret, upstream 429 ile aynı `LlmError` (429, `rate_limit_error`, `retryAfter`) olarak atılır; takma ad zinciri onu bugünkü 429 gibi işler.
- **Bağlama, `creditGuard` deseninde.** Gateway `cfg.catalogue` varsa tek `CatalogueLimiter` kurar ve her `HttpAdapter`'a `adapter.limiter` olarak verir.
  Varsayılan `null` olur ve kanca tek bir `if` ile atlanır. Sıcak yola başka iş binmez.
- **Sayaçlar bellekte tutulur.** Dakika kayan pencereyle (son 60 sn'nin zaman damgaları), gün yerel takvim günüyle (`quota.js` gibi), ay UTC ayıyla (`utcMonth`) sayılır.
  `tokensPerMonth` başlangıçta ay dosyasından tohumlanır (dilim 3'teki `monthTokensByAdapter`, isteğe bağlı çağrı). Basit ve sınanabilir bir yol.
- **Satır alanları `source` ve `sourceTier` olur.** Sanal model satırları `tier`'ı zaten başka anlamda kullanıyor.
  ANALIZ'deki "tier" bu adla yazılır. Bilinmiyorsa alan hiç yazılmaz (K3).
- **`usage record`, var olan `UsageLog.record` üzerinden tek `writeSync` (O_APPEND) yapar.** Sunucunun okuyucusu dışarıdan büyüyen dosyayı zaten okuyor (usage.js ~2616), bu yüzden yeniden başlatma gerekmez.
  `--id` tekrarını kısa bir kilit dosyası (`wx`) ve ay dosyası taraması önler.
- **`discovery.enabled` varsayılanı kapalıdır.** Komut yeni ve ağ trafiği yapıyor. Kapalı varsayılan geri alınabilir ve canlıyı etkilemez.

## Dilimler

### Dilim 1: Ortak sözleşme: katalog, sayaç, discovered listesi
- **Bağımlılık:** yok.
- **Sahip olduğu dosyalar:** `src/catalogue.js` (yeni), `test/catalogue.test.js` (yeni).
- **Ne kurar:** saf, ağsız bir modül.
- **Dışa aktarılanlar ve kurallar:**
  - `catalogueSettings(cfg)`, şunu döner: `{ path|null, discovery: { enabled:false, <adapterId>: { inputPricePath:'pricing.prompt', outputPricePath:'pricing.completion' } } }`.
    Yol `expand()` ile açılır. `cfg.catalogue` yalnız bir dosya yoludur (string).
  - `loadCatalogue(path, { log })` bir okuyucu döner. `get()` her çağrıda `statSync` ile mtime'a bakar, değiştiyse yeniden okur.
    Şema sürüm 1: `{ version:1, sources:[{ id, reach:{ keysmith:'<adapterId>' }, limits:{ requestsPerMinute, requestsPerDay, tokensPerMonth }, models:[{ id, tier }] }] }`.
    Bilinmeyen alanlar yok sayılır. Dosya geçersiz ya da eksikse aynı mtime için tek uyarı verilir ve boş katalog döner.
  - `class CatalogueLimiter({ catalogue, now, seedMonthTokens })` şu yöntemleri taşır:
    - `admit(adapterId)`: `{ ok:true }` ya da `{ ok:false, retryAfter, why }`. Kabul edilen istek sayılır, ret sayılmaz.
    - `noteTokens(adapterId, n)`.
    - `noteUpstream429(adapterId, retryAfterSec)`: bekleme süresi retry-after'dır, yoksa 60 sn. Bekleme bitene kadar `admit` reddeder.
    - `info(adapterId, model)`: `{ source, tier }` ya da `null`.
    - Retry-after hesabı: dakikada en eski damga+60 sn, günde yerel gece yarısı, ayda bir sonraki UTC ayı (`nextMonthStartUtc`).
  - `catalogueLimitError(adapterId, d)` bir `LlmError` döner: status 429, `rate_limit_error`, `retryAfter`. Mesaj adaptörü ve sınırı söyler, anahtarı asla söylemez.
  - `discoveredPath(dataDir, adapterId)`, `<data>/discovered/<id>.json` yolunu verir.
  - `readDiscovered(file)` mtime önbellekli bir `Set` ya da `null` döner. `writeDiscovered(file, ids)` tmp dosyasına yazıp `rename` eder, izin 600 olur.
  - `freeModels(list, { inputPricePath, outputPricePath })`: giriş ve çıkış fiyatı sayı olarak 0 olan id'leri seçer. `"0"` da sıfır sayılır. Alan yoksa model ücretsiz sayılmaz.
- **Testler (`test/catalogue.test.js`):**
  - mtime ile yeniden okuma.
  - Bozuk JSON'da tek uyarı.
  - Dakika ve gün limitleri, sahte saatle.
  - `tokensPerMonth` ve tohum.
  - Cooldown, retry-after varken ve yokken (60 sn).
  - `freeModels` fiyat yolları.
  - `writeDiscovered` dosyasının izinleri.
- **Karşıladığı kontroller:** K1 (birim düzeyi). K5, K6 ve K7'nin mantık temeli burada kurulur.
- **Kapı:** `cd ~/.polyctl/admin/team/wt/20261116-keysmith-fuel && ~/.claude/scripts/machine-resources.sh check && node --test test/catalogue.test.js && node --test`

### Dilim 2: Sıcak yol: limit kancası, freeOnly, profiller, satır alanları
- **Bağımlılık:** 1.
- **Sahip olduğu dosyalar:** `src/http-adapter.js`, `src/gateway.js`, `src/server.js`, `src/profiles.js`, `test/catalogue-gateway.test.js` (yeni).
- **`gateway.js` değişiklikleri:**
  - Kurucu, `catalogueSettings(cfg).path` varsa bir `CatalogueLimiter` kurar.
  - `seedMonthTokens: (id) => this.usage?.monthTokensByAdapter?.()?.[id] ?? 0` verilir. Yöntem dilim 3'te gelir; yokken 0 kullanılır.
  - Satır ~107.de kurulan her `HttpAdapter` için `adapter.limiter = this.catalogue` atanır. `checkAdapter` (doctor) ve `CliAdapter` değişmez.
- **`http-adapter.js` değişiklikleri:**
  - Kurucu `this.limiter = null` yapar.
  - `complete` içinde fetch'ten önce iki kontrol çalışır:
    1. `freeOnly`: `cfg.freeOnly === true` ise `readDiscovered(discoveredPath(dataDir(), id))` okunur. Liste yoksa ya da id listede değilse 400 `invalid_request_error` verilir: "<model> is not on the discovered free list (keysmith discover <id>)". Liste mtime ile yeniden okunur, yeniden başlatma gerekmez.
    2. `limiter?.admit(id)`: ret gelirse `catalogueLimitError` atılır.
  - `!res.ok && status 429` olunca `limiter?.noteUpstream429(id, retryAfter)` çağrılır, sonra bugünkü `upstreamError` atılır.
  - Usage olayında `limiter?.noteTokens(id, input+output)` çağrılır.
- **`server.js` değişikliği:** `stamp()` (~2058), `gateway.catalogue?.info(adapter, model)` sonuç verirse satıra `source` ve `sourceTier` ekler. Vermezse satır bayt bayt aynı kalır.
- **`profiles.js` değişikliği:** `groq` satırının yanına iki profil eklenir:
  - `tokenrouter: { kind:'http', wire:'openai', baseUrl:'https://api.tokenrouter.com/v1', apiKey:'{env:TOKENROUTER_API_KEY}' }`
  - `mistral: { kind:'http', wire:'openai', baseUrl:'https://api.mistral.ai/v1', apiKey:'{env:MISTRAL_API_KEY}' }`
  - Var olan profil, takma ad ve sanal modellere dokunulmaz.
- **Testler (`test/catalogue-gateway.test.js`):** yerel stub upstream (`http.createServer`) kullanılır, gerçek sağlayıcıya gidilmez.
  - K5: dakika=1 iken ikinci istek 429 + `retry-after` alır. Sahte saat ilerleyince 200 döner. Stub 429 ve `retry-after: 5` döndükten sonra bekleme içinde gelen istek stub'a gitmeden 429 alır.
  - K6: `freeOnly` ile listede olmayan id 400 alır. Discovered dosyası yeniden yazılınca (mtime değişir) aynı Gateway nesnesi kabul eder.
  - K3: katalog yokken sabit bir isteğin satırı, `catalogue` alanı olmayan eski config ile bayt bayt aynı çıkar (`ts` ve `ms` sabitlenir).
  - Stub anahtarı (`sk-test-...`) log yakalayıcısında görünmez.
- **Karşıladığı kontroller:** K2, K3, K5, K6.
- **K2 elle doğrulama (ajan çalıştırır, canlı config'e dokunulmaz):**
  - Config `cp ~/.config/keysmith/config.json "$S/config.json"` ile kopyalanır. `KEYSMITH_CONFIG=$S/config.json KEYSMITH_DATA=$S/data node src/cli.js serve --port 8788` arka planda başlatılır.
  - `evren`, `claude-api-oai`, `claude-failover`, `kiro` rotalarına birer `curl` atılır ve durum kodu ile ilk satır karşılaştırılır.
  - Sunucu iş bitince kendi PID'iyle kapatılır. `$S`, oturumun scratchpad klasörüdür.
- **Kapı:** `cd ~/.polyctl/admin/team/wt/20261116-keysmith-fuel && ~/.claude/scripts/machine-resources.sh check && node --test test/catalogue-gateway.test.js && node --test`

### Dilim 3: CLI: `discover` ve `usage record`
- **Bağımlılık:** 1. Dilim 2 ile paralel gidebilir.
- **Sahip olduğu dosyalar:** `src/cli.js`, `src/usage.js`, `test/usage-record.test.js` (yeni), `test/discover.test.js` (yeni).
- **`keysmith discover <adapterId>`:**
  - Ayarlar `catalogueSettings(cfg).discovery` üzerinden okunur. `enabled !== true` ise komut çıkış kodu 1 ve "discovery is off (discovery.enabled)" ile reddeder, ağa gitmez.
  - Açıksa adaptörün `baseUrl`'üne `GET /models` atılır; anahtar `resolveSecret` ile alınır.
  - 401/403 gelirse çıktı "renew key: <adapterId>" olur ve çıkış kodu 1'dir.
  - Başarıda `freeModels` sonucu `writeDiscovered(discoveredPath(dataDir(), id))` ile yazılır ve sayı basılır.
- **`keysmith usage record`:**
  - Bayraklar: `--source --model --tag --requests --credits --input --output --ms --accepted --id --from FILE`. `--from` her satırı bir kayıt olan JSONL dosyası okur.
  - Sunucu açılmaz. Yeni `UsageLog.recordExternal(entry)` şu satırı yazar: `{ ts, face:'external', adapter:<source>, source, model, tag, requests, credits, usage:{input,output}, ms, accepted?, id? }`.
  - Alanlar 128 karakterle kırpılır, böylece satır kısa kalır ve tek `writeSync` ile yazılır.
  - `--id` verildiyse `<data>/usage-record.lock` `wx` ile alınır (2 sn deneme, 10 sn'den eski kilit bayat sayılır). Ay dosyasında aynı `id`'li external satır varsa yazılmaz ve "already recorded" basılır.
  - Tek istisna: `--accepted` verilmiş ve son satırdakinden farklıysa `amends:true` ile ek satır yazılır.
  - `_AccumulateRowIntoCell`, external satırı `requests` sayısı kadar (`count`) sayar; `amends` satırını saymaz.
- **`UsageLog.monthTokensByAdapter()`:** içinde bulunulan ayın input+output toplamını adaptöre göre döner. Var olan ay toplamı yolu kullanılır; ikinci bir tam tarama eklenmez.
- **Testler:**
  - `test/usage-record.test.js`, geçici `KEYSMITH_DATA` ile:
    - aynı `--id` iki kez yazılınca tek satır kalır;
    - `--accepted` düzeltmesi ek satır olur ve sayılmaz;
    - `usage --by adapter --format json` external satırı sayar;
    - satır 512 bayttan kısadır;
    - açık bir `UsageLog` nesnesi (sunucu benzeri) yeni satırı yeniden kurulmadan görür.
  - `test/discover.test.js`, stub `/v1/models` ile:
    - yalnız fiyatı 0 olanlar yazılır;
    - switch kapalıyken ret gelir ve stub'a istek gitmez;
    - 401'de "renew key" çıkar;
    - anahtar çıktıda görünmez.
- **Karşıladığı kontroller:** K4, K7.
- **K4 canlı adımı (dilim indikten sonra ana checkout'ta):** önce yedek alınır (aşağıda). Sonra `keysmith usage record --source qoder --model m --tag job/1 --id r1` iki kez çalıştırılır ve `keysmith usage --by adapter` ile bakılır.
- **Kapı:** `cd ~/.polyctl/admin/team/wt/20261116-keysmith-fuel && ~/.claude/scripts/machine-resources.sh check && node --test test/usage-record.test.js test/discover.test.js && node --test`

### Dilim 4: Dokümanlar ve son tarama
- **Bağımlılık:** 2, 3.
- **Sahip olduğu dosyalar:** `README.md`, `docs/adapters.md`, `CHANGELOG.md`.
- **Ne yazar:**
  - README'de "Usage audit, pricing and spend caps" bölümünün yanına iki alt bölüm: "Catalogue limits" (şema örneği, retry-after, cooldown) ve "Recording external usage" (`usage record`).
  - "Built-in profiles" listesine `tokenrouter` ve `mistral` eklenir; `discover` ve `freeOnly` anlatılır.
  - `docs/adapters.md`'ye iki profil satırı eklenir.
  - CHANGELOG'a "Unreleased" girdisi eklenir.
  - Örnek yollar `~/catalogue.json` gibi genel yollardır. Kişisel yol ve e-posta yazılmaz.
- **K8 taraması:**
  - `git diff origin/main... | grep -nE '/Users/|@[A-Za-z0-9.-]+\.(com|net|org|tr)'` boş dönmeli.
  - `gitleaks detect --no-git --source src` ve `gitleaks detect --no-git --source test` temiz çıkmalı.
  - Dilim 2 ve 3'teki "anahtar görünmez" testleri yeşil olmalı.
- **Karşıladığı kontroller:** K8, K1 (tam paket).
- **Kapı:** genel kapı ile aynı (aşağıda) ve ardından K8 taraması.

## Göç ve yedek
- Şema veya veritabanı göçü yok. Yeni alanlar yalnız eklenir (`source`, `sourceTier`, `face:'external'`). Eski okuyucular bu alanları yok sayar.
- Canlı `~/.config/keysmith/config.json` değişmez. `catalogue`, `discovery` ve `freeOnly` sonradan, ayrı onayla eklenir. Canlı yeniden başlatma bu işin dışında.
- Yazan tek canlı adım K4'tür; gerçek veri klasörüne satır ekler. Öncesinde yedek alınır:
  `mkdir -p ~/.polyctl/admin/backups/keysmith-20261116 && cp -p ~/.local/share/keysmith/usage*.jsonl ~/.polyctl/admin/backups/keysmith-20261116/`
  Komut ana checkout makinesinde çalışır.
- **Geri alma:**
  - Kod tarafı: commit `git revert` ile geri alınır.
  - K4 satırı: `id:"r1"` olan external satır bir filtre kopyasıyla çıkarılır, eski dosya `~/.polyctl/admin/trash.sh` ile kaldırılır. Yedeğin üstüne yazılmaz.

## Gerileme kontrolleri
- `evren`, `claude-api-oai`, `claude-failover` ve `kiro` rotaları ikinci örnekte eskisi gibi yanıt vermeli (K2). Bunlar Venizelos, polyctl reviewer, keyflip failover ve tunnel trafiğini taşır.
- Katalog yokken satır biçimi değişmemeli (K3). Bunu spend cap, `usage --by`, günlük `perDay` kotası ve failover raporu okur. Mevcut testler: `spend-window`, `quota`, `cli-usage`, `failover-report`.
- Takma ad zincirinde yerel 429 bugünkü upstream 429 gibi davranmalı: sıradaki leg denenir, son leg'de 429 + `retry-after` istemciye iletilir. `relay` ve `virtual-models` testleri yeşil kalmalı.
- `groq` ve diğer HTTP profilleri değişmemeli (`unit.test.js`). Hiçbir CLI adaptörüne limiter bağlanmaz.
- Dışarıdan büyüyen usage dosyası, açık sunucu sayaçlarını bozmamalı (`audit.test.js`, günlük toplamlar).
- Anahtar ve sır gizleme (`redact.js`) yeni log ve hata metinlerinde de geçerli olmalı (`secrets.test.js`, `keysec.test.js`).

## Kapı
`cd ~/.polyctl/admin/team/wt/20261116-keysmith-fuel && ~/.claude/scripts/machine-resources.sh check && node --test`
