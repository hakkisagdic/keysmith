# 20261117-fiyat-ve-kucuk-bulgular: Fiyat tablosu eksiksiz, https zorunlu, anahtar yalnız aynı kökene

## Bugün ne var
- `src/usage.js` `DEFAULT_PRICING` yalnız 3 kalıp tutar (`*/claude-opus-5-5*`, `sonnet-5-5`, `haiku-5-5`); canlı dosyada (`pricing`) bunlara ek bir Gemini kaydı var. Tablo `matchPrice` ile aranır; kayıt yoksa `costOf` `{usd: 0, basis: 'unpriced'}` döner (usage.js ~864), yani istek 0 dolar yazılır.
- Canlı yapılandırmada Claude API bağdaştırıcıları (`claude-api`, `claude-api-yahoo`, `claude-failover-api`, `claude-api-oai`) model listesini uçtan okur (yapılandırmada `models` alanı yok). `keysmith models` ile adlar: claude-fable-5, -5-1, -5-2, claude-haiku-4-5-20251001, claude-haiku-5-5, claude-opus-4-5-20251101, -4-6, -4-7, -4-8, claude-opus-5, -5-5, claude-sonnet-4-5-20250929, -4-6, claude-sonnet-5, -5-5. Haiku 4.5 ve 12 modelin kaydı yok.
- "saved at list price" (`cacheSavedUsd`, usage.js ~794-805 ve ~2935-2945) kayıt bulunamayınca 0 yazar. `src/batch.js` `estimateUsd` fiyat yoksa gönderimi reddeder (`BATCH_FACTOR = 0.5` sabit; 5 dk / 1 sa yazma farkı batch.js:173'te 2x ile kodlu).
- Fiyat yazan bir komut yok; `src/config-edit.js` `SCHEMA` yalnız sabit anahtarları bilir, `pricing.*` yok. Yedekleme (`backupFile`) ve atomik yazım orada hazır.
- `src/cli.js` `discoverFromPriceTable` (~1623): `new URL(priceUrl)` try bloğunun dışında; http adresi kabul edilir. `discoveryPriceTableUrl` `pricingUrl` ayarını olduğu gibi döner. Aynı adres `src/catalogue.js:23` ile ayara girer.
- `src/source.js` `providerModels` (~70): `--models-url` verilirse anahtar adres ne olursa Bearer olarak gider. Yardım metninde (`cli.js` source satırları) seçenek anlatılmamış.

## Ne değişecek
1. Fiyat: `DEFAULT_PRICING` (usage.js) ve `config.js` varsayılanı, yukarıdaki 15 modelin tamamı için girdi, çıktı, önbellek okuma, önbellek yazma 5 dk ve 1 sa, batch indirimi alanlarıyla genişler. Rakamlar Anthropic'in güncel resmi fiyat sayfasından açılıp alınır; sayfa adresi ve tarih tablonun yanına (kodda ve README tablosunda) yazılır. Elle bellekten rakam yok.
2. Kayıt olmayan model "unpriced" gösterilir: usage çıktısında 0 dolar yerine "unpriced" ve token sayıları; `cacheSavedUsd` için de aynı. `keysmith doctor` kullanılan ama fiyatsız modeli adıyla uyarır.
3. Yeni komut `keysmith price set <adapter/model kalıbı> --input .. --output .. --cache-read .. --cache-write-5m .. --cache-write-1h .. [--batch-factor ..]` (yedek, doğrulama, atomik yazım, mod 0600; `config-edit.js` yardımcıları). Canlı dosyaya bununla yazılır, elle düzenlenmez. Canlı dosya değişimi çalışan geçidin yeniden başlatmasını ister: uygulanmaz, yönetici listesine yazılır.
4. `https` zorunluluğu: `pricingUrl` ve tablo adresi için http reddedilir, açık mesajla; `new URL` hata yakalama içine alınır, bozuk adres mesaj olur, yığın izi çıkmaz.
5. `source enable --models-url`: anahtar yalnız adres https ise ve kaynağın `baseUrl` kökeniyle (şema+ana makine+port) aynıysa gönderilir; değilse anahtarsız istek. Yardım metnine seçenek ve bu kural eklenir.
Dokunulan: usage.js, config.js, batch.js, cli.js, source.js, config-edit.js, README.md, docs/adapters.md, test/ (usage, batch, source, doctor, yeni price testi).

## Kabul kontrolleri
- K1: Verilen Haiku 4.5 isteği olan kullanım satırı var; `keysmith usage --by model` çalıştır. O satır 0 dolar değil, fiyat tablosundaki oranlarla hesaplanmış tutar gösterir ve "saved at list price" 0.00'dan büyük olur (8.617 önbellek okuma tokenı olan satır).
- K2: `keysmith models` ile listelenen 15 Claude modeli için `keysmith price list` (veya usage'ın fiyat sorgusu) her birine girdi, çıktı, okuma, yazma (5 dk, 1 sa) ve batch oranı gösterir; her kayıt yanında sayfa adresi ve tarih görünür.
- K3: Tabloda olmayan bir modelle (test için sahte ad) usage satırı yaz, `keysmith usage` çalıştır: "unpriced" ve token sayıları görünür, 0 dolar görünmez; `keysmith doctor` bu modeli adıyla uyarır.
- K4: `keysmith batch submit` Haiku 4.5 ile artık fiyat hatası vermez, üst sınır tahmini yazar (gönderim için sahibin onayı gerekmez, `--dry-run` yeterli).
- K5: `keysmith price set` ile yeni kayıt ekle: dosyanın tarihli yedeği oluşur, kayıt `pricing` altında görünür; negatif veya sayı olmayan değer reddedilir ve dosya değişmez.
- K6: `discoverFromPriceTable` için `pricingUrl = http://...` ile `keysmith discover <id>`: "https gerekir" mesajı, serbest liste yazılmaz. Bozuk adres (`pricingUrl = "::"`) ile aynı komut: tek satır mesaj, yığın izi yok.
- K7: `keysmith source enable <profil> --models-url http://baska.host/v1/models`: yerel sahte sunucuda `authorization` başlığı gelmez. Aynı kökenli https adresinde (sahte https sunucu) başlık gelir; farklı makine https adresinde gelmez.
- K8: `keysmith source --help` (veya `help source`) `--models-url` seçeneğini ve anahtar kuralını anlatır.

## Riskler
- Para: yanlış rakam yanlış tasarruf ve batch üst sınırı doğurur; bu yüzden rakam resmi sayfadan, tarihle. Sayfa açılamazsa geliştirici durur ve bildirir, tahmin etmez.
- Erişim: anahtar sızdırma yolu kapanıyor; geriye dönük zarar yok. Yan etki: anahtar ister, ama başka kökenli bir adres kullanan eski kullanım anahtarsız çalışır ve 401 alabilir (kasıtlı).
- Mevcut işlev, regresyon: (a) 0 dolar yazılan eski satırlar yeniden hesaplanmaz, geçmiş satırlar değişmez; (b) `*/claude-*-5-5*` kalıpları ve Gemini kaydı aynı kalmalı, kullanıcı kayıtları varsayılanı ezmeye devam etmeli (patternScore); (c) tokenrouter'ın https serbest liste keşfi çalışmaya devam etmeli; (d) `source enable` anahtarsız ve `--model` ile akışı değişmemeli.
- Göç yok; `pricing` biçimi geriye uyumlu (yeni alanlar isteğe bağlı).
- Çalışan geçit eski tabloyla sürer; geçidi durdurmak yok.

## Kararlar
- Kalıp adları tam model adıyla yazılır (`*/claude-haiku-4-5*` gibi), tarih ekli adlar da eşleşir.
- Fiyatsız model: usd `null`, basis `unpriced`; toplamlara 0 olarak değil "hesaplanamayan" olarak girer.
- Batch indirimi kayıt başına `batchFactor` alanı, yoksa mevcut 0.5 varsayılanı.
- Önbellek yazma iki alan: `cacheWrite` (5 dk, mevcut) ve `cacheWrite1h` (yeni); batch.js'teki 2x kısayolu yerine kayıt kullanılır, kayıt yoksa 2x'e düşer.
- Kapsam dışı: tokenrouter 403, kiro-api kredi okuma.

## Sahibe sorular
Yok: tüm kararlar geri alınabilir ve kodda verilir. Not (yönetici için): canlı `pricing` değişimi geçit yeniden başlatılana dek uygulanmaz.

## Boyut
M. Tek alanda (kullanım/fiyat) bir özellik, bir yeni komut, iki küçük düzeltme; tahmini 400-550 satır dahil testler. Risk: para (fiyat) ve erişim (anahtar), bu yüzden gözden geçirici ve yedek gerekir; S değil. Sıra: her madde için önce başarısız test.
