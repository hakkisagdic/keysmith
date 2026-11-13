# Keysmith — Gelir Modeli, Fiyatlandırma ve Faturalandırma Mimarisi

**Tarih:** 13 Kasım 2026  
**Ürün:** Keysmith (`keysmith`)

---

## 1. Kim Öder, Neye Öder? (Hedef Müşteri Dilimleri)

Keysmith müşterileri "yalnızca bir API vekiline" değil; **mevcut kodlama CLI aboneliklerini (Claude Code, Codex, Kiro, Copilot, Command Code, OpenCode, Antigravity) üretime hazır bir API'ye dönüştürmeye, kredi/bütçe aşımını sıfırlamaya, önbellek ile token faturasını %20–40 düşürmeye ve KVKK/PII sızıntısını engellemeye** para öder.

| Müşteri Dilimi | Profil | Temel Acı Noktası (Neye Öder?) | Satın Alma Karar Vericisi |
|---|---|---|---|
| **1. Bireysel Profesyoneller & Indie SaaS Kurucuları (`Pro`)** | 1–2 kişilik ürün geliştiriciler, yoğun AI ajan kullanıcıları | Claude Max, ChatGPT Pro/Codex, Kiro ve OpenRouter aboneliklerini tek `/v1` anahtarında birleştirmek; Kiro overage ve OpenRouter BYOK fallback sürprizlerinden korunmak; tekrarlayan ajan çağrılarını önbellekten ($0) yanıtlamak. | Geliştirici / Kurucu (Kredi kartı ile anında self-serve) |
| **2. Yazılım Ajansları, AI Girişimleri & Ürün Ekipleri (`Team`)** | 3–25 kişilik mühendislik ekipleri, müşterilerine AI projesi teslim eden ajanslar | Geliştirici veya müşteri başına kapsamlı (`allow`/`deny`, `rpm`/`tpm`, harcama tavanlı) alt API anahtarları üretmek; müşteriye özel ön ödemeli kredi cüzdanı ve kar marjı (`markup`) tanımlamak; TCKN/kredi kartı/IBAN sızıntısını KVKK filtresiyle maskelemek; merkezi prompt şablonlarını sürümlemek. | CTO / Mühendislik Lideri / Ajans Ortağı |
| **3. Kurumsal Şirketler & Regüle Sektörler (`Enterprise`)** | Fintech, e-ticaret, hukuk, sağlık ve savunma şirketleri (25+ mühendis) | Müşteri verisini yurt dışı üçüncü parti proxy bulutlarına (OpenRouter, Portkey, Helicone) çıkarmadan kendi VPC/on-prem sunucusunda sıfır bağımlılıklı gateway çalıştırmak; Prometheus `/metrics`, imzalı bütçe/hata webhook'ları ve resmi TL + KDV faturası ile tam denetim sağlamak. | VP of Engineering / CISO / Satın Alma |

---

## 2. Paketler, Fiyat Önerisi (TL + USD) ve Ücretli / Ücretsiz Ayrımı

Tüm ücretli paketlerde **14 gün tam özellikli ücretsiz deneme** ve **yıllık peşin ödemede 2 ay bedava (%16,7 indirim)** uygulanır. Türkiye içi faturalandırmada fiyatlara **%20 KDV** eklenir.

| Özellik / Katman | **Starter (Ücretsiz)** | **Pro (Bireysel)** | **Team (Ekip & Ajans)** | **Enterprise (Kurumsal)** |
|---|---|---|---|---|
| **Aylık Fiyat (TL / USD)** | **0 ₺ / $0** | **990 ₺ + KDV** / **$29** | **3.990 ₺ + KDV** / **$119** | **19.900 ₺ + KDV** / **$590** |
| **Yıllık Fiyat (TL / USD)** | **0 ₺ / $0** | **9.900 ₺ + KDV** / **$290** | **39.900 ₺ + KDV** / **$1.190** | **199.000 ₺ + KDV** / **$5.900** |
| **Dahil Aylık Gateway İsteği** | 15.000 istek / ay | 150.000 istek / ay | 750.000 istek / ay | 5.000.000+ istek / ay |
| **İstek Aşım Ücreti** | Sert limit (`429`) | +100.000 istek başına **290 ₺ / $8** | +100.000 istek başına **220 ₺ / $6** | Özel SLA tarifesi |
| **Aktif API Anahtarı / Kiracı Cüzdanı** | 3 anahtar / 1 cüzdan | 25 anahtar / 5 cüzdan | 250 anahtar / 50 müşteri cüzdanı | Sınırsız |
| **CLI + HTTP Adaptörleri & UHP (`2026-10-19`)** | Var (yalnızca yerel `127.0.0.1`) | Var (Yerel + Cloudflare Tunnel) | Var (Yerel + Tünel + Çoklu Ortam) | Var (VPC / On-Prem / Air-Gapped) |
| **Failover Alias & Kural/Sınıflandırıcı Sanal Modeller** | Temel sıralı failover (2 bacak) | Sınırsız bacak + Sanal Modeller | Sınırsız + `weighted`, `least-latency`, `least-cost` | Sınırsız + Özel Yönlendirme |
| **Deterministik Yanıt Önbellekleme (`Response Cache`)** | Yok | **Var** (TTL, `X-Keysmith-Cache`, maliyet tasarruf raporu) | **Var** (Yüksek kapasite + kiracı bazlı izolasyon) | **Var** |
| **Hız Sınırlama (`RPM` / `TPM` + `X-RateLimit-*`)** | Yalnızca günlük `perDay` | **Var** (`rpm`, `tpm`, `perDay`, standart başlıklar) | **Var** (Anahtar ve müşteri cüzdanı bazlı) | **Var** |
| **KVKK / GDPR PII Maskeleme & Prompt Injection Kalkanı** | Yok (yalnızca logda anahtar gizleme) | Kısmi (yalnızca uyarı/audit) | **Var** (TCKN, IBAN, Kredi Kartı, Telefon, E-posta `mask`/`block`) | **Var** (Özel kurumsal regex/kural seti) |
| **Merkezi Prompt Şablonları (`Prompt Registry`)** | Yok | 10 şablona kadar | **Sınırsız şablon & sürümleme** | **Sınırsız** |
| **Prometheus `/metrics` & İmzalı Webhook Uyarıları** | Yok | Kısmi (`/metrics` açık) | **Var** (`/metrics` + HMAC imzalı bütçe/hata webhook) | **Var** (SIEM / OTel uyumlu) |
| **Alt Müşteri Faturalandırma & Marj (`Reseller Markup`)** | Yok | Yok | **Var** (Müşteri cüzdanına % marj tanımlama + fatura kaydı) | **Var** |

---

## 3. Gelir Artıran İlk 3 Kaldıraç

### Kaldıraç 1: Ön Ödemeli Kredi Cüzdanı + Kullanım Marjı (`Prepaid Wallet & Markup Engine`)
- **Nasıl Çalışır:** Müşteriler veya ajansların alt müşterileri (`tenants`) iyzico üzerinden TL veya USD cinsinden ön ödemeli bakiye (`topup`: 500 ₺, 2.500 ₺, 10.000 ₺ veya $25, $100, $500) yükler. Her başarılı (`200 OK`) LLM çağrısında sağlayıcı maliyeti (`costUsd`) üzerine yapılandırılabilir platform/ajans marjı (`markupPct`, ör. yönetilen bulutta **%5**, ajans yeniden satışında **%15–30**) eklenerek cüzdan bakiyesinden gerçek zamanlı düşülür.
- **Gelir Etkisi:** Sabit abonelik gelirinin yanına OpenRouter ve Wiro AI modelinde olduğu gibi ölçeklenen, sıfır tahsilat riskli (ön ödemeli) işlem komisyonu ekler.

### Kaldıraç 2: KVKK / PII Güvenlik Duvarı ve Maliyet Tasarruf Garantisi (`Cache + Guardrail Upsell`)
- **Nasıl Çalışır:** Starter ve Pro kullanıcılarına durum panelinde **"Önbellek ile bu ay X $ tasarruf edildi"** ve **"Guardrail taramasında Y adet kişisel veri (TCKN/IBAN/Kart) tespit edildi"** metrikleri canlı gösterilir. Maskeleme/bloklama (`action: "mask" | "block"`) ve imzalı bütçe webhook'ları `Team` paketinde (veya bağımsız **+1.250 ₺ / $39/ay Güvenlik Eklentisi** olarak) sunulur.
- **Gelir Etkisi:** Bireysel geliştirici olarak başlayan kullanıcıların şirket/ekip ortamına geçerken `Pro` (990 ₺) yerine doğrudan `Team` (3.990 ₺) paketini seçmesini sağlar (ARPU'yu 4 katına çıkarır).

### Kaldıraç 3: Yıllık Peşin Plan + Otomatik Bakiye Yükleme (`Auto-Topup & Annual Lock-in`)
- **Nasıl Çalışır:** Yıllık abonelikte 2 ay ücretsiz (%16,7 indirim) avantajı ile 12 aylık nakit akışı ilk günden tahsil edilir. Cüzdan bakiyesi belirlenen eşiğin (ör. 250 ₺ / $10) altına düştüğünde iyzico kayıtlı kart token'ı üzerinden otomatik bakiye yükleme (`autoTopup`) tetiklenir.
- **Gelir Etkisi:** Müşteri kaybını (churn) düşürür ve bakiye bittiği için API trafiğinin durmasından kaynaklanan gelir kaybını önler.

---

## 4. İlk 10 Müşteriyi Bulma Planı (0 → 10 Ödeyen Müşteri)

| Aşama | Hedef Kitle & Kanal | Somut Teklif / Kanca | Hedeflenen Dönüşüm |
|---|---|---|---|
| **Adım 1 (Müşteri 1–3): Kodlama CLI Güç Kullanıcıları & Indie Kurucular** | GitHub (`keysmith` yıldızlayanlar), X/Twitter ve Reddit (`r/LocalLLaMA`, `r/ClaudeAI`, Türkiye geliştirici toplulukları) üzerinde Claude Code / Kiro / Codex CLI kullanan geliştiriciler. | *"Kiro ve Claude Code aboneliklerinizi kredi aşımı (overage) korkusu olmadan ve tekrarlayan çağrılarda %35 önbellek tasarrufuyla tek API anahtarına dönüştürün."* | **3× Pro Plan** (3 × 990 ₺ = 2.970 ₺/ay + kredi yükleme) |
| **Adım 2 (Müşteri 4–7): Türkiye'deki Butik Yazılım ve AI Otomasyon Ajansları** | Müşterilerine n8n, LangChain, Vercel AI SDK veya özel chatbot/ajan kurulumu yapan İstanbul/Ankara/İzmir merkezli yazılım ajansları. | *"Müşterilerinize kendi OpenAI/Anthropic anahtarınızı vermek yerine Keysmith ile müşteri bazlı TL/USD bütçeli alt anahtar verin, %20 ajans marjınızı otomatik ekleyin ve iyzico ile tahsil edin."* | **4× Team Plan** (4 × 3.990 ₺ = 15.960 ₺/ay + cüzdan komisyonu) |
| **Adım 3 (Müşteri 8–10): KVKK Hassasiyeti Olan Türk SaaS / Fintech / Hukuk-Tech Ekipleri** | Müşteri destek, belge analizi veya iç asistan geliştiren ancak TCKN/IBAN/Sözleşme verisinin açık metin olarak yurt dışı LLM'e gitmesinden çekinen KOBİ ve girişimler. | *"Kendi sunucunuzda 5 dakikada kurulan, TCKN/IBAN/Kredi Kartı verilerini LLM'e çıkmadan maskeleyen ve resmi TL faturalı AI Gateway."* | **2× Team Plan + 1× Enterprise Plan** (27.880 ₺/ay) |

---

## 5. Ödeme Mimarisi (`iyzico` Soyutlaması), Kullanım Ölçümü ve Fatura Kaydı

### 5.1 Ödeme Sağlayıcı Soyutlaması (`src/billing.js`)
Keysmith'te ödeme işlemleri doğrudan tek bir sağlayıcıya bağımlı değildir; `BillingManager` içinde standart bir sağlayıcı arayüzü (`PaymentProviderAdapter`) kullanılır:
- **Desteklenen Sağlayıcı Sürücüleri:**
  1. **`iyzico` (Varsayılan Türkiye & Uluslararası Kart Geçidi):**
     - `createCheckoutSession({ tenantId, planId, amount, currency, callbackUrl, buyer })`: iyzico Checkout Form / Ödeme oturumu başlatma yükünü (`locale: "tr" | "en"`, `currency: "TRY" | "USD"`, `basketItems`, `conversationId`) oluşturur ve `IYZWSv2` HMAC-SHA256 yetkilendirme imzasını üretir.
     - `verifyWebhook({ headers, rawBody })`: iyzico webhook bildirimlerindeki `x-iyz-signature-v3` (HMAC-SHA256) imzasını zaman-sabit (`crypto.timingSafeEqual`) olarak doğrular; sahte bildirimleri (`401`) reddeder.
     - **Güvenlik Kuralı:** `IYZICO_API_KEY` ve `IYZICO_SECRET_KEY` yalnızca ortam değişkeninden (`process.env`) veya Keysmith'in `{env:...}` / `{file:...}` referans çözücüsünden çalışma anında okunur; diske, loglara veya hata mesajlarına asla yazılmaz.
  2. **`stripe` (Global Alternatif Sürücü):** `Stripe-Signature` (`t=...,v1=...`) HMAC-SHA256 doğrulaması ve checkout oturumu soyutlaması.
  3. **`manual` (Kurumsal Havale/EFT & Yerel Test Sürücüsü):** Yönetici onayıyla (`POST /v1/keysmith/billing/topup` veya CLI üzerinden) kurumsal fatura karşılığı bakiye/paket tanımlama.

### 5.2 Kullanım Ölçümü Nerede ve Nasıl Tutulur?
1. **İstek Bazlı Ham Denetim Kaydı (`~/.config/keysmith/usage.jsonl` — `src/usage.js`):**
   - Her API isteği tamamlandığında atomik olarak JSONL satırı yazılır: `ts`, `key` (parmak izi), `tenantId`, `adapter`, `model`, `inputTokens`, `outputTokens`, `cachedTokens`, `cost` (sağlayıcı USD maliyeti), `billedCost` (marj dahil faturalanan tutar), `cacheHit` (`true`/`false`), `guardrailHits` (varsa maskelenen PII sayısı).
2. **Kiracı Cüzdanı ve Abonelik Durumu (`~/.config/keysmith/billing.json` — `src/billing.js`):**
   - `0600` izinli atomik dosya yazımıyla her kiracının (`tenantId`) aktif paketi (`starter`, `pro`, `team`, `enterprise`), ilişkili API anahtarı parmak izleri (`keys`), ön ödemeli kredi bakiyesi (`balanceUsd`, `balanceTry`), marj oranı (`markupPct`), aylık istek sayacı ve dönem sonu tarihi tutulur.
   - Ön ödemeli (`prepaid`) moddaki bir kiracının bakiyesi sıfırın altına düştüğünde ağ geçidi isteği başlatmadan **`402 Payment Required`** (`code: "insufficient_balance"`) ile reddeder.
3. **Değiştirilemez Fatura ve Tahsilat Defteri (`~/.config/keysmith/invoices.jsonl` — `src/billing.js`):**
   - Her paket satın alımı, kredi yüklemesi (`topup`), iade (`refund`) veya dönem sonu kullanım kesintisi değiştirilemez (append-only) bir fatura satırı olarak kaydedilir:
     - `invoiceId` (`inv_YYYYMMDD_<kısa-id>`), `createdAt`, `tenantId`, `tenantName`, `taxId` (VKN / TCKN), `taxOffice` (Vergi Dairesi), `kind` (`subscription` | `topup` | `usage_settlement`), `currency` (`TRY` | `USD`), `subtotal`, `vatRate` (TR için `0.20`, yurt dışı döviz ihracatı için `0`), `vatAmount`, `total`, `provider` (`iyzico` | `stripe` | `manual`), `providerPaymentId`, `status` (`paid` | `pending` | `refunded`), `lineItems`.
   - Bu defter `GET /v1/keysmith/billing/invoices` uç noktasından JSON olarak sorgulanabilir ve e-Fatura / muhasebe sistemlerine doğrudan aktarılabilir.

---

## 6. Sahibe Sorular (İşi Durdurmaz — Yönetici / Sahip Kararı İçin Notlar)

1. **Canlı iyzico Üye İşyeri Bilgileri (Yönetici İşi):** Canlı tahsilata geçildiğinde `IYZICO_API_KEY`, `IYZICO_SECRET_KEY` ve `IYZICO_BASE_URL` (`https://api.iyzipay.com`) ortam değişkenlerinin üretim sunucusuna tanımlanması gerekmektedir.
2. **Kurumsal Fatura Ünvanı ve Vergi Oranı:** Türkiye içi TL faturalarda varsayılan KDV oranı `%20` olarak ayarlanmıştır; yazılım ihracatı (yurt dışı USD tahsilat) istisnası uygulanacak müşteriler için `vatExempt: true` bayrağı kullanılacaktır. Fatura üst bilgisinde yer alacak resmi şirket ünvanı ve MERSİS/VKN bilgisi netleştiğinde yapılandırmaya eklenecektir.
3. **USD / TL Kur Çevrimi:** Sağlayıcı token maliyetleri globalde USD bazlı olduğundan, TL cüzdan kullanan müşteriler için varsayılan referans kur (`fxTryPerUsd`) yapılandırmada tutulmaktadır; TCMB günlük efektif satış kurunun otomatik çekilmesi istenirse yönetici onayıyla dış kur kaynağı bağlanabilir.
