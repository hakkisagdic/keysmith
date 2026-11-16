# İnceleme: 20261117-keysmith-kiro-api-env-refs

**Karar: GEÇMEZ (1 büyük, 5 küçük).** Kiro API yolu (`kiro-api`, toolMode off) doğru çalışıyor ve anahtar sızmıyor. Ancak `env` referansları MCP bridge ile başlatılan alt süreçlerde çözülmüyor. Belge ise "her spawn'da" çözüldüğünü söylüyor.

İnceleyen: Denetçi (claude-opus-5-5). Dal: `is/20261117-keysmith-kiro-api-env-refs` (c746399), `origin/main` ile karşılaştırıldı.

## Kabul kontrolleri (diff okunmadan önce yazıldı)

1. CLI adaptörünün `env` içindeki gizli referanslar her alt süreç başlatılırken çözülüyor mu? Bu, credit guard'ın `/usage` çalıştırmasını da kapsamalı. Çözülemeyen referans, değeri değil değişken adını veren bir hatayla düşmeli. Literal değerler değişmemeli. **Kısmen:** istek, sürüm/model yoklaması ve `/usage` yolları tamam. MCP bridge yolu eksik (bulgu 1).
2. Çözülen değer log, `/status`, `/routes`, hata metni, kullanım kaydı ve kaydedilen yapılandırma çıktısına ulaşmamalı. **Evet** HTTP yüzeyinde ve logda test edildi. `keysmith get/set/status` CLI çıktısı test edilmedi (bulgu 5).
3. Belgede tarif olmalı. Adaptör kapalı kalmalı ve hiçbir alias, tier ya da route'a girmemeli. Testler ve lint geçmeli. **Evet.** Kapalı adaptör yönlendirilmiyor (test). Credit guard ve sürüm yoklaması kapalı adaptörü atlıyor. Projede lint betiği yok.

## Mercekler

1. Veri güvenliği: Migrasyon yok. `~/.config/keysmith/config.json` dosyasına dokunulmuyor. `this.env` yazıldığı gibi kalıyor. Sorun yok.
2. Erişim: Yeni uç nokta yok. Kapalı adaptör 503 dönüyor ve `/v1/models`'ta görünmüyor. Anahtar kapsamı örneği (`--allow`/`--deny kiro-api`) mevcut desen kurallarına uyuyor.
3. Para ve kişisel veri: Credit guard okumayı `env`'in yazıldığı biçimine göre ayrı tutuyor, yani `kiro-api` kendi planıyla korunuyor. Çözülen değer redactor'a kaydediliyor.
4. Dürüstlük: Testler gerçekten kontrol ediyor; stub, anahtarı `ENV_OK`/`ENV_BAD` ile ve `/usage` için 100/9999 ile doğruluyor. İki eksik var: belgedeki "her spawn" iddiası bridge için doğru değil, ve TEST.md yok (bulgu 6).
5. Sırlar: Kodda, testte veya belgede sır yok. Test, rastgele adlı geçici bir Keychain öğesi kullanıyor. Çalıştırmadan sonra `keysmith-test-` öğesi kalmadığını doğruladım (0 sonuç).

Ölçtüklerim: `node --test test/kiro-api-env.test.js` sonucu 7/7 geçti. Tüm paket iki kez çalıştı. İkinci çalıştırma: 919 test, 893 geçti, 26 todo, 0 hata. İlk çalıştırmada `test/wire-conformance.test.js` içinde (`cxfail/m`) bir hata çıktı ve tekrarda geçti. Bu test diff ile ilgisiz görünüyor ve kararsız (flaky).

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| büyük | `src/bridge/proc.js:128-131` (ayrıca `:46-47`, `bridgeEnv` çağıranlar: `src/bridge/clis.js:65,200,256,274,320`, `src/bridge/agy.js:165`) | MCP bridge oturumları (agy/opencode/codex/qoder/claude, toolMode auto/mcp) alt süreç ortamını `adapter.env`'den olduğu gibi kuruyor. Bu yüzden `{exec:…}` referansı çocuğa literal metin olarak geçiyor. Kimlik bilgisi sessizce yanlış oluyor ve hata adı veren bir mesaj çıkmıyor. `docs/adapters.md:170` ise "each time a child is spawned" diyor. İstek "every spawn" istemişti. `kiro-api` etkilenmiyor çünkü kiro için bridge sürücüsü yok. | `bridgeEnv` içinde `...(adapter.env \|\| {})` yerine `...(typeof adapter._resolvedEnv === 'function' ? adapter._resolvedEnv() : adapter.env \|\| {})` kullanılmalı. `proc.js:46-47` aynı çözülmüş ortamdan okumalı. Bir test eklenmeli: `bridgeEnv` referansı çözsün, çözülemeyen referans değişken adını veren hatayla düşsün. |
| küçük | `src/cli-adapter.js:689` | `/^\{\w+:[\s\S]*\}$/` desenine uyan her değer referans sayılıyor. Bilinmeyen bir tür (ör. `{foo:bar}`) `resolveSecret` içinde hata atıyor, hata yutuluyor ve sonuç "did not resolve" oluyor. Önceden literal olarak geçen böyle bir değer artık çalıştırmayı düşürüyor. | Deseni yalnız beş türle sınırlayın: `/^\{(exec\|env\|file\|dotenv\|json):[\s\S]*\}$/`. Diğer değerler literal kalsın. |
| küçük | `src/cli-adapter.js:695` (`src/config.js:92`) | `{exec:}` her spawn'da `spawnSync` ile ve 10 sn zaman aşımıyla çalışıyor. Bu, her istekte, yoklamada ve 10 dakikada bir `/usage`'da oluyor. Gateway'in olay döngüsü bu sürede donuyor. Keychain erişim istemi çıkarsa her istek 10 sn'ye kadar tüm akışları durdurabilir. | Çözülen değer, referans anahtarıyla kısa ömürlü bir bellek önbelleğinde tutulsun (yalnız bellekte, redactor'a kayıtlı) ya da asenkron `execFile` ile çözülsün. Belgeye şu not eklensin: Keychain öğesinin ACL'si `security` için "Her Zaman İzin Ver" olmalı. |
| küçük | `docs/adapters.md:639-644` | Tarifteki adımlar `keysmith add kiro --as kiro-api` ile başlıyor. Bu komut girdiyi açık (enabled) oluşturuyor, çünkü kiro profilinde `disabled` yok. Adımlarda `disabled true` yok, oysa JSON örneğinde var. `env` ayarlanmadan bir yeniden başlatma olursa adaptör varsayılan Kiro girişiyle hizmet verir ve yanlış hesabın kredisi harcanır. | `add`'den hemen sonra ilk adım olarak `keysmith set kiro-api disabled true` yazılsın, ardından `env` ve `cwd` ayarlansın. |
| küçük | `test/kiro-api-env.test.js:150-155` | İstekte istenen `keysmith status/set/get` CLI çıktısı test edilmiyor. "saved config" kontrolü totolojik: test `cfg`'yi kendisi yazıp kendisi okuyor. | Geçici bir yapılandırma dosyasıyla `src/cli.js get kiro-file`, `set kiro-file env …` ve `status` çalıştırılsın. Çıktıda ve kaydedilen dosyada SECRET aranıp bulunmadığı doğrulansın. |
| küçük | `docs/is/20261117-keysmith-kiro-api-env-refs/` | TEST.md yok. Kanıt yalnız commit mesajında ("919 tests, 0 fail") ve kararsız `wire-conformance` testinden söz edilmiyor. | TEST.md'ye komutlar ve sayılar (919 / 893 geçti / 26 todo) yazılsın. Kararsız test ayrı bir iş olarak kaydedilsin. |
