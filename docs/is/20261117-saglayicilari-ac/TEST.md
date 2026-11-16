# 20261117-saglayicilari-ac: Test

Mod: function. Dal `is/20261117-saglayicilari-ac`, yerelde çalıştırıldı (canlı adres kanıt sayılmadı). Testler: `test/qa-saglayicilari.test.js` (bağımsız, kara kutu; gerçek CLI, gerçek geçici Keychain kaydı, ayrı portta alt süreç gateway).

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 her alt komut `--help`/`-h`, `add tokenrouter --help` dahil | geçti | `qa-saglayicilari.test.js` K1: 31 komut x 2 bayrak, çıkış 0, her seferinde config sha256 aynı, adaptör eklenmedi, klasörde ek dosya yok |
| K2 `config set --dry-run` yazmaz; gerçek yazım get=true, yedek, 0600 | geçti | K2: dry-run sonrası sha aynı ve yedek yok; sonra `config get` true, 1 `.bak-*` (0600), config 0600 |
| K3 bilinmeyen anahtar, tip hatası | geçti | K3: `bilinmeyen.anahtar` ret + bilinen liste (discovery.enabled, port); `port abc` ve `port 99999` ret; `adapters.*` config ile reddedildi; sha aynı |
| K4 `source enable tokenrouter --key-ref` | geçti | K4/K5/K6 testi, gerçek geçici Keychain kaydı: apiKey `{exec:...security...}` ve başvuru gerçekten çözülüyor, düz değer yok; freeOnly true; discovery.enabled true; aliaslarda yok; katalogda limit satırı; çıktı "restart" diyor; kayıt test sonunda silindi |
| K5 olmayan servis reddi | geçti | aynı test: ret, config sha aynı, yanına dosya yazılmadı |
| K6 `source disable` | geçti | aynı test: adaptör ve katalog satırı gitti, `keep` adaptörü ve aliaslar özdeş |
| K7 sahte upstream, ikinci portta örnek | geçti | K7 testi: `discover` "1 free model" ve diskteki liste yalnız `free/a`; ücretli model 400 ve upstream'e POST gitmedi; ücretsiz 200; anahtarsız 401; `usage --by adapter` satırında tokenrouter; alt süreç kendi PID'iyle SIGTERM, çıktıda anahtar yok |
| K8 canlı dosyada dört kaynak | geçti | `keysmith doctor` (salt okuma): tokenrouter, groq, mistral, cloudflare `ok`, explicit-only; canlı config'te dördü exec başvurulu, hiçbiri aliasta değil; çalışan gateway (pid 36453) hâlâ eski, `status`/`doctor` farkı adlarla gösterdi; branş diff'inde gitleaks temiz (`HEAD~2..HEAD`), özel yol/e-posta/anahtar yok. Not: `google` yüklenme hatası bu işten önce de var |
| K9 yeniden başlatma sonrası discover, tek istek, usage | yürütülmedi | Gateway yeniden başlatılmadı (kural); yönetici sonrası SONUC.md maddeleri |
| Gerileme: `set/add/enable/disable` | geçti | `cli-settings.test.js` tam kapıda geçti |
| Gerileme: catalogue*.test.js, discover.test.js | geçti | 38 test, fail 0 (bu dosyalar + config-edit/source/help-safe) |
| Gerileme: tam kapı | geçti | `node --test`: 934 test, 908 geçti, fail 0, cancelled 0, 26 todo (`wire-conformance` bilinen uyarılar) |
| Gerileme: komutsuz `keysmith --help` | geçti | 64 satır, yeni `config` ve `source` girdileri var |

## Kalanlar
- K9 yürütülmedi: gateway yeniden başlatılana kadar canlı çağrı ve `usage` satırı görülemez (kasıtlı). Beklenen: dört kaynakta discover>0 (groq/mistral/cloudflare için model listesi kuralı), tek küçük istek 200.
- Gözlem (hata değil): tüm geçmişte gitleaks 11 eski bulgu veriyor, bu dalın commit'lerinde yok. `tokenrouter` `/models` fiyat vermediği için SONUC.md'deki bulguya göre freeOnly şimdilik her modeli reddeder (güvenli yön).
- Gözlem: `-h/--help` testi her çağrıda ~1 sn sürdüğü için K1 testi ~70 sn.
