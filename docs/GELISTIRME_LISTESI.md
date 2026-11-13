# Keysmith — Geliştirme Listesi (Backlog & Yol Haritası)

**Tarih:** 13 Kasım 2026  
**Kaynak:** `docs/RAKIP_ANALIZI.md` içindeki **"Yok" (3 kalem)** ve **"Kısmi" (5 kalem)** özelliklerin tamamı (toplam 8 iş kalemi).  
**Önceliklendirme Formülü:** `Öncelik Puanı = (Gelir Etkisi [1–10] × Kullanıcı Değeri [1–10]) ÷ Tahmini Efor [1–5]`

---

## Özet Öncelik Tablosu

| Kod | Matris # | İş Kalemi | Matrosteki Durum | Gelir Etkisi | Kullanıcı Değeri | Efor | Puan | Öncelik | Durum |
|---|---|---|---|---|---|---|---|---|---|
| **P0-1** | #8 | Deterministik Yanıt Önbellekleme (`Response Cache`, TTL, `X-Keysmith-Cache`, Tasarruf Ölçümü) | Yok | 9 | 10 | 2,0 | **45,0** | **P0** | [x] |
| **P0-2** | #9 | Kısa Süreli Hız Sınırlama (`RPM` / `TPM` Rate Limiting) ve `X-RateLimit-*` / `Retry-After` Başlıkları | Kısmi | 9 | 9 | 2,0 | **40,5** | **P0** | [x] |
| **P0-3** | #11 | KVKK / GDPR Kişisel Veri (PII) Maskeleme/Engelleme & Prompt Injection Güvenlik Duvarı (`Guardrails`) | Kısmi | 10 | 9 | 2,5 | **36,0** | **P0** | [x] |
| **P0-4** | #13 | Müşteri/Kiracı Faturalandırma, Ön Ödemeli Kredi Cüzdanı, Paket Yönetimi ve `iyzico` Ödeme Soyutlaması | Yok | 10 | 9 | 3,0 | **30,0** | **P0** | [x] |
| **P1-1** | #10 | Ağırlıklı Yük Dengeleme & En Düşük Gecikme / Maliyet Yönlendirmesi (`weighted`, `least-latency`, `least-cost`) | Kısmi | 8 | 9 | 2,5 | **28,8** | **P1** | [x] |
| **P1-2** | #12 | Prometheus `/metrics` Uç Noktası & İmzalı Bütçe/Hata Webhook Bildirimleri (`Alerts`) | Kısmi | 8 | 8 | 2,5 | **25,6** | **P1** | [x] |
| **P1-3** | #15 | Operasyonel Web Kontrol Paneli (TR/EN, Mobil Uyumlu, `ui-quality` Standardında Durum/Fatura/Önbellek Konsolu) | Kısmi | 9 | 9 | 3,5 | **23,1** | **P1** | [ ] |
| **P2-1** | #14 | Merkezi Prompt Şablonları & Sürümleme (`Prompt Registry`, `{{değişken}}` Yerleştirme) | Yok | 7 | 8 | 2,5 | **22,4** | **P2** | [ ] |

---

## P0 — Satılabilir Olmak İçin Şart Olan Kalemler

### [x] P0-1 (Matris #8): Deterministik Yanıt Önbellekleme (`Response Cache`)
- **Durum (Matris):** Yok → Var
- **Tahmini Efor:** 2 birim (~1,5 saat; `src/cache.js` + `src/server.js` + `src/usage.js` + testler)
- **Bağımlılık:** Yok.
- **Kabul Ölçütleri:**
  1. `config.cache` (`{ enabled, ttlSeconds, maxEntries }`) ile etkinleştirilebilen, LRU + TTL tabanlı bellek içi (ve isteğe bağlı disk destekli) yanıt önbelleği (`src/cache.js`) çalışmalı.
  2. `/v1/chat/completions`, `/v1/messages`, `/v1/responses` ve `/v1/embeddings` uç noktalarında (akışsız ve akışlı SSE yanıtlarında) model, mesajlar, sistem promptu, araçlar (`tools`), `temperature` ve `reasoning_effort` üzerinden SHA-256 önbellek anahtarı üretilmeli.
  3. İstemci `Cache-Control: no-cache` veya `x-keysmith-cache: bypass` gönderdiğinde önbellek atlanmalı; normal çağrılarda yanıt başlığında `X-Keysmith-Cache: HIT` veya `X-Keysmith-Cache: MISS` dönmeli.
  4. `HIT` durumunda yukarı akışa (CLI veya HTTP sağlayıcıya) çağrı yapılmamalı, kullanım kaydında `cacheHit: true`, `cost: 0` ve `savedCost` (tasarruf edilen USD) izlenmeli; `GET /v1/keysmith/cache` ve `DELETE /v1/keysmith/cache` ile önbellek istatistikleri ve temizleme desteklenmeli.

### [x] P0-2 (Matris #9): Kısa Süreli Hız Sınırlama (`RPM` / `TPM` Rate Limiting) ve `X-RateLimit-*` Başlıkları
- **Durum (Matris):** Kısmi (yalnızca günlük `perDay` var) → Var
- **Tahmini Efor:** 2 birim (~1,5 saat; `src/quota.js` + `src/keys.js` + `src/server.js` + testler)
- **Bağımlılık:** Yok.
- **Kabul Ölçütleri:**
  1. `auth.keys` girdilerinde ve genel `limits.rateLimit` altında `perMinute` (`rpm` — dakikada azami istek) ve `tokensPerMinute` (`tpm` — dakikada azami girdi+çıktı tokenı) alanları desteklenmeli.
  2. Her API yanıtında (hem `200 OK` hem `429 Too Many Requests`) standart hız sınırı başlıkları (`X-RateLimit-Limit-Requests`, `X-RateLimit-Remaining-Requests`, `X-RateLimit-Reset-Requests`, ve `tpm` tanımlıysa `-Tokens` karşılıkları) gönderilmeli.
  3. `rpm` veya `tpm` aşıldığında `429 Too Many Requests` ve kalan saniyeyi gösteren `Retry-After` başlığı dönmeli; yanlış yapılandırılmış negatif/geçersiz `perMinute`/`tokensPerMinute` değerlerinde `keys.js` fail-closed davranmalı.

### [x] P0-3 (Matris #11): KVKK / GDPR Kişisel Veri (PII) Maskeleme & Prompt Injection Güvenlik Duvarı (`Guardrails`)
- **Durum (Matris):** Kısmi (yalnızca logda API anahtarı gizleme) → Var
- **Tahmini Efor:** 2,5 birim (~2 saat; `src/guardrails.js` + `src/server.js` + `src/config.js` + testler)
- **Bağımlılık:** Yok.
- **Kabul Ölçütleri:**
  1. `config.guardrails` (`{ enabled, mode: "mask" | "block" | "audit", piiTypes, blockPromptInjection, customPatterns }`) yapılandırması desteklenmeli; anahtar veya istek bazında (`x-keysmith-guardrails`) geçersiz kılma kuralları yönetici politikasına bağlı olmalı.
  2. Türkiye ve global regülasyonlar için yerleşik PII dedektörleri bulunmalı: **T.C. Kimlik Numarası (11 hane + algoritma doğrulaması)**, **TR IBAN (`TR` + 24 rakam)**, **Kredi Kartı Numarası (Luhn algoritması doğrulamalı)**, **E-posta Adresi**, **Türkiye/Uluslararası Telefon Numarası**.
  3. `mode: "mask"` seçildiğinde LLM'e gitmeden önce girdi metinlerindeki (ve `scanOutput: true` ise model yanıtındaki) PII verileri `[REDACTED_TCKN]`, `[REDACTED_IBAN]`, `[REDACTED_CARD]`, `[REDACTED_EMAIL]`, `[REDACTED_PHONE]` ile maskelenmeli; `mode: "block"` seçildiğinde istek `400 Bad Request` (`code: "guardrail_blocked"`) ile reddedilmeli ve yukarı akışa hiçbir veri gönderilmemeli.
  4. `blockPromptInjection: true` etkin olduğunda bilinen sistem komutu ezme / jailbreak kalıpları tespit edilip `400 Bad Request` (`code: "prompt_injection_detected"`) ile engellenmeli; tespit istatistikleri `X-Keysmith-Guardrails` başlığında ve durum/kullanım raporunda görünmeli.

### [x] P0-4 (Matris #13): Müşteri/Kiracı Faturalandırma, Ön Ödemeli Kredi Cüzdanı, Paket Yönetimi ve `iyzico` Ödeme Soyutlaması
- **Durum (Matris):** Yok → Var
- **Tahmini Efor:** 3 birim (~2,5 saat; `src/billing.js` + `src/server.js` + `src/usage.js` + testler)
- **Bağımlılık:** P0-1, P0-2.
- **Kabul Ölçütleri:**
  1. `src/billing.js` içinde paket tanımları (`starter`, `pro`, `team`, `enterprise` — TL ve USD fiyatları, aylık istek kotaları, özellik bayrakları), kiracı (`tenant`) cüzdan yönetimi (`balanceUsd`, `balanceTry`, `markupPct`, `billingMode: "prepaid" | "postpaid"`) ve değiştirilemez fatura defteri (`invoices.jsonl`, `%20 KDV` hesaplaması) bulunmalı.
  2. Sağlayıcı soyutlaması (`iyzico`, `stripe`, `manual`) ile:
     - `POST /v1/keysmith/billing/checkout`: Paket aboneliği veya kredi yükleme (`topup`) için iyzico uyumlu imzalı (`IYZWSv2` HMAC-SHA256) ödeme oturumu başlatabilmeli.
     - `POST /v1/keysmith/billing/webhooks/iyzico`: iyzico webhook bildirimini `x-iyz-signature-v3` HMAC-SHA256 ile zaman-sabit doğrulayıp kiracı bakiyesini/paketini güncelleyebilmeli ve otomatik resmi fatura kaydı (`inv_...`) oluşturabilmeli.
  3. Ön ödemeli (`prepaid`) bir kiracının bakiyesi tükendiğinde veya paket aylık istek kotası dolduğunda ilgili API anahtarından gelen çağrılar **`402 Payment Required`** (`code: "insufficient_balance"` veya `"plan_quota_exceeded"`) ile durdurulmalı; başarılı çağrılarda `cost × (1 + markupPct / 100)` tutarı cüzdandan düşülmeli.
  4. `GET /v1/keysmith/billing/plans`, `GET /v1/keysmith/billing/tenants`, `POST /v1/keysmith/billing/tenants`, `POST /v1/keysmith/billing/topup` ve `GET /v1/keysmith/billing/invoices` uç noktaları kapsam (`scope`) kurallarına uygun olarak çalışmalı; hiçbir ödeme sırrı diske veya loga yazılmamalı.

---

## P1 — Kurumsal Rekabet ve Büyüme Kaldıraçları

### [x] P1-1 (Matris #10): Ağırlıklı Yük Dengeleme & En Düşük Gecikme / Maliyet Yönlendirmesi (`weighted`, `least-latency`, `least-cost`)
- **Durum (Matris):** Kısmi (yalnızca sıralı failover ve kural/sınıflandırıcı sanal model) → Var
- **Tahmini Efor:** 2,5 birim (~2 saat; `src/gateway.js` + `src/config.js` + testler)
- **Bağımlılık:** P0-1.
- **Kabul Ölçütleri:**
  1. `aliases` tanımlarında dizi (`["a/m1", "b/m2"]`) yanında nesne biçimi de desteklenmeli: `{ strategy: "failover" | "weighted" | "least-latency" | "least-cost", targets: [{ target: "a/m1", weight: 70 }, { target: "b/m2", weight: 30 }] }`.
  2. `weighted`: Sağlıklı bacaklar arasında ağırlıklarla orantılı seçim yapmalı ve seçilen bacak hata verirse kalan bacaklara sırayla failover yapmalı.
  3. `least-latency`: Her `adapter/model` bacağının hareketli ortalama (EWMA) yanıt süresini izleyerek en hızlı bacağı ilk sıraya almalı (henüz ölçümü olmayan bacakları keşfederek).
  4. `least-cost`: `pricing` tablosuna göre girdi+çıktı birim maliyeti en düşük olan uygun bacağı ilk sıraya koymalı.

### [x] P1-2 (Matris #12): Prometheus `/metrics` Uç Noktası & İmzalı Bütçe/Hata Webhook Bildirimleri
- **Durum (Matris):** Kısmi (`/v1/keysmith/usage` JSON var, `/metrics` ve webhook yok) → Var
- **Tahmini Efor:** 2,5 birim (~2 saat; `src/metrics.js` + `src/webhooks.js` + `src/server.js` + testler)
- **Bağımlılık:** P0-1, P0-4.
- **Kabul Ölçütleri:**
  1. `GET /metrics` (ve `GET /v1/keysmith/metrics`) uç noktası Prometheus text exposition formatında (`text/plain; version=0.0.4`) metrik üretmeli: `keysmith_requests_total`, `keysmith_tokens_total`, `keysmith_cost_usd_total`, `keysmith_cache_hits_total`, `keysmith_guardrail_hits_total`, `keysmith_spend_cap_blocked_total`, `keysmith_request_duration_ms_bucket`.
  2. `config.webhooks` (`[{ url, secret, events: ["spend_cap.exceeded", "spend_cap.warning", "budget.low_balance", "adapter.error"] }]`) yapılandırması desteklenmeli.
  3. Harcama tavanı aşıldığında, kiracı bakiyesi kritik eşiğin altına düştüğünde veya adaptör hatası oluştuğunda `X-Keysmith-Signature-256: sha256=<hmac>` imzalı JSON yükü (`eventId`, `type`, `createdAt`, `data`) ilgili webhook URL'sine asenkron ve tekrar denemeli (retry) olarak gönderilmeli.

### [ ] P1-3 (Matris #15): Operasyonel Web Kontrol Paneli (TR/EN, Mobil Uyumlu, `ui-quality` Standardında)
- **Durum (Matris):** Kısmi (tek dilli basit tablo) → Var
- **Tahmini Efor:** 3,5 birim (~2,5 saat; `DESIGN.md` + `src/status-page.js` + `src/server.js` + görsel doğrulama + testler)
- **Bağımlılık:** P0-1, P0-2, P0-3, P0-4, P1-1, P1-2.
- **Kabul Ölçütleri:**
  1. `~/Projects/machine-admin/skills/ui-quality/SKILL.md` kurallarına tam uyumlu `DESIGN.md` yazılmalı (5 satırlık yön tanımı, tokenlar, yasaklı genel SaaS kalıplarından arındırılmış "Precision Terminal / Locksmith Ledger" estetiği).
  2. `GET /` durum ve operasyon paneli Türkçe (`?lang=tr` veya `Accept-Language: tr`) ve İngilizce (`?lang=en`) dil desteğine sahip olmalı; sayı, para birimi (`₺` / `$`) ve tarih formatları seçili arayüz diline uymalı (`C4`).
  3. Panelde Rotalar/Adaptörler, Maliyet & Tasarruf (Önbellek `HIT` oranı ve kurtarılan $), KVKK/Guardrail Özeti, Kiracı Paket/Fatura Özeti ve Prompt Şablonları bölümleri yer almalı.
  4. 390 px (mobil), 1000 px (dizüstü) ve 1440 px (masaüstü) ekran genişliklerinde yatay taşma (`scrollWidth > innerWidth`) ve üst üste binme olmamalı; Traycer tarayıcısı / Playwright ile ekran görüntüsü alınarak doğrulanmalı.

---

## P2 — Ekip Üretkenliği ve Platform Yapışkanlığı

### [ ] P2-1 (Matris #14): Merkezi Prompt Şablonları & Sürümleme (`Prompt Registry`)
- **Durum (Matris):** Yok → Var
- **Tahmini Efor:** 2,5 birim (~1,5 saat; `src/prompts.js` + `src/server.js` + testler)
- **Bağımlılık:** Yok.
- **Kabul Ölçütleri:**
  1. `config.prompts` veya `~/.config/keysmith/prompts.json` (`src/prompts.js`) üzerinde sürümlü prompt şablonları (`id`, `version`, `system`, `template`, `model`, `variables`, `updatedAt`) tanımlanabilmeli ve `GET /v1/keysmith/prompts`, `POST /v1/keysmith/prompts`, `GET /v1/keysmith/prompts/:id`, `DELETE /v1/keysmith/prompts/:id` uç noktalarıyla yönetilebilmeli.
  2. `/v1/chat/completions`, `/v1/messages` ve `/v1/responses` isteklerinde `prompt_id` (veya `metadata.prompt_id`) ile `prompt_variables: { ... }` gönderildiğinde şablondaki `{{değişken}}` alanları güvenli biçimde yerleştirilmeli; eksik zorunlu değişkende `400 Bad Request` dönmeli.
  3. Her şablon güncellemesi yeni bir `version` (`1, 2, 3...`) oluşturmalı ve istemci `prompt_version` belirterek belirli bir sürümü sabitleyebilmeli.
