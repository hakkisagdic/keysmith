# Keysmith — Rakip Analizi (Dünya ve Türkiye)

**Tarih:** 14 Kasım 2026 (2. Dalga Güncellemesi)  
**Ürün:** Keysmith (`keysmith`) — Kodlama CLI Aboneliklerini (Claude Code, Codex, OpenCode, Kiro, Qoder, Command Code, Copilot, Antigravity) ve Çoklu HTTP LLM Sağlayıcılarını Birleştiren AI Gateway & UHP (`2026-10-19`) Yönlendiricisi.

---

## 1. İncelenen Rakipler (Dünya + Türkiye)

Keysmith iki ürün kategorisinin kesişiminde yer alır:
1. **Kurumsal / Bulut AI Gateway & LLM Yönlendiricileri:** OpenRouter, LiteLLM, Portkey AI, Cloudflare AI Gateway, Helicone, TrueFoundry AI Gateway.
2. **CLI-to-API Köprüleri ve Türkiye Yerel AI API Pazaryerleri:** CLIProxyAPI (`router-for-me/CLIProxyAPI` & `claude-code-proxy` ekosistemi) ve Türkiye merkezli **Wiro AI** (`wiro.ai`).

| # | Rakip | Merkez / Pazar | Konumlandırma | Kaynak |
|---|---|---|---|---|
| 1 | **OpenRouter** | ABD (Global) | Birleşik LLM API pazaryeri, BYOK yönlendirici ve ön ödemeli kredi geçidi | https://openrouter.ai/docs/overview/principles |
| 2 | **LiteLLM (Proxy / Enterprise)** | ABD (Global, Açık Çekirdek) | 100+ sağlayıcı için Python/Rust açık kaynak LLM Proxy ve kurumsal maliyet/yetki katmanı | https://github.com/BerriAI/litellm · https://www.litellm.ai |
| 3 | **Portkey AI Gateway** | ABD / Hindistan (Global, Palo Alto Networks bünyesinde) | AI Gateway, semantik önbellek, guardrail, prompt yönetimi ve gözlemlenebilirlik kontrol düzlemi | https://portkey.ai/pricing · https://github.com/Portkey-AI/gateway |
| 4 | **Cloudflare AI Gateway** | ABD (Global Edge) | Edge önbellekleme, hız sınırlama, DLP/Guardrails, dinamik yönlendirme ve Unified Billing | https://developers.cloudflare.com/ai-gateway/ |
| 5 | **Helicone AI Gateway** | ABD (Global, Açık Kaynak + Bulut) | Rust tabanlı düşük gecikmeli AI Gateway, LLM gözlemlenebilirlik, maliyet analizi ve prompt güvenliği | https://www.helicone.ai/pricing · https://github.com/Helicone/helicone |
| 6 | **TrueFoundry AI Gateway** | ABD (Global Kurumsal) | Kubernetes-yerel AI Gateway, MCP sunucu yönetişimi, semantik önbellek ve OTel izleme | https://www.truefoundry.com/ai-gateway |
| 7 | **CLIProxyAPI / claude-code-proxy** | Global (Açık Kaynak) | Kodlama CLI ve OAuth aboneliklerini (Claude, Codex, Gemini, Antigravity) yerel `/v1` API'ye çeviren Go/Python vekilleri | https://github.com/router-for-me/CLIProxyAPI · https://github.com/1rgs/claude-code-proxy |
| 8 | **Wiro AI** | Türkiye / İstanbul (Türkiye + Global) | Türkiye çıkışlı birleşik üretken AI ve Türkçe/Global LLM API pazaryeri, kullandıkça öde kredi geçidi | https://wiro.ai · https://wiro.ai/pricing · https://wiro.ai/docs/pricing |
| 9 | **Bifrost (Maxim AI) / TensorZero** | ABD (Global, Açık Kaynak Kurumsal) | Go/Rust yüksek performanslı AI Gateway, JSON şema zorlama, devre kesici ve A/B deney katmanı | https://getbifrost.ai · https://github.com/tensorzero/tensorzero |

---

## 2. Özellik Matrisi (Özellik × Rakip × Keysmith)

Durum anahtarı:
- **Var**: Üründe tam ve üretim kalitesinde mevcut.
- **Kısmi**: Temel düzeyde mevcut ancak kurumsal/ticari kullanım için eksik alt bileşenleri var.
- **Yok**: Üründe henüz bulunmuyor.

| # | Özellik | OpenRouter | LiteLLM | Portkey | Cloudflare AIG | Helicone | TrueFoundry | CLIProxyAPI | Wiro AI (TR) | **Keysmith (Biz)** |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Çoklu Protokol Uyumluluğu** (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`) | Kısmi (OpenAI + `/responses` beta) | Var | Var | Kısmi (`/compat` + yerel) | Var | Var | Kısmi (OpenAI/Claude/Gemini, `/embeddings` yok) | Kısmi ( Görev/REST + OpenAI uyumlu uçlar) | **Var** |
| 2 | **Universal Harness Protocol (UHP `2026-10-19`)** (`/.well-known/uhp`, `/v1/harnesses`, `previous_response_id`, `Idempotency-Key`) | Yok | Yok | Yok | Yok | Yok | Kısmi (MCP kayıt) | Yok | Kısmi (MCP inceleme) | **Var** |
| 3 | **Kodlama CLI Aboneliklerini API'ye Dönüştürme** (Claude Code, Codex, OpenCode, Kiro, Qoder, Copilot, Command Code, Antigravity) | Yok | Yok | Yok | Yok | Yok | Yok | Kısmi (Claude/Codex/Gemini/Antigravity; Kiro/OpenCode/Qoder yok) | Yok | **Var** |
| 4 | **İstemci Araç (Client Tools) Köprüsü & Yabancı Araç Koruması** (`BRIDGE` Unix Socket MCP + `EMULATE` JSON + Fail-Closed Tool Guard) | Kısmi (yalnızca HTTP sağlayıcı) | Kısmi (yalnızca HTTP sağlayıcı) | Kısmi (yalnızca HTTP sağlayıcı) | Kısmi (yalnızca HTTP sağlayıcı) | Kısmi (yalnızca HTTP sağlayıcı) | Var (HTTP + MCP) | Kısmi (akışta kırılmalar var) | Kısmi | **Var** |
| 5 | **Kural ve Sınıflandırıcı Tabanlı Sanal Modeller & Failover Alias Zincirleri** | Var (Auto Router + Fallbacks) | Var | Var | Var (Auto Router + Dynamic Routing) | Var | Kısmi (kural tabanlı) | Kısmi (statik eşleme) | Yok | **Var** |
| 6 | **Plan Kredi Koruması (Kiro Credit Guard) & N-Günlük Harcama Tavanları (Spend Caps)** | Kısmi (kredi limiti var, CLI kredi koruması yok) | Var (bütçe + süre sıfırlama) | Var | Var | Kısmi (uyarı odaklı) | Var | Yok | Var (ön ödemeli bakiye tavanı) | **Var** |
| 7 | **Kapsamlı API Anahtarları (`allow`/`deny` Glob + SHA-256 `keyHash`)** | Kısmi | Var | Var (Virtual Keys) | Var | Var | Var | Kısmi | Kısmi | **Var** |
| 8 | **Yanıt Önbellekleme (Response Caching)** (Deterministik/TTL önbellek, `Cache-Control`, `X-*-Cache: HIT\|MISS`, maliyet = $0 kaydı) | Kısmi (yalnızca sağlayıcı prompt cache) | Var (In-memory / Redis / S3) | Var (Exact + Semantic) | Var (Edge Cache + TTL) | Var (Edge Cache) | Var (Exact + Semantic) | Yok | Yok | **Var (P0-1)** |
| 9 | **Kısa Süreli Hız Sınırlama (RPM / TPM Rate Limiting & Standart Başlıklar)** (`rpm`, `tpm`, `X-RateLimit-*`, `Retry-After`) | Var | Var | Var | Var (sabit & kayan pencere) | Var | Var | Yok | Var (bakiye bazlı eşzamanlılık) | **Var (P0-2)** |
| 10 | **Ağırlıklı Yük Dengeleme & En Düşük Gecikme/Maliyet Yönlendirmesi** (`weighted`, `least-latency`, `least-cost` stratejileri) | Var (fiyat/gecikme/uptime sıralama) | Var (`simple-shuffle`, `least-busy`, `latency-based`, `cost-based`) | Var (ağırlıklı + gecikme) | Var | Var | Var (ağırlıklı) | Kısmi (round-robin) | Yok | **Var (P1-1)** |
| 11 | **İçerik Güvenlik Duvarı & KVKK/GDPR Kişisel Veri (PII) Maskeleme/Engelleme** (TCKN, kredi kartı, e-posta, telefon, IBAN, prompt injection filtresi) | Yok | Var (Presidio / Lakera / Regex Guardrails) | Var (PII redaction + Guardrails) | Var (Llama Guard + DLP profilleri) | Var (Prompt Security) | Var (Inline Guardrails) | Kısmi (`cloak_sensitive_words`) | Yok | **Var (P0-3)** |
| 12 | **Gözlemlenebilirlik Dışa Aktarımı: Prometheus `/metrics` & İmzalı Bütçe/Hata Webhook Bildirimleri** | Kısmi (etkinlik sayfa/API) | Var (`/metrics` + Slack/Webhook uyarıları) | Var (OTel + Alerts) | Var (Logpush + bildirimler) | Var (Webhooks + Alerts) | Var (Prometheus / OTel) | Yok | Var (görev callback webhook) | **Var (P1-2)** |
| 13 | **Müşteri/Kiracı Faturalandırma, Ön Ödemeli Kredi Cüzdanı, Paket Yönetimi ve Ödeme Soyutlaması (iyzico / Stripe / Fatura Kaydı)** | Var (kredi cüzdanı + %5.5 komisyon) | Kısmi (müşteri bütçe tablosu var, yerel ödeme/iyzico yok) | Var (SaaS abonelik) | Var (Unified Billing %5 komisyon) | Var (SaaS + kullanım aşımı) | Var (SaaS koltuk + aşım) | Yok | Var (ön ödemeli USD kredi + Türkiye fatura) | **Var (P0-4)** |
| 14 | **Merkezi Prompt Şablonları & Sürümleme (Prompt Registry / Templates)** (Değişken yerleştirme `{{var}}`, sürüm sabitleme, API üzerinden çağırma) | Yok | Var (Prompt Management) | Var (Prompt Templates & Versioning) | Yok | Var (Prompts & Versioning) | Kısmi | Yok | Kısmi (hazır pipeline şablonları) | **Var (P2-1)** |
| 15 | **Operasyonel Web Kontrol Paneli & Çok Dilli (TR/EN) Arayüz** (Mobil uyumlu durum, maliyet, önbellek, fatura/kredi, guardrail ve canlı test ekranı) | Var | Var (Admin UI) | Var | Var | Var | Var | Var (`Management-Center` port 8317) | Var (Wiro Studio) | **Var (P1-3)** |
| 16 | **Semantik Benzerlik Önbelleklemesi (Semantic Cache)** (Kosinüs/N-gram benzerliğiyle yakın sorgularda `SEMANTIC-HIT`, benzerlik eşiği `semanticThreshold`) | Yok | Var (Redis/Qdrant Semantic) | Var (Semantic Cache) | Kısmi | Yok | Var (Semantic Cache) | Yok | Yok | **Kısmi** (Yalnızca birebir SHA-256 `Exact` önbellek var; kelimesi biraz değişen yakın sorguları yakalayan `Semantic Cache` yok) |
| 17 | **Otomatik Devre Kesici (Circuit Breaker) & Sağlık Tabanlı Soğuma (Cooldown)** (`closed`/`open`/`half-open`, ardışık hatada bacağı geçici devre dışı bırakma) | Var | Var (`allowed_fails` + `cooldown_time`) | Var | Var | Kısmi | Var | Kısmi | Yok | **Kısmi** (İstek içi sıralı failover var; ardışık hata veren bacağı N saniye boyunca otomatik soğumaya alan `Circuit Breaker` durumu yok) |
| 18 | **Yapılandırılmış Çıktı (Structured Output / JSON Schema) Doğrulama ve Otomatik Onarım** (`response_format: json_schema`/`json_object` doğrulaması) | Var (`response-healing`) | Var (`json_schema` doğrulama) | Var | Kısmi | Yok | Var | Yok | Yok | **Yok** (CLI ve HTTP yanıtlarında `response_format` JSON/şema doğrulaması, kod bloğu soyma ve şema uyumsuzluğunda onarım/failover yok) |

---

## 3. Rakip Bazlı Fiyatlandırma, Paketler, Övgüler ve Şikâyetler

### 3.1 OpenRouter (`openrouter.ai`)
- **Fiyatlandırma ve Paketler:**
  - **Model Token Fiyatı:** Sağlayıcı liste fiyatını komisyonsuz yansıtır (pass-through).
  - **Standart (Pay-As-You-Go):** Kredi kartı ile bakiye yüklemede **%5,5 platform ücreti** (en az $0,80), kripto ödemelerde **%5,0** ücret.
  - **BYOK (Kendi Anahtarını Getir):** Aylık ilk **$25.000** liste fiyatı kullanımına kadar $0 ücret; aşan kısımda liste fiyatının **%5'i** OpenRouter kredi bakiyesinden düşülür.
  - **Business Plan:** **%8 platform ücreti** (bölgesel yönlendirme ve gelişmiş harcama kontrolleri).
  - **Enterprise:** Özel sözleşme (genellikle $200.000+/ay BYOK kotası; tam liste fiyatı kamuya açık değil — *doğrulanmadı*).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - Tek bir OpenAI uyumlu uç noktadan yüzlerce modele anında erişim ve sağlayıcı kesintilerinde otomatik yedekleme (fallback).
  - Küçük ekipler için $25.000/ay ücretsiz BYOK sınırının cömertliği.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **BYOK Fallback Tuzağı:** Kullanıcının kendi API anahtarı anlık hız sınırına (429) veya zaman aşımına takıldığında OpenRouter varsayılan olarak kendi havuz anahtarına düşüp kullanıcının ön ödemeli OpenRouter bakiyesini habersiz tüketebiliyor.
  - **Yüksek Hacimde %5–5,5 Vergi:** Aylık $25k üzeri kullanımda yalnızca yönlendirme için %5–5,5 komisyon ödemek kendi sunucusunda gateway çalıştırmaya kıyasla çok pahalı bulunuyor.
  - **Katı İade Politikası ve `:free` Model Kalitesi:** Ajan döngüsü hatalarında harcanan kredilerin iade edilmemesi ve `:free` modellerde aşırı gecikme/kesinti yaşanması.
- **Kaynaklar:**
  - https://openrouter.ai/pricing
  - https://openrouter.ai/docs/use-cases/byok
  - https://truefoundry.com/blog/openrouter-pricing-and-alternatives

### 3.2 LiteLLM (`litellm.ai` / `github.com/BerriAI/litellm`)
- **Fiyatlandırma ve Paketler:**
  - **Open Source (MIT Lisansı):** **$0 / ücretsiz** (kendi altyapında barındırma; 100+ sağlayıcı, sanal anahtarlar, bütçeler, Prometheus metrikleri, en fazla 5 kullanıcıya kadar SSO).
  - **Enterprise Plan:** Yıllık özel fiyatlandırma ("Contact Sales"; kamuya açık sabit taban fiyat yayınlanmıyor — *doğrulanmadı*, kapasite ve koltuk sayısına göre yıllık lisanslanır, token başına komisyon almaz). Sınırsız SSO/SCIM, OIDC/JWT, ayrıntılı RBAC, denetim kayıtları, IP izin listeleri ve özel guardrail politikaları içerir.
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - 100+ sağlayıcıyı tek şemada birleştirmesi ve yeni çıkan modellere 0. günde destek vermesi.
  - Açık kaynak sürümünde bile sanal anahtar ve bütçe takibinin ücretsiz sunulması.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **Kararlılık ve Regresyonlar (GitHub Issue #31416 vb.):** Hızlı özellik ekleme temposu nedeniyle küçük sürüm geçişlerinde akış (streaming) ve araç çağırma (tool calling) regresyonları yaşanması.
  - **Yüksek Bellek Tüketimi:** Python tabanlı proxy'nin yoğun yük altında işçi (worker) başına **4 GB'a kadar RAM** tüketmesi ve PostgreSQL/Redis operasyon yükü.
  - **Tedarik Zinciri Güvenliği Endişeleri ve "SSO Vergisi":** 2026 içinde yaşanan CI/CD paket güvenliği olayları nedeniyle sürüm sabitleme zorunluluğu ve 5 kullanıcı üzeri SSO/RBAC için kurumsal satış görüşmesi şartı.
- **Kaynaklar:**
  - https://www.litellm.ai/#pricing
  - https://github.com/BerriAI/litellm
  - https://docs.litellm.ai/docs/proxy/enterprise

### 3.3 Portkey AI Gateway (`portkey.ai`)
- **Fiyatlandırma ve Paketler:**
  - **Open-Source Gateway:** **$0** (MIT lisanslı temel yönlendirici; Redis/Docker yönetimi kullanıcıya ait, bulut kontrol paneli yok).
  - **Developer (Ücretsiz Bulut):** **$0 / ay** — aylık **10.000 kaydedilen istek (log)**, temel gözlemlenebilirlik, sanal anahtarlar, prompt yönetimi ve önbellek.
  - **Pro / Growth (Bulut):** Aylık **$49'dan başlar** (log hacmine göre kademeli artar) — daha yüksek log kotası, uzun saklama süresi, özel metadata filtreleri, bütçe uyarıları ve ekip çalışma alanları.
  - **Enterprise:** Özel fiyatlandırma (10M+ log/ay, SSO, RBAC, SOC2/HIPAA, AB/bölgesel veri yerleşimi, özel VPC kurulumu).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - Base URL değişimiyle 2 dakikada entegrasyon, güçlü maliyet/gecikme panosu ve CI/CD ile tekrarlayan sorgularda ciddi tasarruf sağlayan önbellekleme.
  - Çoklu ekip çalışma alanları ve merkezi prompt şablonu sürümleme.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **Ajan İş Akışlarında Hızla Biten Log Kotası:** Çok adımlı kodlama ajanlarında 10.000 istek/ay ücretsiz kotanın birkaç günde tükenmesi.
  - **Yüksek Log Yükünde Panel Yavaşlığı ve Satın Alma Sonrası Endişeler:** Yoğun izleme verisinde web arayüzünün yavaşlaması ve 2026'daki Palo Alto Networks satın alması sonrası bağımsız açık mimari arayan ekiplerin alternatiflere yönelmesi.
- **Kaynaklar:**
  - https://portkey.ai/pricing
  - https://github.com/Portkey-AI/gateway

### 3.4 Cloudflare AI Gateway (`developers.cloudflare.com/ai-gateway`)
- **Fiyatlandırma ve Paketler:**
  - **Temel Gateway Özellikleri:** Ücretsiz ve Ücretli Workers planlarında **$0** (önbellekleme, hız sınırlama, analitik, harcama limitleri).
  - **Unified Billing (Birleşik Faturalandırma):** Ön ödemeli kredi yüklemelerinde **%5 platform komisyonu** (ör. $100 kredi için $105 ödeme).
  - **Guardrails & Loglama:** Guardrails (`@cf/meta/llama-guard-3-8b`) Workers AI token tarifesinden; Eylül 2026 sonrası yeni hesaplarda loglar standart **Workers Logs** tarifesinden; özel DLP profilleri ise Cloudflare Zero Trust DLP aboneliğinden ücretlendirilir.
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - Cloudflare Edge üzerinde sıfıra yakın ek gecikmeyle önbellekleme, hız sınırlama ve harcama tavanı uygulanabilmesi.
  - Kredi kartı veya ek sunucu kurmadan dakikalar içinde devreye alınması.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **OpenAI Uyumlu `/compat` Uç Noktası Hataları:** `/compat` çevirisinde araç çağırma ve özel sağlayıcı öneklerinde yaşanan uyumsuzluklar.
  - **Tahmini Maliyet Sapmaları ve Sınırlı OTel Desteği:** Token maliyetlerinin bazı modellerde (ör. Gemini) gerçek faturayla uyuşmaması ve derin OpenTelemetry/Prometheus ihracının zayıf kalması.
- **Kaynaklar:**
  - https://developers.cloudflare.com/ai-gateway/reference/pricing/
  - https://developers.cloudflare.com/ai-gateway/reference/limits/

### 3.5 Helicone AI Gateway (`helicone.ai`)
- **Fiyatlandırma ve Paketler:**
  - **Self-Hosted (Açık Kaynak):** **$0** (Docker/Kubernetes; altyapı maliyeti kullanıcıya ait).
  - **Hobby (Ücretsiz):** **$0 / ay** — 10.000 istek/ay, 1 GB depolama, 1 koltuk, 10 API çağrısı/dk sınır.
  - **Pro:** **$79 / ay + kullanım aşımı** — 10.000 temel istek/ay, Prompt Management, Playground, HQL sorgulama, uyarılar (alerts), 1.000 log/dk, dışa aktarma.
  - **Team:** **$799 / ay + kullanım aşımı** — 15.000 log/dk, SOC-2 Type II, HIPAA uyumluluğu, özel Slack desteği.
  - **Enterprise:** Özel fiyatlandırma (30.000+ log/dk, SAML SSO, özel SLA).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - Rust tabanlı AI Gateway'in çok düşük gecikme (~8 ms P50) sunması ve tek satırlık başlık/URL değişikliğiyle entegrasyon.
  - Kullanıcı, oturum ve özellik bazlı birim ekonomisi (unit economics) maliyet analizi.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **$79 → $799 Sert Fiyat Sıçraması:** Küçük/orta ölçekli ekipler için Pro'dan Team planına geçişin 10 kat fiyat artışı gerektirmesi.
  - **Ajan Trafiğinde Öngörülemeyen Aşım Faturaları:** Çok adımlı ajan çağrılarında log ve depolama aşım ücretlerinin sabit paket fiyatını hızla aşması.
- **Kaynaklar:**
  - https://www.helicone.ai/pricing
  - https://github.com/Helicone/helicone

### 3.6 TrueFoundry AI Gateway (`truefoundry.com/ai-gateway`)
- **Fiyatlandırma ve Paketler:**
  - **Developer (Ücretsiz):** **$0 / ay** — 3 kullanıcıya kadar, kullanıcı başına 10.000 istek/ay, 5 model hesabı, 5 MCP sunucusu, 1 bütçe kuralı, 7 gün log saklama.
  - **Pro Plan:** **$25 / kullanıcı / ay** — kullanıcı başına 20.000 istek/ay dahil; aşan her **100.000 istek için +$20**. Semantik önbellek, hız sınırlama, yedekli yönlendirme.
  - **Enterprise Plan:** Özel yıllık sözleşme (VPC / on-prem / air-gapped kurulum, SSO, denetim ihracı, özel guardrails).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - LLM yönlendirme ile MCP sunucu yetkilendirmesini tek kontrol düzleminde birleştirmesi ve <5 ms gecikme.
  - Prometheus/Grafana/Datadog uyumlu güçlü metrik ve kota yönetimi.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **Self-Hosted / VPC Kurulumun Enterprise'a Kilitlenmesi:** Ücretsiz ve $25/kullanıcı Pro katmanlarının yalnızca SaaS olması; kendi sunucusunda (on-prem/VPC) çalıştırmak isteyenlerin pahalı kurumsal lisansa mecbur bırakılması.
  - **Kurulum Karmaşıklığı:** Kubernetes merkezli mimarinin küçük/orta ölçekli geliştirici ekipleri için ağır kalması.
- **Kaynaklar:**
  - https://www.truefoundry.com/ai-gateway
  - https://www.truefoundry.com/pricing

### 3.7 CLIProxyAPI & `claude-code-proxy` Ekosistemi (`github.com/router-for-me/CLIProxyAPI`)
- **Fiyatlandırma ve Paketler:**
  - **Açık Kaynak:** **$0 / ücretsiz** (Go ve Python tabanlı topluluk projeleri; ticari SLA, faturalandırma veya kurumsal destek paketi yok).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - Halihazırda ödenen Claude Pro/Max, ChatGPT Plus/Pro (Codex), Gemini CLI ve Antigravity aboneliklerini üçüncü parti IDE ve araçlarda (`Authorization: Bearer`) kullanabilme imkânı.
  - `Cli-Proxy-API-Management-Center` (port 8317) ile yerel görsel yapılandırma ve log izleme.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **Akış (Streaming) ve Araç Çağırma Kırılmaları (Issue #1620, #3897):** Yanıtların parça parça akmak yerine tek seferde tamponlanarak gelmesi, Anthropic ↔ OpenAI araç şeması çevirisinde kırılmalar.
  - **Sıfır Güvenlik / Kota / Maliyet Muhasebesi:** CLI'nin kendi dosya/kabuk araçlarını çalıştırmasını engelleyen bir güvenlik duvarı (fail-closed tool guard) olmaması; gerçek token/USD muhasebesi, harcama tavanı, önbellek veya çok kullanıcılı faturalandırma bulunmaması.
- **Kaynaklar:**
  - https://github.com/router-for-me/CLIProxyAPI
  - https://github.com/router-for-me/CLIProxyAPI/issues/1620
  - https://github.com/1rgs/claude-code-proxy

### 3.8 Wiro AI (`wiro.ai` — Türkiye)
- **Fiyatlandırma ve Paketler:**
  - **Kullandıkça Öde (Ön Ödemeli Kredi):** Aylık zorunlu abonelik olmadan **$10, $25, $50, $100, $250** ön ödemeli bakiye yükleme; Wiro Studio için **Boost ($20)** ve **Pro ($50)** kredi paketleri.
  - **Birim Faturalandırma:** LLM'ler için token başına (`cpt` — ör. `WiroAI Turkish LLM 8B/9B`, GPT, Claude, Gemini, DeepSeek), görsel/video/ses modelleri için istek başına (`cpr`), saniye başına (`cps`) veya piksel başına (`cp-pixel`) ücretlendirme. Yalnızca başarılı (`200 OK`) işlemler bakiyeden düşülür; sunucu hataları ücretlendirilmez.
- **Kullanıcıların En Çok Övdüğü Şeyler (G2: 4,9 / 5):**
  - Türkiye'deki geliştirici ve ajanslar için tek API ve tek fatura katmanıyla hem Türkçe LLM'lere hem de global modellere erişim.
  - Görev durumu için güvenilir webhook callback yapısı, MCP inceleme desteği ve hızlı yerel mühendislik desteği.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - **Geliştirici Olmayanlar İçin Arayüz ve İlk Kurulum Eksikleri:** API öncelikli olduğu için teknik olmayan ekip üyelerinin kullanabileceği hazır operasyon/maliyet panosunun sınırlı kalması ve başlangıç dokümantasyonunda karşılaştırmalı örneklerin azlığı.
  - **CLI Abonelik Köprüsü veya Yerel (Self-Hosted) Ağ Geçidi Olmaması:** Yalnızca bulut API pazaryeri olarak çalışması; ekiplerin kendi mevcut Claude Code / Copilot / Kiro / Codex CLI aboneliklerini veya yerel VPC modellerini birleştiren hibrit bir geçit sunmaması.
- **Kaynaklar:**
  - https://wiro.ai/pricing
  - https://wiro.ai/docs/pricing
  - https://www.g2.com/products/wiro-ai/reviews


### 3.9 Bifrost by Maxim AI & TensorZero (`getbifrost.ai` / `tensorzero.com`)
- **Fiyatlandırma ve Paketler:**
  - **Açık Kaynak (Apache 2.0):** **$0 / ücretsiz** (Go/Rust yüksek performanslı kendi kendine barındırılan gateway).
  - **Maxim AI Enterprise / Bulut:** Özel kurumsal lisanslama (gelişmiş değerlendirme, semantik önbellek, devre kesici ve A/B deney yönetimi).
- **Kullanıcıların En Çok Övdüğü Şeyler:**
  - **Otomatik Devre Kesici (Circuit Breaker) ve Öz-İyileştirme:** Çöken sağlayıcı bacaklarını her istekte tekrar denemek yerine soğuma süresince (`cooldown`) otomatik devre dışı bırakıp yarı-açık (`half-open`) probla geri alması.
  - **JSON Şema Zorlama ve Semantik Önbellek:** `response_format: { type: "json_schema" }` doğrulaması ve yüksek benzerlikli müşteri sorgularında semantik önbellek isabeti.
- **Kullanıcıların En Çok Şikâyet Ettiği Şeyler:**
  - TensorZero açık kaynak deposunun Haziran 2026'da salt-okunur arşive alınması ve CLI aboneliklerini (Claude Code, Codex, Kiro vb.) desteklememeleri.
- **Kaynaklar:**
  - https://getbifrost.ai
  - https://github.com/tensorzero/tensorzero

---

## 4. Stratejik Sonuç: Keysmith'in Benzersiz Konumu ve Kapatılacak Eksikler

1. **Keysmith'in Rakiplerde Olmayan Üstünlüğü:**
   - Hiçbir kurumsal AI Gateway (OpenRouter, LiteLLM, Portkey, Cloudflare, Helicone, TrueFoundry, Wiro AI) **mevcut kodlama CLI aboneliklerini** (Claude Code, Codex, OpenCode, Kiro, Qoder, Command Code, Copilot, Antigravity) **HTTP API sağlayıcılarıyla aynı failover zincirinde, fail-closed araç güvenliğiyle (`BRIDGE` + `EMULATE`) ve UHP (`2026-10-19`) standardında** birleştirmiyor.
   - Açık kaynak CLI vekilleri (`CLIProxyAPI`, `claude-code-proxy`) ise kurumsal güvenlik, gerçek token/maliyet muhasebesi, bütçe tavanı, önbellek, hız sınırlama ve ticari faturalandırmadan tamamen yoksun.
   - Üstelik Keysmith **sıfır bağımlılıklı (zero-dependency Node 20+)** mimarisiyle LiteLLM'in 4 GB RAM + Postgres/Redis yükünü ve tedarik zinciri riskini tamamen ortadan kaldırıyor.

2. **Rakiplerden Alınarak Kapatılacak Eksikler (`Yok` ve `Kısmi` Kalemler):**
   - **Yok → Var (3 Kalem):**
     1. **Yanıt Önbellekleme (`Response Cache`):** Tekrarlayan deterministik isteklerde $0 maliyet ve <2 ms yanıt (`X-Keysmith-Cache: HIT|MISS`, TTL, bypass, önbellek tasarruf istatistiği).
     2. **Müşteri/Kiracı Faturalandırma, Ön Ödemeli Kredi Cüzdanı, Paket Yönetimi ve iyzico Ödeme Soyutlaması:** Türkiye (TL + KDV fatura kaydı, iyzico ödeme soyutlaması) ve Global (USD) için paket tanımları, ön ödemeli kredi cüzdanı, kullanım düşümü, fatura defteri (`billing ledger`) ve self-serve API uçları.
     3. **Merkezi Prompt Şablonları & Sürümleme (`Prompt Registry`):** `{{değişken}}` yerleştirmeli, sürümlü prompt şablonları (`/v1/keysmith/prompts` ve isteklerde `prompt_id` / `prompt_variables` desteği).
   - **Kısmi → Var (5 Kalem):**
     4. **Kısa Süreli Hız Sınırlama (`RPM` / `TPM` Rate Limiting & `X-RateLimit-*` Başlıkları):** Anahtar ve kiracı bazında dakika başı istek (`rpm`) ve token (`tpm`) sınırları, `X-RateLimit-Limit-*`, `X-RateLimit-Remaining-*`, `X-RateLimit-Reset-*` ve `Retry-After` başlıkları.
     5. **Ağırlıklı Yük Dengeleme & En Düşük Gecikme/Maliyet Yönlendirmesi:** Alias ve yönlendirme katmanında `weighted` (yüzdesel ağırlık), `least-latency` (canlı EWMA gecikme) ve `least-cost` (en ucuz bacak) stratejileri.
     6. **KVKK / GDPR Kişisel Veri (PII) Maskeleme & Prompt Injection Güvenlik Duvarı (`Guardrails`):** İstek ve yanıtlarda TCKN, kredi kartı (Luhn), IBAN (TR), telefon, e-posta maskeleme (`mask`) veya engelleme (`block`) ile prompt-injection kalkanı.
     7. **Prometheus `/metrics` Uç Noktası & İmzalı Bütçe/Hata Webhook Bildirimleri:** Prometheus metrik ihracı (`GET /metrics` veya `GET /v1/keysmith/metrics`) ve harcama tavanı (%80 uyarı / %100 blok) veya ardışık hata durumunda HMAC-SHA256 imzalı HTTP webhook bildirimi.
     8. **Operasyonel Web Kontrol Paneli (TR/EN, Mobil Uyumlu, `ui-quality` Standardında):** Durum, maliyet/tasarruf, önbellek, guardrail, prompt şablonları ve paket/fatura görünümünü kapsayan, 390px/1000px/1440px taşmasız, çift dilli (TR/EN) operasyon konsolu.

3. **2. Dalga (14 Kasım 2026) — Rakiplerden Tespit Edilen Yeni `Yok` ve `Kısmi` Özellikler:**
   - İlk dalgadaki 8 kalem (`P0-1..P0-4`, `P1-1..P1-3`, `P2-1`) eksiksiz tamamlandıktan sonra Portkey, LiteLLM, TrueFoundry, OpenRouter ve Bifrost/TensorZero karşılaştırmasıyla 3 yeni gelir ve güvenilirlik özelliği çıkarılmıştır:
     1. **P2-2 (Matris #16 — Kısmi → Var): Semantik Benzerlik Önbelleklemesi (`Semantic Cache`):** Birebir SHA-256 eşleşmesi dışında karakter/kelime N-gram kosinüs benzerliği (`semanticThreshold`, varsayılan `0.88`) ile yakın sorguları yakalayıp `X-Keysmith-Cache: SEMANTIC-HIT` ve `X-Keysmith-Cache-Similarity` başlığıyla $0 maliyete indirme.
     2. **P2-3 (Matris #17 — Kısmi → Var): Otomatik Devre Kesici (`Circuit Breaker`) ve Soğuma (`Cooldown`):** Ardışık hata (`failureThreshold`) veren adaptör/model bacaklarını `open` durumuna alıp `cooldownMs` boyunca anında atlama (`circuit_open`), süre dolunca `half-open` tekil deneme ile öz-iyileştirme ve `GET /v1/keysmith/breakers` ile durum izleme/sıfırlama.
     3. **P2-4 (Matris #18 — Yok → Var): Yapılandırılmış Çıktı (`Structured Output / JSON Schema`) Doğrulama ve Otomatik Onarım (`Response Healing`):** `response_format: { type: "json_object" | "json_schema" }` isteklerinde Markdown kod çitlerini otomatik temizleme, JSON ayrıştırma ve şema doğrulaması (`required`, `properties`, `enum`, `type`), geçersiz yanıtta otomatik onarım veya sonraki failover bacağına geçiş.
