# 20261117-saglayicilari-ac: Sonuç

## Yapılan
- `--help` / `-h` her alt komutta yardım basar, komutu çalıştırmaz (`add tokenrouter --help` artık adaptör eklemez).
- `keysmith config get|set|unset <anahtar> [değer] [--dry-run]` (src/config-edit.js): bilinen anahtar şeması, tip denetimi, tarihli yedek (`config.json.bak-<zaman>-config`), geçici dosya + rename, 0600, `auth.keys` get'te maskeli.
- `keysmith source enable|disable <profil>` (src/source.js): tokenrouter, groq, mistral, cloudflare. Anahtar yalnız Keychain `{exec:...}` başvurusu; alias dışı (`explicitOnly`); katalogda limit satırı; yedek `-source`.
- `cloudflare` profili (`--account-id`), `SOURCE_FACTS` (belgeli ücretsiz kota, limit = en çok yarısı), katalog alanı `tokensPerDay` (yeniden başlatmada kullanım günlüğünden tohumlanır).
- `discover`: fiyat alanı hiç olmayan kaynakta ve `/models` olmayan uçta (Cloudflare 405) açık uyarı.

## Canlı hazırlık (gateway yeniden başlatılmadı)
- Gerçek config'e dört kaynak eklendi (Keychain: `keysmith:tokenrouter|groq|mistral|cloudflare`); yedekler `config.json.bak-20261117-0206xx-source`; mevcut adaptörler ve aliaslar değişmedi; `catalogue` anahtarı `~/.config/keysmith/catalogue.json` (0600).
- Modeller: groq `llama-3.1-8b-instant`, mistral `mistral-small-latest`, cloudflare `@cf/meta/llama-3.1-8b-instruct`.
- Cloudflare hesap kimliği tünel kimlik dosyasından alındı (token `accounts` okuyamıyor).

## Bulgular
- tokenrouter `/v1/models` fiyat vermiyor (150 model, hiçbirinde `pricing`). `freeOnly` orada bugün her modeli reddeder (güvenli yönde). Ücretsiz bilgisi herkese açık `/api/pricing` içinde (`model_ratio` 0 ve `model_price` 0, ayrıca `:free` son ekleri); `discover` onu okuyacak şekilde genişletilmeli (ayrı iş).
- Groq `/models` artık ücretli fiyat veriyor; ücretsiz olan plan kotası, fiyat 0 değil: freeOnly burada anlamsız, koruma limit + alias dışı + açık model.
- Cloudflare `/ai/v1/models` yok (405).
- tokenrouter limitleri yayımlanmış kota bulunamadığı için temkinli yer tutucu (10/dk, 200/gün, 200k token/gün).

## Yeniden başlatma sonrası kontroller (yönetici)
1. `keysmith status`: "still serves the old config" uyarısı kalkar.
2. `keysmith doctor`: yeni dört adaptör yüklenir (loadErrors'ta yok).
3. Her kaynak için tek küçük istek: `tokenrouter` yalnız ücretsiz modelle (şimdilik 400 beklenir, bulgu 1), `groq/llama-3.1-8b-instant`, `mistral/mistral-small-latest`, `cloudflare/@cf/meta/llama-3.1-8b-instruct` -> 200.
4. `keysmith usage --by adapter`: o adaptörler için satır.
5. Geri alma: `keysmith source disable <ad>` veya yedek dosyası.
