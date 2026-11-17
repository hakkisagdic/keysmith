# İNCELEME: 20261117-acilis-eksikleri

**Karar: GEÇMEZ (1 büyük bulgu).** Kod tarafı (şema, ücretsiz liste kuralı, varsayılan model, SIGHUP ile promptCache) doğru ve muhafazakâr. Engel, bir test dosyası: halka açık depoya özel bir sunucu adresi yazıyor ve dal zaten uzak depoya gönderilmiş.

İncelenen: `git diff origin/main...is/20261117-acilis-eksikleri` içindeki 13 dosyanın tamamı, ANALIZ.md, TEST.md. PLAN.md bu işte yok. tokenrouter'ın herkese açık fiyat tablosu anahtarsız okundu: biçim koddaki varsayımla uyuşuyor (`tiered_pricing` bir nesne, dört koşulu da karşılayan 2 model var).

## Mercekler

1. **Veri güvenliği:** Göç yok. `writeDiscovered` geçici dosyaya 600 izinle yazıp rename ile değiştiriyor. Fiyat tablosu okunamazsa liste boşalıyor, yani güvenli yöne düşüyor. Config yazımları mevcut yedekli yoldan geçiyor. Sorun yok.
2. **Erişim:** Yeni uç nokta yok. SIGHUP yalnız `promptCache`'i değiştiriyor ve doğrulanamayan değerde eskisini koruyor. Anahtar yeniden yükleme yolu değişmedi. Sorun yok.
3. **Para / kişisel veri:** Ücretsiz sayılmak için dört koşulun hepsi gerekiyor; alan eksikse ya da değer metinse model reddediliyor. Freeonly koruması her istekte diskteki listeyi okuyor. Açık kalan iki küçük konu var: `pricingUrl` http adres kabul ediyor, `--models-url` ise anahtarı başka bir adrese gönderebiliyor (aşağıda).
4. **Dürüstlük:** TEST.md K7–K10'u ve canlı K11'i doğru biçimde "yürütülmedi" diye yazıyor. Ama K11'in "halka açık depoda özel veri yok" satırı yanlış "geçti" diyor: test kendi dosyasını taramanın dışında tutuyor ve özel veri tam o dosyada.
5. **Sırlar:** Anahtar değeri basılmıyor ve loglanmıyor. Ancak test dosyasına özel bir sunucu adresi ve sahibin kullanıcı adı yazılmış (büyük bulgu).

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| büyük | test/acilis-eksikleri-tester.test.js:194 (ve :190) | K11 tarama deseninde üretim sunucusunun IP adresi ve `kiro-api:` ile sahibin kullanıcı adı açık metin olarak duruyor. Depo PUBLIC; bu dosyayı içeren f50a61e commit'i `origin/is/20261117-acilis-eksikleri` ile GitHub'a gönderilmiş. Test kendi dosyasını taramadan çıkardığı için K11 bunu yakalamadan "geçti" dedi. | Desendeki özel değerleri kaldırın. Yasak listeyi depo dışından okuyun (ör. `KEYSMITH_PRIVATE_PATTERNS` ortam değişkeni ya da izlenmeyen bir dosya; yoksa yalnız genel desenler çalışsın) ve kendi dosyasını dışarıda bırakan filtreyi silin. İnişte dal squash edilsin, f50a61e ana dalın tarihine girmesin. Uzaktaki `is/20261117-acilis-eksikleri` dalını releaser silsin ya da zorla güncellesin; durumu sahibe bildirin, çünkü GitHub önbelleğinde kopya kalabilir. TEST.md'deki K11 satırı yeniden koşulduktan sonra güncellensin. |
| küçük | src/source.js:72, :136 | `--models-url` verildiğinde Keychain anahtarı o adrese Bearer olarak gidiyor, http adres de olabilir. Bayrak yardımda geçmiyor. | Anahtarı yalnız override adresi https ise ve origin'i `entry.baseUrl` ile aynıysa gönderin; aksi halde isteği anahtarsız yapın. Bayrağı yardıma ekleyin ya da yalnız teste açık tutun. |
| küçük | src/cli.js:1611, :1624; src/config-edit.js:39 | `discovery.<id>.pricingUrl` http adres kabul ediyor. Araya giren biri ücretsiz listeyi şişirirse ücretli modeller açılır (para). Ayrıca `new URL(priceUrl)` try bloğunun dışında; geçersiz adres yığın iziyle düşüyor. | Şemada ve `discoveryPriceTableUrl` içinde yalnız `https:` kabul edin. `new URL` çağrısını try içine alın ve hatada listeyi boşaltın. |
| küçük | src/config-edit.js:50 | `knownKeys()` yeni `discovery.<adapter>.pricingUrl` anahtarını listelemiyor; bilinmeyen anahtar mesajında görünmüyor. | Listeye `'discovery.<adapter>.pricingUrl'` ekleyin. |
| küçük | src/profiles.js:996 | Mistral notu "left out" diyor ama `source enable mistral` adaptörü yine yazıyor; not ile davranış çelişiyor. | Ya enable'ı `--force` olmadan reddedin ya da notu "ücretsiz oran yok (429); eklemek ücretli olabilir" diye yazın. |
| küçük | test/acilis-eksikleri-tester.test.js:189 | `git diff main` yerel `main`'e bakıyor; yerel main geride kalırsa değişen dosyalar taramaya girmiyor. | `git diff origin/main --name-only` kullanın. |
| küçük | TEST.md "Kalanlar" 1 | K7–K10 ve canlı rota/allow karşılaştırması yapılmadı. Bunlar yapılmadan iş bitmiş sayılmamalı. | İnişten sonra operatör adımları (a–f) ve K7–K10 koşulsun. K9 ve K10 para harcıyor; ölçülen değerler TEST.md'ye eklensin, iş ancak ondan sonra kapansın. |
