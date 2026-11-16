# SONUC: 20261116-keysmith-fuel

- Karar: done (yerelde main'e indi; push ve canlı yeniden başlatma sahibin)
- Sha: bu dosyayı içeren iniş commit'i (main'in ucu)
- Kapsam: katalog (`catalogue`) tabanlı yerel limitler + cooldown, tokenrouter ve mistral profilleri, freeOnly, `discover tokenrouter`, `usage record`, README/adapters/CHANGELOG.
- Kapı: node --test 911 test, 0 kalan; gitleaks temiz; özel yol/e-posta yok.
- Canlı kontrol: dev.keysmith.gateway yeniden BAŞLATILMADI (kapsam dışı). 8788 ikinci örnekte evren, claude-api-oai, claude-failover eskisi gibi; kiro kredi koruması nedeniyle 429 (mevcut davranış).
- K4: ana checkout'tan `usage record` ayrı veri dizininde çalıştı; gerçek veri dizinine yazılmadı.
- Açık: canlı yeniden başlatma (sahibin saati ve 13 Kasım config onayı); main push; uzak dalların silinmesi (push sahibin).
- Açık: requestsPerDay/tokensPerMonth yalnız birim testte; kiro gerçek 200 yanıtı alınamadı.
- Geri alma: `git revert <iniş sha>`; yedek gerekmedi (migrasyon yok).
- Ders: kapıdaki 26 todo wire-conformance boşluğu önceden biliniyor; yeşil sayılırken "fail 0" birincil ölçüt alınmalı.
