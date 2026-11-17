# İNCELEME: 20261117-fiyat-ve-kucuk-bulgular

**Karar: gönderilmez (1 büyük bulgu).** Fiyat rakamları doğru, anahtar kuralı ve https zorunluluğu doğru. Ancak raporun geçmiş satırları yeniden fiyatlaması, keysmith dışında yapılmış (abonelik ya da kredi ile ödenmiş) çalışmaları "metered" dolar olarak gösteriyor. Bu yanlış para demek.

Okunanlar: `git diff origin/main...is/20261117-fiyat-ve-kucuk-bulgular` (README.md, src/batch.js, cli.js, config-edit.js, config.js, price-cmd.js, prices.js, source.js, usage.js, test/*), ANALIZ.md, TEST.md. PLAN.md bu iş klasöründe yok. Rakamları Anthropic'in fiyat sayfasında kendim kontrol ettim (https://platform.claude.com/docs/en/about-claude/pricing, 2026-11-17): 15 modelin girdi, çıktı, 5 dk ve 1 sa yazma, okuma oranları ve batch'teki %50 indirim tabloyla birebir aynı. `node --test` ile price-tester, price, discover ve source testlerini koştum: 44/44 geçti.

## Mercekler

1. **Veri güvenliği:** Göç yok, `pricing` biçimi geriye uyumlu. `price set` önce tarihli yedek alıyor (`.bak-YYYYMMDD-HHMMSS-price`, 0600), sonra geçici dosya ve rename ile yazıyor. Kötü girdide dosyaya dokunmuyor (K5 testi). Günlük yeniden yazılmıyor. Sorun yok.
2. **Erişim:** `modelsRequest` anahtarı yalnız https ve baseUrl ile aynı köken (şema, makine, port) olduğunda gönderiyor. Bozuk adres anahtarsız gidiyor. Fiyat tablosu isteği hiç anahtar taşımıyor. `config set discovery.*.pricingUrl` de https istiyor. Sorun yok.
3. **Para ve kişisel veri:** 1 büyük, 3 küçük bulgu (aşağıda). Kişisel veri değişmiyor.
4. **Dürüstlük:** TEST.md'de K7'nin aynı-köken olumlu dalı "kısmen" olarak dürüstçe yazılmış (birim testi `modelsRequest` bu dalı kapsıyor). K2'yi tester testi yalnız "kayıt var" diye doğruluyor; rakamları geliştiricinin `PAGE` testi ve bu incelemedeki sayfa kontrolü doğruluyor. Tester testlerinde dış kaynaklı (`face: external`) satır yok, büyük bulgu bu yüzden görünmemiş.
5. **Sırlar:** Kodda, günlükte ya da commit'lerde gerçek sır yok. `audit.test.js` içindeki `sk-ant-...SUPERSECRET` değeri sahte bir test nöbetçisi (sentinel).

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| büyük | src/usage.js:2956-2968 (`_rowCost`) | Rapor, `basis: 'unpriced'` olarak yazılmış her satırı bugünkü tabloyla `metered` olarak yeniden fiyatlıyor. Tek istisna `row.kind === 'cli'`. `keysmith usage record` ile yazılan dış satırlarda (`face: 'external'`, `kind` yok) model `claude-*` ise `*/` kalıbı her adaptörle eşleşiyor. Örnek: `usage record --source kiro-cli --model claude-sonnet-4-5 --input 1000000 --output 200000` main'de `metered $0.00`, bu dalda `metered $6.00` gösteriyor (elle doğrulandı). Kiro, Copilot gibi kredi ya da abonelikle ödenen çalışmalar ödenmiş API harcaması gibi raporlanıyor. Daha önce hiç fiyatlanmamış 5-5 dış satırları da bundan etkileniyor. | Yeniden fiyatlamayı yalnız gerçekten metered olabilecek satırlarla sınırla: `row.face === 'external'` ise ya da `row.kind !== 'http'` ise `c`'yi olduğu gibi döndür. Aynı koşulu `_rowUnpriced` (src/usage.js:2970) için de koy, böylece dış satırlar doctor'da "price warning" üretmesin. Dış kaynaklı Claude satırı için bir test ekle: `metered` $0.00 kalsın, doctor uyarı vermesin. |
| küçük | src/usage.js:2956 (`_rowCost`) ve src/usage.js:1575 (`_addRowToSpendState`) | Rapor geçmiş "unpriced" satırları artık dolarla gösteriyor, aylık harcama sınırı (`limits.spend`) ise satırdaki eski `cost.usd` değerini (0) sayıyor. Bu yüzden `usage` raporu ile harcama sınırının ay toplamı birbirini tutmuyor. Ayrıca geçit yeniden başlatılınca Haiku 4.5, Opus 4.x ve diğer modellerin istekleri ilk kez harcama sınırına ve rezervasyona (`reserveSpend`) girecek. Bu doğru davranış, ama sahip bunu bilmeli. | Sınırlar bilerek değiştirilmeyecekse README'nin "Spend caps" bölümüne bir cümle ekle: "rapor eski satırları bugünkü tabloyla gösterir, sınır yazıldığı andaki tutarı sayar". Yönetici listesindeki "geçidi yeniden başlat" notuna da "yeni fiyatlanan modeller harcama sınırına girer" uyarısını ekle. |
| küçük | src/usage.js:3639, 3657 (CSV biçimi) | Tablo görünümü fiyatsız hücreye "unpriced" yazıyor. `--format csv` ise aynı hücreye `0` yazıyor ve `unpricedRequests` sütunu yok. K3'ün "asla 0 dolar" ilkesi CSV'de bozuluyor. ANALIZ kararı da fiyatsız satır için `usd: null` diyordu. | CSV başlığına `unpricedRequests` sütunu ekle ya da tamamen fiyatsız hücrede `meteredUsd` alanını boş bırak. README'deki "usd: 0 when no price entry matches" ifadesini bu kararla uyumlu hale getir. |
| küçük | src/cli.js:1404 (doctor) | Ücretsiz kaynaklar (tokenrouter, groq, cloudflare: http, metered sayılıyor) fiyat tablosunda yer almayan her modeli doctor'da "price warning" olarak listeliyor. Gerçek maliyeti 0 olan modeller için gürültü çıkıyor ve asıl eksik Claude fiyatı bu kalabalıkta gözden kaçabilir. | Uyarıyı `freeOnly` açık olan, `discovered` listesinde bulunan ya da `costBasis` tanımlı adaptörler için atla. Ya da yalnız metered Claude/Anthropic adaptörlerinin modellerini uyar. |

## Notlar (bulgu değil)

- `loadConfig`'teki `deepMerge`, kullanıcının `*/claude-opus-5-5*` gibi bir kaydını varsayılan kayıtla alan alan birleştiriyor. Kullanıcı yalnız `input` değerini değiştirirse `cacheWrite1h` varsayılandan (8) geliyor, 2x kuralından gelmiyor. Bugünkü canlı kayıtlarda iki yol aynı sonucu veriyor.
- Canlı `pricing` değişikliği geçit yeniden başlatılana kadar uygulanmaz. Bu, TEST.md'de ve ANALIZ'de doğru biçimde belirtilmiş.

Model: claude-opus-5-5
