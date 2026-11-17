# 20261117-acilis-eksikleri: Dünkü özellikleri açmayı engelleyen dört eksik ve canlı yapılandırma hazırlığı

## Bugün ne var
- `src/config-edit.js` `SCHEMA` (satır 21-36) yalnız `catalogue` ve `discovery.*` bilir; `batch.enabled` yok. Kodda batch için tek ayar `batch.enabled` (`src/batch.js:37`); başka batch ayarı yok, "diğer ayarlar" diye bir şey bulunmadı.
- tokenrouter: `src/profiles.js` `SOURCE_FACTS.tokenrouter` `freeOnly:true`, fiyat yolu `pricing.prompt/completion`. `/v1/models` fiyat vermiyor, ücretsiz liste boş, her model reddedilir. Herkese açık `https://api.tokenrouter.com/api/pricing` anahtarsız cevap verdi (canlı okundu): 150 model; `model_price` 0 olan 138, `model_ratio` 0 olan 14, ikisi birden 0 olan yalnız 2; `quota_type` 0 olmayan 12; ayrıca `tiered_pricing` alanı var. Yani tek alana bakmak yanlış sonuç verir.
- Profiller (`src/profiles.js` ~904-909, `src/source.js`): Groq varsayılanı emekli (404), Cloudflare'inki kullanımdan kalkmış (410); `source enable` varsayılanı profilden alıyor, sağlayıcının listesine bakmıyor. Mistral anahtarla 429 veriyor.
- `promptCache` `src/http-adapter.js:99` yapıcıda okunur. SIGHUP yalnız `auth.keys` yeniler (`src/server.js:104-160`, `reloadKeys`); adaptör nesneleri yerinde kalır.
- Canlı: Kiro API anahtarı Keychain'de `kiro-api:<kullanıcı>` adıyla VAR (-w olmadan doğrulandı, değer okunmadı). cli adaptör `env` içindeki `{exec:...}` referansları spawn anında çözülüyor (`src/cli-adapter.js:681`).

## Ne değişecek
Kod (public repo; özel yol, adres, anahtar yok), her madde önce başarısız test:
1. `src/config-edit.js`: `batch.enabled` (bool) şemaya; set/oku/unset testi. Başka batch anahtarı eklenmez (kodda yok), kararlara yazılır.
2. `src/discover.js` + `src/profiles.js`: tokenrouter için `/api/pricing` okunur. Ücretsiz kuralı (muhafazakâr): `quota_type===0` VE `model_price===0` VE `model_ratio===0` VE `tiered_pricing`'te girişi yok; tamamlama oranı da 0 ya da model_ratio 0 olduğundan sıfır maliyet. Eksik/okunamayan alan = ücretsiz değil. Katalogta liste ile birlikte kaynak adresi (yalnız alan adı/host, anahtarsız) ve zaman damgası yazılır. Her discover listeyi baştan kurar: dün ücretsiz, bugün ücretli model listeden düşer. Pricing erişilemezse eski liste korunmaz, liste boşalır (güvenli yön).
3. `src/source.js` + `src/profiles.js`: `source enable` sağlayıcının `/models` listesini okur; profilin varsayılanı listede yoksa kural: sohbet modeli, `embed/whisper/tts/guard/image/vision` vb. değil, ad içinde küçük boyut işareti (8b, 20b, mini, flash, lite, nano, small) olan, listede sürüm olarak en yeni; ölçüt yoksa listenin ilki. `--model` her zaman önce gelir. Listede yoksa açık mesaj (ne istendi, ne bulundu). Mistral profili notu: "ücretsiz oran yok (429), dışarıda bırakıldı".
4. `src/server.js` / `src/gateway.js`: SIGHUP yeniden okumasında mevcut HTTP adaptörlerin `promptCache` değeri (checkPromptCache ile doğrulanarak) yerinde güncellenir; başka hiçbir adaptör alanı değişmez, geçersiz değer eskisini korur ve log yazar. Güvenli değilse (adaptör kümesi yarışı) nedeni yazılıp bırakılır; tahmin: güvenli, tek alan atama.

Canlı yapılandırma (gateway'e dokunmadan, yalnız keysmith komutlarıyla; her biri yedek üretir, dosya adları sonuca yazılır; operatör yapar, analist değil):
a. `keysmith set claude-api promptCache '{"mode":"on","ttl":"5m"}'` (yalnız claude-api).
b. `keysmith source enable groq|cloudflare` yeni mantıkla; Cloudflare account id `config.json.bak-20261117-054729-source` içindeki baseUrl'den.
c. `keysmith config set batch.enabled true`.
d. `keysmith add kiro --as kiro-api`; `env.KIRO_API_KEY` = `{exec:security find-generic-password -s kiro-api:<kullanıcı> -w}`; `disabled` kapalı olmalı ama hiçbir alias zincirinde yok, `explicitOnly`; kredi koruması muhafazakâr (eşik 1.0, mevcut tavan 1.25 değil). `kiro-api-hold` öğesine dokunulmaz.
e. `keysmith key add fuel-test --allow tokenrouter,groq,cloudflare,kiro-api --per-day <küçük>`; çıktı 600 izinli dosyaya (`~/.config/keysmith/fuel-test.key`, ekrana basılmaz). Mevcut anahtarların allow listeleri ve alias zincirleri değişmez.
f. `keysmith doctor` + canlı gateway ile dosya farkı (yalnız adlar).

## Kabul kontrolleri
- K1 Verilen: boş config. Ne zaman: `keysmith config set batch.enabled true`, `config get`, `config set batch.enabled maybe`, `--unset`. Sonra: true yazılır/okunur, "maybe" bool hatasıyla reddedilir, unset anahtarı siler; `keysmith batch status` "off" yerine açık der. Test: `test/config-edit.test.js`.
- K2 Verilen: pricing cevabı taklit eden test sunucusu (2 ücretsiz, 1 ücretli, 1 `quota_type` 1, 1 tiered). Ne zaman: `keysmith discover tokenrouter`. Sonra: katalogta yalnız 2 ücretsiz model, kaynak ve zaman damgası yazılı; ücretli/tiered/eksik alanlı modele `keysmith chat tokenrouter/<m>` guard ile reddedilir. Canlıda: `keysmith discover` sonrası ücretsiz sayı >0 ve `nvidia/...:free` modeli listede.
- K3 Verilen: önceki discover'da ücretsiz olan model. Ne zaman: pricing'de fiyatı değişir ve discover yeniden koşar. Sonra: model listeden düşer, istek reddedilir (test).
- K4 Verilen: profil varsayılanı sağlayıcı listesinde yok (test sunucusu). Ne zaman: `keysmith source enable groq --key-ref X`. Sonra: yazılan config'te listeden, kurala göre seçilmiş model; `--model Y` verilirse Y; Y listede yoksa açık hata, config yazılmaz.
- K5 Verilen: Mistral profili. Ne zaman: `keysmith source enable mistral`. Sonra: not "429, ücretsiz oran yok, dışarıda" der; `keysmith source list` bunu gösterir.
- K6 Verilen: çalışan test gateway'i (başka port, kendi PID'i), claude-api adaptörü promptCache kapalı. Ne zaman: config'te `promptCache` `{"mode":"on"}` yapılır, SIGHUP. Sonra: sonraki istek gövdesinde `cache_control` var; kapatınca yok; adaptörün başka alanları (baseUrl, modeller) aynı; geçersiz değerde eski değer kalır.
- K7 Verilen: canlı config. Ne zaman: `keysmith doctor`. Sonra: tüm yeni adaptörler ok; `grep` ile config'te tokenrouter/groq/cloudflare/kiro-api, `batch.enabled:true`, claude-api `promptCache`; `fuel-test.key` mod 600 (`stat -f %Lp`).
- K8 Verilen: fuel-test anahtarı. Ne zaman: restart sonrası tokenrouter(ücretsiz model), groq, cloudflare, kiro-api'ye birer küçük istek (max_tokens 16). Sonra: her biri 200 ve `keysmith usage --by adapter` her adaptör için bir satır; fuel-test ile `claude-api` isteği 403.
- K9 Verilen: reviewer anahtarı. Ne zaman: claude-api'ye, ~6.000 tokenlik sabit system önekiyle iki aynı istek. Sonra: ikinci satırda cache read > 0 (`usage --by adapter`).
- K10 Verilen: batch açık. Ne zaman: claude-api Haiku 4.5, tek satırlık jsonl, `--cap-usd 0.10`. Sonra: tahmin <= 0.10, iş biter, `batch results` toplamı yazar, `usage` satırında `batch: true`.
- K11 Regresyon: mevcut anahtarlar ve alias zincirleri aynı (restart öncesi ve sonrası allow listeleri karşılaştırılır; venizelos/reviewer rota tablosu: aynı HTTP kodları); halka açık depoda özel yol/adres/anahtar yok (repo tarama testi).

## Riskler
- Para: ücretsiz listesi yanlış büyürse ücretli model harcama yapar; kural muhafazakâr, alan eksikse reddet. Kiro kredi koruması: `/usage` API anahtarıyla cevap verir mi sınanmamış (cevap yoksa koruma yok); kota tavanı dışarıda kalır, fuel-test günlük sınırı bunu sınırlar.
- Erişim: yeni anahtar yalnız yeni kaynaklara; yanlış allow mevcut kaynakları açar. Mevcut allow listeleri değişmez, K11 karşılaştırır. Anahtar dosyası 600, değer asla basılmaz/loglanmaz.
- Kiro anahtar referansı: değer yalnız spawn'da çözülür, loga/usage'a girmemeli (test).
- SIGHUP'ta yarım güncelleme: yalnız `promptCache` atanır, doğrulama başarısızsa eski değer.
- Config yazımları canlı dosyaya; her komut yedek yapar, geri dönüş: `config.json.bak-20261117-0545-prerestart`.
- Kırılabilecek mevcut özellik: caller-key reload (`reloadKeys`) ve `source enable` varsayılan akışı (regresyon testleri çalışmalı).
- Halka açık depo: testlerde sahte sunucu ve sahte host kullanılacak.

## Kararlar
- Batch için yalnız `batch.enabled`; başka anahtar uydurulmaz.
- Ücretsiz = dört koşulun hepsi; "free" son eki tek başına yetmez. Liste her discover'da baştan.
- Varsayılan model kuralı yukarıdaki; sağlayıcı listesi alınamazsa enable hata verir, tahmin yürütmez.
- SIGHUP yalnız `promptCache`'i yeniler; adaptör yeniden kurulmaz.
- Kiro API adaptörü hiçbir alias'ta yok, `explicitOnly`; eşik 1.0.
- Canlıda gateway durdurulmaz/yeniden başlatılmaz; fark listesi yalnız adlarla.
- Tek inceleme, sonda (harcama korumaları ve anahtarlar). Tam test için önce `heavy_slot.sh acquire`; zaman aşımı tekrar edilmez.

## Sahibe sorular
- Yok. Anahtar adı ve Keychain öğesi verilmiş ve mevcut; kalan her şey geri alınabilir yapılandırma. (Varsayılan günlük sınır fuel-test için 20 istek; geri alınabilir.)

## Boyut
L: dört ayrı kod dilimi (şema, discover, source, sunucu reload) ve canlı yapılandırma hazırlığı; tahmini 600+ satır test dahil. Risk: para ve erişim (`touches`: money, access); göç ve kişisel veri yok.
