# TEST: keysmith kiro-api env referansları

## İnceleme düzeltmeleri

| Bulgu | Sonuç (geçti/kaldı) | Kanıt |
|---|---|---|
| 1 [büyük] Köprü oturumları `{exec:...}` referansını çözmeden çocuğa veriyordu | geçti | `src/bridge/proc.js` `bridgeEnv` artık `adapter._resolvedEnv()` okuyor (commit 6ad3257). Test: `test/kiro-api-env.test.js` "bridgeEnv resolves a secret reference; an unresolved one fails naming the variable" geçti (dosya 8/8). |
| 1a Çözülemeyen referans değişkenin adını veren hatayla düşer | geçti | Aynı test: `BRIDGE_MISSING` hata iletisinde var, `{exec` ifadesi yok. |
| 1b `proc.js` opencode dalı (46-47) çözülmüş env'den okur | geçti (kod okuma) | `own()` çıplak referans görürse `env?.[k]` (bridgeEnv'den gelen çözülmüş değer) kullanır; bu dal için ayrı test yok. |
| Kapı: `node --test` | geçti (not var) | İzole çalıştırmada bridge-core/clis/agy 79/79 üç kez geçti; ana kapıda tek dosya (bridge/tools) sınır süreli testi makine yükü altında 1-3 kez düştü, izole 116/116 geçti, taban commit'te de aynı dosyalar geçiyor. Tam kapı yükte: 920 test, 893 geçti, 1 kaldı (zamanlama), 26 todo. |

## Kalanlar

- `a client that never comes back: the session closes at toolResultTimeoutMs ...` testi, makinede başka ajanların testleri çalışırken zamanlamaya bağlı olarak kırılıyor (yükte tekrarlandı, izole geçiyor). Bu değişiklikten bağımsız; yüksüz makinede tam kapı yeniden koşulmalı.
- Opencode dalındaki `own()` yolu için doğrudan test yok.
