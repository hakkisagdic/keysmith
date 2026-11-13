# Keysmith — Design System (`DESIGN.md`)

Read `DESIGN.md` first before touching any HTML or CSS in `src/status-page.js`; do not ship a screen that breaks it.
Outside tools that install hooks, download binaries, or phone home (`impeccable`, `.hallmark`) are strictly excluded.

---

## 0. Surface Mode

- **Operate** (`GET /`, `GET /status`, and the gateway key login screen): dense operational workbench for inspecting live adapter routes, failover chains, deterministic cache savings, KVKK/GDPR guardrail counters, tenant billing wallets, and prompt templates. Controls stay standard; the direction sets typography, Forged Workshop Slate + Brass palette, tabular density, and one signature move.

---

## 1. Direction (Five Lines)

- **Product:** Keysmith — local-first, KVKK-compliant multi-protocol LLM gateway and CLI credential broker used by platform engineers, AI agency leads, and self-hosted enterprise teams.
- **Character:** Brass-stamped, ledger-dense, deterministic.
- **World:** Cloudflare AI Gateway (tabular telemetry and route health clarity), Stripe Workbench (ledger-grade billing, wallet balances, and webhook inspection), Mullvad VPN Console (zero-telemetry dark slate and brass workshop discipline).
- **Moments:** The live route/failover and cost-savings ledger on `/`, and the zero-URL-leak gateway key vault door.
- **Signature:** A forged brass key-slot rule (`2px solid var(--accent-brass)`) with tabular ledger strips that pair upstream route health, deterministic cache savings, KVKK guardrail counters, and tenant balances on one dense operational sheet without nested cards.

---

## 2. Tokens

### Typography
- **Font pair:**
  - **UI & Ledger Body (`--font-sans`):** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` — used for all headings, prose, labels, table cells, identifiers, counts, and timestamps with `font-variant-numeric: tabular-nums` (**F9**).
  - **Command Syntax (`--font-mono`):** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` — used strictly for inline CLI command snippets (`<code>keysmith doctor</code>`).
- **Type scale (5 sizes max):**
  - `--text-xs`: `12px` / `1.4` (minimum allowed size; never below `12px` per **F15**)
  - `--text-sm`: `13px` / `1.45` (table cells, metadata, pills)
  - `--text-base`: `14px` / `1.5` (body copy, controls, form inputs)
  - `--text-lg`: `16px` / `1.35` (section headings `h2`, stat values)
  - `--text-xl`: `22px` / `1.25` (workbench masthead `h1`)
- **Weights:** `400` (regular), `500` (medium), `600` (semibold max; never `700+` black/extra-bold per **F4**).

### Spacing & Measure
- **Scale (4/8 multiples):** `4px`, `8px`, `12px`, `16px`, `24px`, `32px`, `40px`.
- **Heading rhythm:** `24px` above `h2`, `8px` below `h2`.
- **Measure:** Page guide and body copy span full content width (`max-width: 1200px` container) with readable prose measure (`65–75ch` inside wide blocks per **F7** & **F23**).

### Radii & Borders
- **Outer radius:** `6px` (`--radius-md`) for panels, tables, and controls.
- **Inner radius:** `4px` (`--radius-sm`) for inline pills and code tags.
- **Shadows:** `none` (borders only).

### Colour Palette (Forged Workshop Slate + Brass)
- **Canvas (`--bg-canvas`):** `#0b0e13`
- **Surface (`--bg-surface`):** `#121721`
- **Row Hover (`--bg-hover`):** `#181f2c`
- **Hairline Border (`--border-hairline`):** `rgba(230, 235, 242, 0.09)` (`#21293a`)
- **Strong Border (`--border-strong`):** `#2d384f`
- **Primary Ink (`--text-primary`):** `#e6ebf2` (contrast 15.6:1 on canvas)
- **Secondary Ink (`--text-muted`):** `#94a0b8` (contrast 6.8:1 on canvas, >= 4.5:1 per **F15**)
- **Primary Accent (`--accent-brass`):** `#d4a24c` (Forged Brass)
- **On-Accent Ink (`--on-accent`):** `#0b0e13` (contrast 8.9:1 on `#d4a24c` per **F15**)
- **Semantic Status:**
  - `--status-ok`: `#4fd18b`
  - `--status-bad`: `#f07171`

### Controls, Tabular Figures & Motion
- **Control height:** `36px` uniform across every row (`input`, `button`, language switch links); touch target area `>= 44px` on mobile (`390px`).
- **Tabular figures:** `font-variant-numeric: tabular-nums` on `.n`, `.card b`, and all table numeric columns.
- **Data formatting (`C4`):**
  - English (`?lang=en`): `en-US` number formatting (`1,250`), `$12.50` / `₺431.25`.
  - Turkish (`?lang=tr`): `tr-TR` number formatting (`1.250`), `431,25 ₺` / `$12,50`.
- **Motion:** `transition: color 150ms cubic-bezier(0.22, 1, 0.36, 1), background-color 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)` (never `transition: all` per **F14**), disabled under `@media (prefers-reduced-motion: reduce)`.
- **Browser surfaces:** `::selection` in Forged Brass (`rgba(212, 162, 76, 0.28)`), `caret-color: #d4a24c`, `:focus-visible` outline `2px solid #d4a24c` with `2px` offset.

---

## 3. Components

1. **Masthead & Language Switcher (`header.masthead`):** Displays brand mark (`keysmith`), operational subtitle, active viewer scope notice, and `?lang=tr` / `?lang=en` URL-driven language toggle.
2. **Metric Strip (`.grid > .card`):** Flat 1-level bordered cells (`#121721`) with top brass key-slot accent rule on primary operational KPIs. Never nest cards inside cards (**F2**).
3. **Scroll-Safe Data Tables (`.table-wrap > table`):** Horizontal scroll wrapper on narrow viewports so the document never exceeds `innerWidth` at `390px`, `1000px`, or `1440px` (**F16**). Right-aligned numeric columns (`.n`), distinct header and `:hover` row states (**F12**).

---

## 4. Banned Patterns

- **F1:** No `text-transform: uppercase` on headings (`h2`), table headers (`th`), or labels.
- **F2:** No card-inside-card or left-stripe callout boxes.
- **F3:** No gradients, neon glows, glassmorphism, emoji icons, or purple-blue default accents (`#7c8cff`).
- **F9:** No monospace font for general table identifiers, counts, or dates.
- **F14:** No `transition: all` or hover scale transforms.
- **F15:** No text smaller than `12px`; no missing `:focus-visible` styles.
- **F16:** Zero horizontal page overflow (`document.documentElement.scrollWidth <= window.innerWidth`) at `390px`, `1000px`, and `1440px`.

---

## 5. Content Rules

- **C1:** Section titles and action buttons never repeat the same words.
- **C3:** Labels and buttons never end with `!` or a trailing period.
- **C4:** Numbers, currencies, and labels follow the selected UI language (`tr` or `en`), while model IDs, adapter IDs, and key fingerprints (`fp:...`) remain exact catalogue identifiers.

---

## 6. Waivers

- `W-01` (**C3** / diagnostic prefix, `src/status-page.js`, 2026-11-13): Diagnostic scope warning rows retain the leading `! ` prefix (`! deny "Claude-API" names no configured adapter...`) because `test/scopes.test.js` pins that exact diagnostic string for CLI/status parity.
