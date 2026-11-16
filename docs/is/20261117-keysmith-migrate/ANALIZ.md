# 20261117-keysmith-migrate: `keysmith migrate manifest|export|import|doctor`

## Bugün ne var
- `src/cli.js` komut anahtarı (`init`, `serve`, `install-service`, `usage` ...) var; `migrate` yok. Taşıma için tek yol elle kopya.
- Taşınacak durum: `~/.config/keysmith/config.json` (`src/config.js`, `$KEYSMITH_CONFIG`; içinde `adapters.*.bin`, `tunnel.configFile`, `{exec:security ... -a <user>}` ve `{json:}/{file:}/{dotenv:}` referansları), `~/.cloudflared/keysmith.yml` (`src/tunnel.js`; kimlik dosyası `<id>.json` ve `cert.pem` ayrı), `<data>/usage.jsonl` + `<data>/account-hmac.key` (`src/usage.js`; anahtar değişirse `exec:<hmac12>` hedefleri bozulur, bu yüzden ikisi birlikte), isteğe bağlı `credit-guard.json` (`src/credit-guard.js`).
- launchd etiketleri `dev.keysmith.gateway` ve `dev.keysmith.tunnel` (`src/service.js`, `install-service`).
- keysmith kodunda Keychain yazma/okuma yardımcısı yok (yalnız config'teki `{exec:}` ile okunur). `migrate-container.js` bu depoda yok; keyflip'te de yok: `src/migrate-stream.js` (v2) var, v3 kabı `20261117-keyflip-migrate-v3` işinde.
- Bağımlılık sıfır (`package.json` dependencies boş); bu korunacak.

## Ne değişecek
1. Bağımlılık kapısı: keyflip v3 inmeden başlanmaz. Sonra `src/migrate-container.js` keyflip'ten bayt bayt kopyalanır; test SHA-256'sını sabitler ve keyflip'in yayımlı v3 vektörlerini (bozuk bayt, kesik, düz metin, N=2^14) vendored kopyaya karşı çalıştırır. Kapsam dışı: kabın kendisini değiştirmek.
2. `migrate/manifest.json` (genel, şema 1): config (secret, home+user yeniden yazılır), `~/.cloudflared/<tunnel>.yml` (home), grup `usage` (usage.jsonl + account-hmac.key birlikte), isteğe bağlı credit-guard.json; atla: `*.bak-*`, `workspaces/`, log, pid, `run/`. Keychain: `keysmith:*`, `kiro-api:*`, hariç `kiro-api-hold:*` (tam önek, iki nokta dahil; exclude kazanır). launchd etiketleri + `keysmith install-service`. Dış referanslar listelenir, taşınmaz. Giriş listesi: `cloudflared tunnel login`, tünel taşı-ya-da-yeni seçimi.
3. Yeni `src/migrate.js` (+ varsa `src/migrate-keychain.js`): `manifest [--json]`, `export <out> --passphrase-file <path|-|/dev/fd/N> [--bundle-id] [--dry-run]`, `import <in> ... [--expect-bundle-id] [--dry-run] [--force <ad>...] [--from-home --from-user] [--keychain]`, `doctor [--json]`. `src/cli.js` içine yönlendirme.
4. Kurallar (DESIGN 1.1-1.3): her zaman şifreli (parolasız ret); dry-run yalnız adlar/boyut/var-yok/uzunluk; birleştir, ezme; dokunulan dosyalar `<data>/migrate-backups/<ts>/` (0700) içine yedek; `--force` Keychain'de `<ad>.pre-migrate-<ts>` kopyası; Keychain yazımı yalnız stdin (`security -i`, kısa tek satırlık değer; uymayan değer "elle yeniden gir" listesine); yeniden yazım kayıtlı `fromHome/fromUser` ile, olmayan `bin` yolu `command -v` önerisiyle raporlanır; launchd'yi import yüklemez, çalışan gateway'e dokunmaz. Çıkış kodları 0/2/3/4/5; hata metni dosya içeriği alıntılamaz.
5. Testler `test/migrate.test.js` (geçici HOME, geçici keychain dosyası, uydurma adlar). Dokümanlar: README bölümü, CHANGELOG. Public depo: sahip adı, özel yol, host, anahtar adı yok.

## Kabul kontrolleri
- K1: Given boş HOME B ve geçici keychain, when A'dan `migrate export` sonra B'ye `migrate import`, then dosyalar yeniden yazımdan sonra bayt-eşit, Keychain değerleri eşit (testte karşılaştırılır), `adapters.*.bin`/`tunnel.configFile`/`-a <user>` B'yi gösterir; ikinci import hiçbir şeyi değiştirmez. Gözlem: `node --test test/migrate.test.js`.
- K2: Given A'da `kiro-api-hold:x` ve deny-list'te `Foo Safe Storage` öğesi, when export/`--dry-run`, then ikisi de plan çıktısında, paket çözümünde ve B'de yok; `kiro-api:*` varsa taşınır (`security find-generic-password` ile B keychain'inde bak).
- K3: Given yanlış parola, bir bayt çevrilmiş kayıt, kesik dosya, yanlış `--expect-bundle-id`, düz metin paket, when import, then her biri çıkış 3 ve hedef (dosyalar+keychain) öncekiyle aynı (`diff -r`, `security dump-keychain` adları).
- K4: Given B'de farklı değerli öğe, when `import --dry-run`, then çıkış 4 ve "exists, kept"; when import, then korunur; when `--force <ad>`, then değiştirilir ve `<ad>.pre-migrate-<ts>` var; dosya yedeği `<data>/migrate-backups/<ts>/` altında.
- K5: Given `--passphrase-file` yok, when export, then ret (çıkış 2) ve dosya yazılmaz; `-` ve `/dev/fd/3` ile parola kabul edilir.
- K6: Given `migrate doctor`, when sahip olunan öğe ya da dış referans (`{json:}`/`{file:}`/`{dotenv:}`/`{exec:}`) çözülmüyorsa, then satır `missing` (yalnız ad/uzunluk, değer yok) ve çıkış 1; hepsi tamamsa çıkış 0.
- K7: Given sahte `CANARY-<uuid>` sırlar, when export/import/dry-run/doctor koşar, then stdout, stderr, log, `ps -axo args` örnekleri ve paket baytlarında canary (düz, base64, hex) sıfır isabet.
- K8: Given `sha256(src/migrate-container.js)`, when test koşar, then keyflip'in sabit değerine eşit ve v3 vektörleri geçer; `package.json` dependencies hâlâ boş.
- K9: Given çalışan gateway, when import biter, then süreç PID'i değişmemiş, `launchctl list` farkı yok; çıktıda `keysmith install-service` satırı basılır.
- Gözlem K10 (regresyon): `node --test` tüm paket yeşil; `grep -rn` ile depoda sahip adı/özel yol yok.

## Riskler
- Kişisel veri/erişim: pakette tüm API anahtarları; parola tek koruma. Hold anahtarı sızarsa sahibin ayırdığı sır taşınır: önek eşlemesi tam (iki nokta) ve exclude önce.
- Sızıntı: argv/env/log/hata metni; Keychain'e argv ile yazmak yasak.
- Veri kaybı: import mevcut config ya da anahtarı ezebilir: birleştir + yedek + `.pre-migrate`.
- Bozuk yeniden yazım: yanlış `-a <user>` ya da home sonrası çalışmayan gateway; doctor yakalar.
- usage.jsonl ile hmac anahtarı ayrılırsa hesap hedefleri bozulur: grup zorunlu.
- Regresyon: `keysmith usage`, `install-service`, `serve` aynen çalışmalı (K9, K10). Aynı tünel iki Mac'te açık olursa çakışma: giriş listesinde uyarı.
- Bağımlılık: keyflip kabı gelmeden başlanırsa vendor bayt-eşitliği tutmaz.

## Kararlar
- Kap keyflip'ten kopyalanır, keysmith'te değiştirilmez; kendi şifreleme yazılmaz.
- Yalnız yerel keychain dosyası testte; `--keychain`/`MIGRATE_KEYCHAIN` ile.
- Uzun/çok satırlı Keychain değeri yazılmaz, "elle yeniden gir" listesine gider (DESIGN 1.2); keyflip'in `kfkc` yardımcısı keysmith'e alınmaz (sıfır bağımlılık).
- Tünel `<id>.json` ve `cert.pem` pakete girmez; giriş listesinde "tüneli taşı ya da yeni kur" olarak çıkar (karar sahibin, DESIGN 7.7).
- Dış referanslar taşınmaz, yalnız doctor raporlar.
- Dilimler: (a) kap + manifest + export, (b) import + yedek/force + Keychain, (c) doctor + canary testleri; tek geliştirici sırayla, aynı branch.

## Sahibe sorular
- Yok: karar gerektiren her şey (hold hariç tutma, tünel) DESIGN.md'de zaten karara bağlı. Tünel kimliği taşıma (7.7) cut-over'da sorulur; bu iş yalnız iki yolu da destekler.

## Boyut
L: yeni alan (migrate), tahmini 900-1300 satır kod + test, üç dilim. Risk: `touches` kişisel veri, erişim, migrasyon (yedek zorunlu; gözden geçiren gerekli). Sıra bağımlılığı: keyflip `20261117-keyflip-migrate-v3` önce iner.
