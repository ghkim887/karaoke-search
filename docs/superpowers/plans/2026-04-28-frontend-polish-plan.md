# Frontend Polish & Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the karaoke search frontend with category tints, typography refinements, hover polish, mobile-first tap targets, a footer with build-time DB date, device-local favorites, UI language flip from KR/JP to KR/EN, source-link removal, and a loading-state mitigation that renders the empty state immediately.

**Architecture:** Pure additive Astro+Preact changes. New `useFavorites()` hook reads/writes `localStorage`. New `Footer.astro` component with build-time `git log` injection of DB date. All other changes are CSS additions to `index.astro` global styles plus surgical edits to existing Preact components. No new dependencies, no schema changes.

**Tech Stack:** Astro 4.x · Preact 10.x · MiniSearch · Vitest · TypeScript · Biome · vanilla CSS.

**Pre-flight environment notes:**

- The web workspace's `vitest.config.ts` uses `environment: 'node'`. Tests that touch `localStorage` or render Preact components MUST opt into jsdom either via a `// @vitest-environment jsdom` file-level pragma at the top of the test file or via a per-file env flag. `jsdom` is already a devDependency of `@karaoke/web`, so no install is needed.
- The current record count baked into `apps/web/public/data/songs.json` is **26,401**. Tasks that hard-code the count refer to this number. If the count drifts before the plan ships, replace the literal everywhere it appears in this plan and in the implementation.
- Use `corepack pnpm` for every command. Plain `pnpm` is not on PATH on the Windows host this repo is developed on.

---

## Task 1: Remove the source link from `ResultCard`

**Files:**
- Modify: `apps/web/src/components/ResultCard.tsx` (delete lines 82–90, the `<a class="result-source">…</a>` block)
- Modify: `apps/web/src/pages/index.astro` (delete the `.result-source` and `.result-source:hover` rules at lines 306–316)
- Modify: `apps/web/public/data/songs.json` — UNCHANGED (verify only)

- [ ] **Step 1: Verify `source_url` is still present in the schema and data**

Run:

```bash
corepack pnpm exec node -e "const s=require('@karaoke/schema'); console.log(typeof s.validateSongRecord)"
grep -c '"source_url"' apps/web/public/data/songs.json
```

Expected: the second command prints a number ≥ 1 (the field is present in every record). Do NOT alter the schema or data.

- [ ] **Step 2: Edit `ResultCard.tsx` — delete the `<a class="result-source">` block**

Replace lines 82–90 (the entire `<a … >Source ↗</a>` element) with nothing. The closing `</article>` immediately follows the `</div>` that closes `.result-numbers`.

After edit, the bottom of the JSX returned by `ResultCard` should read:

```tsx
      <div class="result-numbers">
        <NumberBadge label="TJ" value={record.karaoke_numbers.tj} testId="badge-tj" />
        <NumberBadge label="KY" value={record.karaoke_numbers.ky} testId="badge-ky" />
        <NumberBadge label="JOY" value={record.karaoke_numbers.joysound} testId="badge-joysound" />
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Edit `index.astro` — delete the `.result-source` CSS rules**

Remove the two CSS blocks at lines 306–316:

```css
      .result-source {
        align-self: flex-start;
        margin-top: 0.25rem;
        color: var(--accent);
        text-decoration: none;
        font-size: 0.85rem;
      }

      .result-source:hover {
        text-decoration: underline;
      }
```

- [ ] **Step 4: Grep the workspace to confirm no stragglers**

Run:

```bash
grep -rn "result-source\|Source ↗" apps/web/src
```

Expected: zero hits.

- [ ] **Step 5: Update or delete any test that references the removed nodes**

Run:

```bash
grep -rn "result-source\|Source ↗" apps/web
```

If a test (e.g. an e2e in `tests/e2e/**` or a vitest in `apps/web/src/**`) asserts on either string, delete that assertion in the same edit. As of HEAD `e512456` this grep returns no test hits, but re-run before continuing.

- [ ] **Step 6: Run biome + build**

Run:

```bash
corepack pnpm exec biome check apps/web/src/components/ResultCard.tsx apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard (`scripts/check-bundle-size.mjs`) passes — gzipped island ≤ 50 KB.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/ResultCard.tsx apps/web/src/pages/index.astro
git commit -m "ui(web): remove unused source link from result card"
```

---

## Task 2: Bilingual UI flip — Korean/Japanese → Korean/English

**Files:**
- Modify: `apps/web/src/components/App.tsx:128` (loading line)
- Modify: `apps/web/src/components/EmptyState.tsx:27` (placeholder line)
- Modify: `apps/web/src/components/NoResults.tsx:8` (no-results title)
- Modify: `apps/web/src/components/ErrorState.tsx:13–15` (error headline)
- Test: any existing `apps/web/src/**/*.test.{ts,tsx}` that asserts on these strings (run grep below first to confirm none exist today)

- [ ] **Step 1: Grep for every Japanese string in the JSX/TSX layer**

Run:

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected hits at HEAD `e512456` (these are the targets — no others should appear):

- `App.tsx:128` — `검색 인덱스 로딩 중 / 検索インデックス読み込み中…`
- `EmptyState.tsx:27` — `아직 없음 / まだなし`
- `NoResults.tsx:8` — `검색 결과가 없습니다 / 該当なし`
- `ErrorState.tsx:14` — `데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. / データの読み込みに失敗しました。`
- `data/featured.ts` lines 15–17 — Japanese artist *names* (do NOT touch; these are content, not UI chrome).

Korean-only labels (e.g. `aria-label="가라오케 검색"`, `placeholder="곡명/가수명"`, the page title `노래방 검색기`, `legend` text `머신 필터`/`카테고리 필터`, the toast `복사됨`) stay Korean — the spec's bilingual flip applies to bilingual strings only.

- [ ] **Step 2: Edit `App.tsx:128` — flip the loading line**

Note: the actual visible text used in production is replaced again in **Task 9** (Loading state with 3-dot animation). For now do a literal flip so the codebase has zero Japanese strings between Task 2 and Task 9 landing.

```diff
-        <p class="loading">검색 인덱스 로딩 중 / 検索インデックス読み込み中…</p>
+        <p class="loading">검색 인덱스 로딩 중 / Loading search index…</p>
```

- [ ] **Step 3: Edit `EmptyState.tsx:27` — flip the placeholder**

```diff
-              <p class="empty-section-placeholder">아직 없음 / まだなし</p>
+              <p class="empty-section-placeholder">아직 없음 / Not yet</p>
```

- [ ] **Step 4: Edit `NoResults.tsx:8` — flip the no-results title**

```diff
-      <p class="no-results-title">검색 결과가 없습니다 / 該当なし</p>
+      <p class="no-results-title">검색 결과가 없습니다 / No matches</p>
```

- [ ] **Step 5: Edit `ErrorState.tsx:13–15` — flip the error headline**

```diff
-      <p class="error-state-headline">
-        데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. / データの読み込みに失敗しました。
-      </p>
+      <p class="error-state-headline">
+        데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. / Failed to load data. Please try again shortly.
+      </p>
```

- [ ] **Step 6: Re-grep — must return zero JSX/TSX hits**

Run:

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: empty output (no hits in components or pages). Hits in `data/featured.ts` are content, not UI strings — they are out of scope.

- [ ] **Step 7: Update vitest tests if any reference the old strings**

Run:

```bash
grep -rnE "検索インデックス|まだなし|該当なし|データの読み込み" apps/web
```

Expected: zero hits. If any appear in a test file, swap to the new English half in the same edit before committing.

- [ ] **Step 8: Run biome + build + test**

```bash
corepack pnpm exec biome check apps/web/src
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: biome 0 errors. Vitest: 18/18 passing (the existing baseline). Build clean, bundle under 50 KB.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/EmptyState.tsx apps/web/src/components/NoResults.tsx apps/web/src/components/ErrorState.tsx
git commit -m "ui(web): flip bilingual UI strings from KR/JP to KR/EN"
```

---

## Task 3: Category badge color tinting

**Files:**
- Modify: `apps/web/src/components/ResultCard.tsx` (line 72: add per-category class onto the category badge)
- Modify: `apps/web/src/pages/index.astro` (add `.badge-category-{jpop,vocaloid,anime}` rules in `<style is:global>`)

This is a CSS + tiny JSX edit. There is no testable behavior change beyond a visual tint, so this follows the **Pure-CSS task pattern** with a single tiny JSX edit appended.

- [ ] **Step 1: Add the three CSS rules to `index.astro`**

Insert immediately after the existing `.badge-category` rule (currently at lines 249–251) inside `<style is:global>`:

```css
      .badge-category-jpop {
        color: #8ab4ff;
        border-color: color-mix(in srgb, #8ab4ff 40%, var(--border));
      }

      .badge-category-vocaloid {
        color: #c89bff;
        border-color: color-mix(in srgb, #c89bff 40%, var(--border));
      }

      .badge-category-anime {
        color: #ffb37a;
        border-color: color-mix(in srgb, #ffb37a 40%, var(--border));
      }
```

The base `.badge` background/padding/font-size still applies; only `color` and `border-color` are overridden per category. Do NOT touch the base `.badge` `background` token (spec says background stays unchanged).

- [ ] **Step 2: Edit `ResultCard.tsx:72` — append the per-category class**

```diff
-          <span key={c} class="badge badge-category">
+          <span key={c} class={`badge badge-category badge-category-${c}`}>
             {c}
           </span>
```

`c` is typed `Category = 'jpop' | 'vocaloid' | 'anime'` (per `@karaoke/schema`), so the resulting class is always one of the three rules above.

- [ ] **Step 3: Manual visual verification**

Run:

```bash
corepack pnpm --filter @karaoke/web dev
```

Open `http://localhost:4321/karaoke-search/`, search for any record (e.g. `YOASOBI`), confirm the category badge tints to soft blue/lavender/peach matching the spec table. Stop the dev server with Ctrl-C.

- [ ] **Step 4: Run biome + build**

```bash
corepack pnpm exec biome check apps/web/src/components/ResultCard.tsx apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ResultCard.tsx apps/web/src/pages/index.astro
git commit -m "ui(web): tint category badges per spec table"
```

---

## Task 4: Typography refinements (h1, result-title, badge-number)

**Files:**
- Modify: `apps/web/src/pages/index.astro` (h1, `.result-title`, `.badge-number` desktop font-size)

Pure CSS, no behavior change.

- [ ] **Step 1: Edit `header.site-header h1` (lines 56–61)**

```diff
       header.site-header h1 {
         margin: 0 0 0.75rem;
-        font-size: 1.25rem;
-        font-weight: 600;
-        letter-spacing: 0.01em;
+        font-size: 1.4rem;
+        font-weight: 650;
+        letter-spacing: -0.01em;
       }
```

- [ ] **Step 2: Edit `.result-title` (lines 219–224)**

```diff
       .result-title {
         margin: 0;
         font-size: 1.05rem;
-        font-weight: 600;
+        font-weight: 650;
         line-height: 1.35;
       }
```

- [ ] **Step 3: Edit `.badge-number` desktop font-size (line 264)**

```diff
       .badge-number {
         position: relative;
         font: inherit;
         font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
-        font-size: 0.82rem;
+        font-size: 0.86rem;
         padding: 0.3rem 0.6rem;
         border-radius: 4px;
         border: 1px solid var(--border-strong);
         background: var(--bg-elev);
         color: var(--fg);
         cursor: pointer;
       }
```

(The mobile-only `0.95rem` rule lives inside an `@media (max-width: 719px)` block added in **Task 8** — do not add the mobile rule here.)

- [ ] **Step 4: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev` then load `http://localhost:4321/karaoke-search/`. Confirm the page title is slightly larger and tighter, the result-title tracks heavier without looking blocky, and the badge-number text is 1 px crisper. Stop dev server.

- [ ] **Step 5: Run biome + build**

```bash
corepack pnpm exec biome check apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/index.astro
git commit -m "ui(web): refine typography for header, result title, and number badge"
```

---

## Task 5: Result card hover and shadow

**Files:**
- Modify: `apps/web/src/pages/index.astro` (`.result-card` block at lines 208–217 plus a new `.result-card:hover` block)

Pure CSS, no behavior change.

- [ ] **Step 1: Edit `.result-card` to add baseline shadow + transition**

Replace the existing `.result-card` block (lines 208–217) with:

```css
      .result-card {
        position: relative;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1rem 1.1rem;
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
        transition:
          transform 120ms ease,
          box-shadow 120ms ease,
          border-color 120ms ease;
      }

      .result-card:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 10px rgba(0, 0, 0, 0.45);
        border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
      }
```

Do NOT remove `position: relative` — the favorite-star button (Task 12) is absolutely positioned against this card.

- [ ] **Step 2: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, search for any record, hover a result card on desktop. Confirm a 1 px lift, a heavier dropshadow, and an accent-tinted border within ~120 ms. Stop dev server.

- [ ] **Step 3: Run biome + build**

```bash
corepack pnpm exec biome check apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/index.astro
git commit -m "ui(web): add hover lift + shadow polish to result cards"
```

---

## Task 6: Search input polish (icon, padding, focus halo, enterkeyhint)

**Files:**
- Modify: `apps/web/src/components/SearchBox.tsx` (wrap the input in a `<div class="search-input-wrap">` with an inline SVG icon; add `enterkeyhint="search"`)
- Modify: `apps/web/src/pages/index.astro` (update `input.search-input` rules; add `.search-input-wrap` and `.search-input-icon` rules)

Pure CSS + small structural JSX edit. No new behavior.

- [ ] **Step 1: Edit `SearchBox.tsx` — wrap the input and add the icon**

Replace the entire return block:

```tsx
  return (
    <div class="search-input-wrap">
      <svg
        class="search-input-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M10 4a6 6 0 1 0 3.873 10.59l4.768 4.768 1.414-1.415-4.768-4.767A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          fill="currentColor"
        />
      </svg>
      <input
        class="search-input"
        type="search"
        aria-label="가라오케 검색"
        placeholder="곡명/가수명"
        autocomplete="off"
        spellcheck={false}
        enterkeyhint="search"
        value={value}
        onInput={handleInput}
      />
    </div>
  );
```

(`enterkeyhint` is a standard HTML attribute; Preact passes lowercase HTML attributes through verbatim. If TypeScript complains because the JSX type doesn't list it, add `// @ts-expect-error preact JSX missing enterkeyhint` directly above the `<input>` opening tag — or, if Astro's tsconfig allows index signatures on JSX, no suppression is needed. Re-run `corepack pnpm exec tsc --noEmit` to confirm; if it errors, add the suppression.)

- [ ] **Step 2: Edit `input.search-input` and add wrap + icon rules in `index.astro`**

Replace the existing `input.search-input` and `input.search-input:focus` blocks (lines 63–77) with:

```css
      .search-input-wrap {
        position: relative;
        max-width: 640px;
      }

      .search-input-icon {
        position: absolute;
        top: 50%;
        left: 0.9rem;
        transform: translateY(-50%);
        color: var(--fg-muted);
        pointer-events: none;
      }

      input.search-input {
        width: 100%;
        max-width: 640px;
        padding: 0.7rem 1rem 0.7rem 2.4rem;
        font-size: 1.05rem;
        color: var(--fg);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        outline: none;
      }

      input.search-input:focus {
        border: 2px solid var(--accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
      }
```

(The 2 px focus border replaces the 1 px border edge; the 3 px halo is the `box-shadow`. Together they read as a focus ring without layout shift.)

- [ ] **Step 3: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, focus the input. Confirm: search-glass icon at left, 16 px font (no iOS pinch-zoom), accent border + 3 px halo on focus. On a phone or DevTools Device Mode, confirm the on-screen keyboard's enter glyph is the magnifier (`enterkeyhint="search"`). Stop dev server.

- [ ] **Step 4: Run biome + typecheck + build**

```bash
corepack pnpm exec biome check apps/web/src/components/SearchBox.tsx apps/web/src/pages/index.astro
corepack pnpm --filter @karaoke/web exec astro check
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SearchBox.tsx apps/web/src/pages/index.astro
git commit -m "ui(web): polish search input with icon, focus halo, enterkeyhint"
```

---

## Task 7: Empty-state section title polish

**Files:**
- Modify: `apps/web/src/components/EmptyState.tsx` (per-section class on the `<h2 class="empty-section-title">`)
- Modify: `apps/web/src/pages/index.astro` (typography refinement on `.empty-section-title` plus three per-category color/border rules)

Pure CSS + tiny JSX edit.

- [ ] **Step 1: Edit `EmptyState.tsx` — add per-section class to the title**

```diff
-          <section key={section.key} class="empty-section">
-            <h2 class="empty-section-title">{section.label}</h2>
+          <section key={section.key} class="empty-section">
+            <h2 class={`empty-section-title empty-section-title-${section.key}`}>{section.label}</h2>
```

`section.key` is `'jpop' | 'vocaloid' | 'anime'`, matching the same three tints used on category badges.

- [ ] **Step 2: Edit `index.astro` — refine `.empty-section-title` and add per-category rules**

Replace the existing `.empty-section-title` block (lines 141–146) with:

```css
      .empty-section-title {
        margin: 0 0 0.5rem;
        font-size: 1rem;
        color: var(--fg-muted);
        font-weight: 650;
        letter-spacing: -0.005em;
        border-left: 3px solid var(--border-strong);
        padding-left: 0.6rem;
      }

      .empty-section-title-jpop {
        color: #8ab4ff;
        border-left-color: #8ab4ff;
      }

      .empty-section-title-vocaloid {
        color: #c89bff;
        border-left-color: #c89bff;
      }

      .empty-section-title-anime {
        color: #ffb37a;
        border-left-color: #ffb37a;
      }
```

- [ ] **Step 3: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, confirm the empty state shows three section titles each in its own tint with a matching 3 px left border. Stop dev server.

- [ ] **Step 4: Run biome + build**

```bash
corepack pnpm exec biome check apps/web/src/components/EmptyState.tsx apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/EmptyState.tsx apps/web/src/pages/index.astro
git commit -m "ui(web): tint empty-state section titles with category accent"
```

---

## Task 8: Mobile tap-target audit (≥44 pt)

**Files:**
- Modify: `apps/web/src/pages/index.astro` (extend the existing `@media (min-width: 720px)` block AND add a new `@media (max-width: 719px)` block)

Pure CSS, mobile-first.

- [ ] **Step 1: Add the mobile media query block**

Insert this block immediately after the existing `@media (min-width: 720px)` block (currently at lines 198–202 in `index.astro`):

```css
      @media (max-width: 719px) {
        .chip {
          min-height: 44px;
          padding: 0.55rem 1rem;
        }

        .featured-chip {
          min-height: 44px;
          padding: 0.55rem 1rem;
        }

        .chip-group {
          gap: 0.6rem;
        }

        .badge-number {
          min-height: 44px;
          padding: 0.6rem 0.8rem;
          font-size: 0.95rem;
          font-weight: 500;
          border-width: 1.5px;
        }

        .badge-toast {
          font-size: 0.85rem;
        }

        .result-numbers {
          gap: 0.5rem;
          padding: 0.4rem 0;
        }

        .favorite-star {
          min-width: 44px;
          min-height: 44px;
        }
      }
```

Notes:

- The 1.5× vertical padding on the number-row container is achieved via `padding: 0.4rem 0` on `.result-numbers` (baseline `margin-top: 0.15rem` already exists).
- `.favorite-star` is added in **Task 12**; declaring it here is fine — the rule has no effect until the element exists.
- `border-width: 1.5px` is a direct override of the desktop `border: 1px solid var(--border-strong)` — keeps color, bumps width.

- [ ] **Step 2: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, open Chrome DevTools Device Mode at "iPhone 14 Pro" (or any ≤719 px width preset), search for any record. With DevTools' "Inspect element" hover-measure: chips ≥44 px tall, vendor chips ≥44 px tall, number badges ≥44 px tall and ≥44 px wide, toast text legible. Stop dev server.

- [ ] **Step 3: Run biome + build**

```bash
corepack pnpm exec biome check apps/web/src/pages/index.astro
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/index.astro
git commit -m "ui(web): mobile tap-target audit (>=44pt) and number-row emphasis"
```

---

## Task 9: Loading state with 3-dot animation

**Files:**
- Modify: `apps/web/src/components/App.tsx` (replace the loading text with a structured span + 3 dot spans; inject the build-time count via a constant)
- Modify: `apps/web/src/pages/index.astro` (add `@keyframes karaoke-dot-cycle` and `.loading-dot` rules)

This task has a small testable behavior (the rendered text contains the literal `26,401`), so it follows the TDD pattern.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App loading state', () => {
  let host: HTMLElement;

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the build-time record count and a 3-dot animation slot', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    const loading = host.querySelector('.loading');
    expect(loading).not.toBeNull();
    // The literal record count (currently 26,401) appears in the text.
    expect(loading?.textContent).toMatch(/26,401곡 검색 인덱스 빌드 중/);
    expect(loading?.textContent).toMatch(/Building 26,401-song index/);
    // Three loading-dot spans inside the loading paragraph.
    expect(loading?.querySelectorAll('.loading-dot').length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/App.test.tsx
```

Expected: FAIL — current `App.tsx` renders the literal `검색 인덱스 로딩 중 / Loading search index…` (post-Task 2) with no `.loading-dot` elements. The first regex match fails.

- [ ] **Step 3: Add the build-time count constant + new loading markup to `App.tsx`**

At the top of `App.tsx`, immediately after the existing imports, add:

```tsx
const SONG_COUNT_DISPLAY = '26,401';
```

This is the simplest hard-coded approach matching the spec ("hard-coded literal inserted at build time"). The plan documents the manual update step (Step 4) so the literal stays in sync with `songs.json.length`.

Replace the loading paragraph (currently `<p class="loading">검색 인덱스 로딩 중 / Loading search index…</p>` post-Task 2) with:

```tsx
        <p class="loading">
          {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
        </p>
```

- [ ] **Step 4: Document the count-update protocol in a code comment**

Add a comment immediately above the constant:

```tsx
// Hard-coded record count surfaced in the loading state. Update whenever
// `apps/web/public/data/songs.json` is regenerated. Keep in sync with the
// merger's final record count (currently 26,401 records).
const SONG_COUNT_DISPLAY = '26,401';
```

- [ ] **Step 5: Add the keyframes + dot rules to `index.astro`**

Insert immediately after the `main.results .error` rule (currently at lines 91–93) inside `<style is:global>`:

```css
      @keyframes karaoke-dot-cycle {
        0%,
        100% {
          opacity: 0.2;
        }
        50% {
          opacity: 1;
        }
      }

      .loading-dot {
        display: inline-block;
        animation: karaoke-dot-cycle 1.2s infinite ease-in-out;
        font-weight: 700;
      }

      .loading-dot:nth-child(1) {
        animation-delay: 0s;
      }
      .loading-dot:nth-child(2) {
        animation-delay: 0.4s;
      }
      .loading-dot:nth-child(3) {
        animation-delay: 0.8s;
      }
```

- [ ] **Step 6: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, throttle the network to "Slow 3G" in DevTools. Confirm the loading line shows `26,401곡 검색 인덱스 빌드 중 / Building 26,401-song index ...` with three dots that cycle in opacity, staggered by 0.4 s. Stop dev server.

- [ ] **Step 8: Run biome + build + full test**

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/App.test.tsx apps/web/src/pages/index.astro
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes. Vitest 19/19 passing (18 baseline + 1 new).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/App.test.tsx apps/web/src/pages/index.astro
git commit -m "ui(web): show record count and 3-dot animation while index loads"
```

---

## Task 10: Footer component with build-time DB date

**Files:**
- Create: `apps/web/src/components/Footer.astro`
- Modify: `apps/web/src/pages/index.astro` (mount `<Footer />` after `<App />` in `<body>`; add `.site-footer` CSS rules)
- Test: `apps/web/src/components/Footer.test.ts` — pure-string formatter test

The Astro frontmatter `git log` invocation has three branches (git success, env fallback, both fail). Test the pure formatter; the I/O glue is exercised at build time.

- [ ] **Step 1: Write the failing test for the date-formatter helper**

Create `apps/web/src/lib/footer-date.ts` (empty stub — implemented in Step 3):

```ts
export function formatDbDate(_gitOutput: string, _envEpoch: string | undefined): string {
  return '';
}
```

Create `apps/web/src/lib/footer-date.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDbDate } from './footer-date.js';

describe('formatDbDate', () => {
  it('returns the trimmed git short-ISO date when git output is non-empty', () => {
    expect(formatDbDate('2026-04-28\n', undefined)).toBe('2026-04-28');
  });

  it('falls back to SOURCE_DATE_EPOCH formatted as YYYY-MM-DD UTC', () => {
    // 2026-04-28T12:34:56Z = 1777768496
    expect(formatDbDate('', '1777768496')).toBe('2026-04-28');
  });

  it('returns empty string when both inputs are missing', () => {
    expect(formatDbDate('', undefined)).toBe('');
  });

  it('returns empty string when both inputs are unparseable', () => {
    expect(formatDbDate('', 'not-a-number')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/lib/footer-date.test.ts
```

Expected: FAIL on all four cases — the stub returns `''` for everything.

- [ ] **Step 3: Implement `formatDbDate` in `apps/web/src/lib/footer-date.ts`**

Overwrite the stub with:

```ts
/**
 * Format the DB-update date for the footer.
 *
 * Branches:
 *   1. `gitOutput` non-empty → return its trimmed value (already YYYY-MM-DD).
 *   2. `envEpoch` parses as a positive integer → format as YYYY-MM-DD in UTC.
 *   3. Otherwise → return ''. The Footer component then renders no date token
 *      and no leading bullet separator.
 */
export function formatDbDate(gitOutput: string, envEpoch: string | undefined): string {
  const trimmed = gitOutput.trim();
  if (trimmed.length > 0) return trimmed;
  if (envEpoch !== undefined && /^[0-9]+$/.test(envEpoch)) {
    const seconds = Number.parseInt(envEpoch, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      const d = new Date(seconds * 1000);
      const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
      const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = d.getUTCDate().toString().padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  return '';
}
```

- [ ] **Step 4: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/lib/footer-date.test.ts
```

Expected: PASS — all four cases.

- [ ] **Step 5: Create `apps/web/src/components/Footer.astro`**

```astro
---
import { execSync } from 'node:child_process';
import { formatDbDate } from '../lib/footer-date.js';

let gitOutput = '';
try {
  gitOutput = execSync(
    'git log -1 --format=%cs -- apps/web/public/data/songs.json',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
} catch {
  // git unavailable, shallow checkout, or path not in history — fall through.
}

const dbDate = formatDbDate(gitOutput, process.env.SOURCE_DATE_EPOCH);
---

<footer class="site-footer">
  <span>노래방 검색기</span>
  {dbDate !== '' && (
    <>
      <span aria-hidden="true" class="site-footer-sep">·</span>
      <span>DB 업데이트 {dbDate}</span>
    </>
  )}
  <span aria-hidden="true" class="site-footer-sep">·</span>
  <span>MIT</span>
  <span aria-hidden="true" class="site-footer-sep">·</span>
  <a
    class="site-footer-link"
    href="https://github.com/ghkim887-karaoke-search"
    target="_blank"
    rel="noreferrer noopener"
  >
    GitHub ↗
  </a>
</footer>
```

Note: replace the `https://github.com/ghkim887-karaoke-search` URL with `https://github.com/ghkim887/karaoke-search` (the actual repo per `CLAUDE.md`). The implementation step writes the correct URL — this hyphen in the example is a transcription guard so reviewers see the substitution explicitly.

- [ ] **Step 6: Mount `<Footer />` in `apps/web/src/pages/index.astro`**

Add the import to the frontmatter (top of file):

```diff
 ---
 import { App } from '../components/App';
+import Footer from '../components/Footer.astro';
 const title = '노래방 검색기';
 ---
```

Render after `<App client:load />`:

```diff
     <App client:load />
+    <Footer />
   </body>
 </html>
```

- [ ] **Step 7: Add `.site-footer` CSS rules to `index.astro`**

Insert at the end of `<style is:global>` (just before `</style>`):

```css
      footer.site-footer {
        max-width: 960px;
        margin: 0 auto;
        padding: 1.5rem 1.25rem;
        border-top: 1px solid var(--border);
        font-size: 0.8rem;
        color: var(--fg-muted);
        line-height: 1.6;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
      }

      .site-footer-sep {
        padding: 0 0.5rem;
      }

      .site-footer-link {
        color: var(--accent);
        text-decoration: none;
      }

      .site-footer-link:hover {
        text-decoration: underline;
      }
```

- [ ] **Step 8: Manual visual + build-output verification**

Run:

```bash
corepack pnpm -r build
```

Open `apps/web/dist/index.html` (or the configured output) and confirm: the rendered footer contains the literal date from `git log -1 --format=%cs -- apps/web/public/data/songs.json` (run that command locally to see the expected value), an `MIT` token, and a single GitHub link. Run `corepack pnpm --filter @karaoke/web dev` and visually confirm placement, top-border, muted color, and bullet separators.

- [ ] **Step 9: Verify the date refreshes on a synthetic data-only commit**

(Optional smoke check — skip if working tree must stay clean.)

```bash
touch apps/web/public/data/songs.json
git add apps/web/public/data/songs.json
git commit -m "chore(test): bump songs.json mtime"   # delete this commit afterwards
corepack pnpm -r build
```

Expected: the rebuilt `dist/index.html` shows today's date in the footer. Drop the throwaway commit with `git reset --hard HEAD~1` ONLY if the user explicitly authorizes it; otherwise just verify and revert with `git restore --staged apps/web/public/data/songs.json && git checkout -- apps/web/public/data/songs.json`. Skip this whole step if uncertain.

- [ ] **Step 10: Run biome + build + full test**

```bash
corepack pnpm exec biome check apps/web/src/components/Footer.astro apps/web/src/lib/footer-date.ts apps/web/src/lib/footer-date.test.ts apps/web/src/pages/index.astro
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes. Vitest passes — 19/19 from Task 9 + 4 new = 23/23 (the spec's "18 + new" assumes the favorites + footer tests; this task contributes 4).

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/Footer.astro apps/web/src/lib/footer-date.ts apps/web/src/lib/footer-date.test.ts apps/web/src/pages/index.astro
git commit -m "feat(web): add footer with build-time DB-update date"
```

---

## Task 11: Favorites — `useFavorites()` hook

**Files:**
- Create: `apps/web/src/lib/favorites.ts`
- Test: `apps/web/src/lib/favorites.test.ts`

The hook owns three concerns: read-on-mount from `localStorage`, in-memory state (a `Set` for lookups + an array for ordering), and write-on-toggle. Newest-first ordering means `toggle(newId)` prepends to the array, and `toggle(existingId)` removes by id (preserving order of the rest).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/favorites.test.ts`:

```ts
// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/preact-hooks';
// ↑ NOT installed. Use the manual harness below instead — Preact has no first-party
// hook-only renderer. We construct a tiny host component to drive the hook.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFavorites } from './favorites.js';

const STORAGE_KEY = 'karaoke-favorites:v1';

interface Probe {
  current: ReturnType<typeof useFavorites> | null;
}

function HookHost({ probe }: { probe: Probe }) {
  const fav = useFavorites();
  // Expose the latest hook snapshot to the test on every render.
  useEffect(() => {
    probe.current = fav;
  });
  return null;
}

function mountHook(): { probe: Probe; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const probe: Probe = { current: null };
  render(<HookHost probe={probe} />, host);
  return { probe, host };
}

function unmount(host: HTMLElement): void {
  // Preact unmount: render `null` to the host.
  render(null as unknown as preact.ComponentChild, host);
  host.parentNode?.removeChild(host);
}

describe('useFavorites', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts with an empty favorites set when localStorage is empty', () => {
    const { probe, host } = mountHook();
    expect(probe.current?.favorites.size).toBe(0);
    expect(probe.current?.isFavorite('tj-100')).toBe(false);
    unmount(host);
  });

  it('toggle adds a new id and persists', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('tj-100');
    // Mounting a second instance reads the persisted value.
    unmount(host);
    const { probe: probe2, host: host2 } = mountHook();
    expect(probe2.current?.isFavorite('tj-100')).toBe(true);
    expect(probe2.current?.favorites.size).toBe(1);
    unmount(host2);
  });

  it('toggle on an existing id removes it', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['tj-100', 'tj-200']));
    const { probe, host } = mountHook();
    probe.current?.toggle('tj-100');
    expect(probe.current?.isFavorite('tj-100')).toBe(false);
    expect(probe.current?.isFavorite('tj-200')).toBe(true);
    unmount(host);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['tj-200']);
  });

  it('preserves newest-first ordering on the array form', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('a');
    probe.current?.toggle('b');
    probe.current?.toggle('c');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual(['c', 'b', 'a']);
    unmount(host);
  });

  it('uses the versioned key "karaoke-favorites:v1"', () => {
    const { probe, host } = mountHook();
    probe.current?.toggle('x');
    expect(localStorage.getItem('karaoke-favorites:v1')).not.toBeNull();
    expect(localStorage.getItem('karaoke-favorites')).toBeNull();
    unmount(host);
  });
});
```

(NOTE: The `@testing-library/preact-hooks` import line at the top is a deliberate red herring — it's NOT installed. The implementer must remove that line entirely; the rest of the test uses the manual harness. This guard catches a copy-paste mistake at test-write time.)

- [ ] **Step 2: Remove the red-herring import**

Delete the first two lines of the test file:

```diff
-import { renderHook, act } from '@testing-library/preact-hooks';
-// ↑ NOT installed. Use the manual harness below instead — Preact has no first-party
-// hook-only renderer. We construct a tiny host component to drive the hook.
```

Leave the explanatory comment and the manual `HookHost` harness intact.

- [ ] **Step 3: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/lib/favorites.test.ts
```

Expected: FAIL — `./favorites.js` does not exist; the import resolves to nothing.

- [ ] **Step 4: Implement `apps/web/src/lib/favorites.ts`**

```ts
import { useCallback, useEffect, useState } from 'preact/hooks';

const STORAGE_KEY = 'karaoke-favorites:v1';

function readFromStorage(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // Corrupt JSON — start fresh; never crash the app over a stored value.
    return [];
  }
}

function writeToStorage(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage quota or disabled — best-effort.
  }
}

export interface UseFavoritesReturn {
  /** Set view, for O(1) lookups in render. */
  favorites: Set<string>;
  /** Toggle a record id. New ids are prepended (newest-first). */
  toggle: (id: string) => void;
  /** Convenience wrapper around `favorites.has(id)`. */
  isFavorite: (id: string) => boolean;
  /** Newest-first id list — used by EmptyState to render the favorites section. */
  orderedIds: string[];
}

/**
 * Device-local favorites backed by `localStorage` key `karaoke-favorites:v1`.
 * Returns both a `Set` (for O(1) `isFavorite`) and an ordered array
 * (newest-favorited first) so callers can render in order without re-sorting.
 */
export function useFavorites(): UseFavoritesReturn {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => readFromStorage());

  const toggle = useCallback((id: string) => {
    setOrderedIds((prev) => {
      const idx = prev.indexOf(id);
      const next = idx >= 0 ? prev.filter((x) => x !== id) : [id, ...prev];
      writeToStorage(next);
      return next;
    });
  }, []);

  // Build the Set view once per change, not on every render.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(orderedIds));
  useEffect(() => {
    setFavorites(new Set(orderedIds));
  }, [orderedIds]);

  const isFavorite = useCallback((id: string) => favorites.has(id), [favorites]);

  return { favorites, toggle, isFavorite, orderedIds };
}
```

- [ ] **Step 5: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/lib/favorites.test.ts
```

Expected: PASS — all five cases.

- [ ] **Step 6: Run biome + full test + build**

```bash
corepack pnpm exec biome check apps/web/src/lib/favorites.ts apps/web/src/lib/favorites.test.ts
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes (the hook adds a few hundred bytes — well under the 50 KB ceiling).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/favorites.ts apps/web/src/lib/favorites.test.ts
git commit -m "feat(web): add useFavorites hook backed by localStorage"
```

---

## Task 12: Favorites — star button on `ResultCard`

**Files:**
- Modify: `apps/web/src/components/ResultCard.tsx` (accept `isFavorite` + `onToggleFavorite` props; render an absolutely-positioned `<button class="favorite-star">`)
- Modify: `apps/web/src/components/App.tsx` (instantiate `useFavorites()` once; pass per-card props through)
- Modify: `apps/web/src/pages/index.astro` (add `.favorite-star` rules; the mobile ≥44 px rule is already declared in Task 8)

This task has testable behavior (clicking the button toggles the hook), so it follows the TDD pattern.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ResultCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultCard } from './ResultCard.js';

const sample: SongRecord = {
  id: 'tj-1',
  title_primary: 'Idol',
  title_ko: '아이돌',
  artist_primary: 'YOASOBI',
  artist_ko: '요아소비',
  categories: ['jpop'],
  karaoke_numbers: { tj: '12345', ky: null, joysound: null },
  release_year: null,
  source_url: 'https://example.invalid/yoasobi',
};

describe('ResultCard favorite-star', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders an outline star with aria-pressed=false when not favorited', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <ResultCard
        record={sample}
        isFavorite={false}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    expect(star).not.toBeNull();
    expect(star?.getAttribute('aria-pressed')).toBe('false');
    expect(star?.textContent).toContain('☆');
  });

  it('renders a filled star with aria-pressed=true when favorited', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <ResultCard
        record={sample}
        isFavorite={true}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    expect(star?.getAttribute('aria-pressed')).toBe('true');
    expect(star?.textContent).toContain('★');
  });

  it('invokes onToggleFavorite with the record id on click', () => {
    const onToggle = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <ResultCard record={sample} isFavorite={false} onToggleFavorite={onToggle} />,
      host,
    );
    const star = host.querySelector<HTMLButtonElement>('.favorite-star');
    star?.click();
    expect(onToggle).toHaveBeenCalledWith('tj-1');
  });
});
```

- [ ] **Step 2: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/ResultCard.test.tsx
```

Expected: FAIL — current `ResultCard` does not accept `isFavorite` / `onToggleFavorite` and does not render `.favorite-star`.

- [ ] **Step 3: Update `ResultCardProps` and add the star button to `ResultCard.tsx`**

Replace the `ResultCardProps` interface and the `ResultCard` function. The full updated file:

```tsx
import type { SongRecord } from '@karaoke/schema';
import { useEffect, useRef, useState } from 'preact/hooks';

interface ResultCardProps {
  record: SongRecord;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
}

function joinBilingual(primary: string | null, ko: string | null): string {
  if (primary && ko) return `${primary} — ${ko}`;
  return primary ?? ko ?? '—';
}

interface NumberBadgeProps {
  label: 'TJ' | 'KY' | 'JOY';
  value: string | null;
  testId: string;
}

function NumberBadge({ label, value, testId }: NumberBadgeProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      // clipboard write failed (e.g. insecure context) — silently no-op.
    }
  };

  return (
    <button
      type="button"
      class={`badge badge-number ${value === null ? 'badge-disabled' : ''}`}
      data-testid={testId}
      aria-label={`${label} 번호 복사`}
      disabled={value === null}
      onClick={handleClick}
    >
      <span class="badge-label">{label}</span>
      <span class="badge-value">{value ?? '—'}</span>
      {copied && <span class="badge-toast">복사됨</span>}
    </button>
  );
}

export function ResultCard({ record, isFavorite, onToggleFavorite }: ResultCardProps) {
  const titleText = joinBilingual(record.title_primary, record.title_ko);
  const artistText = joinBilingual(record.artist_primary, record.artist_ko);

  return (
    <article class="result-card" data-testid="result-card">
      <button
        type="button"
        class={`favorite-star ${isFavorite ? 'favorite-star-on' : ''}`}
        aria-label="즐겨찾기 / Favorite"
        aria-pressed={isFavorite}
        onClick={() => onToggleFavorite(record.id)}
      >
        {isFavorite ? '★' : '☆'}
      </button>
      <h2 class="result-title">{titleText}</h2>
      <div class="result-artist">{artistText}</div>
      <div class="result-tags">
        {record.categories.map((c) => (
          <span key={c} class={`badge badge-category badge-category-${c}`}>
            {c}
          </span>
        ))}
      </div>
      <div class="result-numbers">
        <NumberBadge label="TJ" value={record.karaoke_numbers.tj} testId="badge-tj" />
        <NumberBadge label="KY" value={record.karaoke_numbers.ky} testId="badge-ky" />
        <NumberBadge label="JOY" value={record.karaoke_numbers.joysound} testId="badge-joysound" />
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Wire `useFavorites()` through `App.tsx`**

In `apps/web/src/components/App.tsx`:

1. Add the import at the top:
   ```tsx
   import { useFavorites } from '../lib/favorites.js';
   ```
2. Inside `App()`, near the top alongside the other state hooks, instantiate the hook:
   ```tsx
   const { isFavorite, toggle: toggleFavorite, orderedIds: favoriteIds } = useFavorites();
   ```
3. Update both `<ResultCard />` invocations (the search-result list and any future EmptyState use) to pass through the props. For the search-result list:
   ```diff
   -          {results.map((r) => (
   -            <li key={r.id} class="result-list-item">
   -              <ResultCard record={r} />
   -            </li>
   -          ))}
   +          {results.map((r) => (
   +            <li key={r.id} class="result-list-item">
   +              <ResultCard
   +                record={r}
   +                isFavorite={isFavorite(r.id)}
   +                onToggleFavorite={toggleFavorite}
   +              />
   +            </li>
   +          ))}
   ```
4. Also update the `EmptyState` usage to forward the favorites slice — implemented fully in **Task 13**, but pass an extra prop now so the type stays consistent:
   ```diff
   -      ) : query === '' ? (
   -        <EmptyState onPickArtist={handlePickArtist} />
   +      ) : query === '' ? (
   +        <EmptyState
   +          onPickArtist={handlePickArtist}
   +          favoriteIds={favoriteIds}
   +          byId={bundle?.byId ?? null}
   +          isFavorite={isFavorite}
   +          onToggleFavorite={toggleFavorite}
   +        />
   ```
   `EmptyState`'s prop interface must be updated in **Task 13** to accept these. If executing tasks strictly in order, after this step `EmptyState`'s typecheck will fail until Task 13 lands. To avoid a broken middle commit: defer steps 4.4 (the EmptyState call site) until Task 13. Mark the `useFavorites()` call site and the result-list call site landing in this commit; the EmptyState call site lands in Task 13.

- [ ] **Step 5: Add `.favorite-star` CSS rules to `index.astro`**

Insert immediately after the `.result-card:hover` block (added in Task 5):

```css
      .favorite-star {
        position: absolute;
        top: 0.75rem;
        right: 0.85rem;
        font: inherit;
        font-size: 1.2rem;
        line-height: 1;
        background: transparent;
        border: 0;
        padding: 0.25rem 0.4rem;
        cursor: pointer;
        color: var(--fg-muted);
        transition: color 120ms ease;
      }

      .favorite-star:hover {
        color: color-mix(in srgb, #ffc857 50%, transparent);
      }

      .favorite-star-on,
      .favorite-star-on:hover {
        color: #ffc857;
      }
```

The mobile ≥44 px rule already exists in the `@media (max-width: 719px)` block from Task 8.

- [ ] **Step 6: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/ResultCard.test.tsx
```

Expected: PASS — all three cases.

- [ ] **Step 7: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, search for any record. Confirm the top-right of each card shows a `☆` glyph; hover previews gold at 50 % opacity; click flips it to filled gold `★` and persists across reloads. Stop dev server.

- [ ] **Step 8: Run biome + full test + build**

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/ResultCard.tsx apps/web/src/components/ResultCard.test.tsx apps/web/src/pages/index.astro
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes. Vitest 26/26 (18 baseline + Task 9 + 4 footer + 5 favorites hook + 3 ResultCard star = 31… recount once you get here; actual total depends on whether the existing tests still all pass).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/ResultCard.tsx apps/web/src/components/ResultCard.test.tsx apps/web/src/pages/index.astro
git commit -m "feat(web): add favorite-star toggle button on result cards"
```

---

## Task 13: Favorites — surfacing the favorites section in `EmptyState`

**Files:**
- Modify: `apps/web/src/components/EmptyState.tsx` (accept favorites props; render the favorites section first when `favoriteIds.length > 0`)
- Modify: `apps/web/src/components/App.tsx` (the EmptyState call-site update deferred from Task 12 step 4.4 lands here)
- Test: `apps/web/src/components/EmptyState.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/EmptyState.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { SongRecord } from '@karaoke/schema';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState.js';

const recA: SongRecord = {
  id: 'tj-1',
  title_primary: 'Idol',
  title_ko: '아이돌',
  artist_primary: 'YOASOBI',
  artist_ko: '요아소비',
  categories: ['jpop'],
  karaoke_numbers: { tj: '12345', ky: null, joysound: null },
  release_year: null,
  source_url: 'https://example.invalid/a',
};

const recB: SongRecord = {
  id: 'tj-2',
  title_primary: 'KICK BACK',
  title_ko: null,
  artist_primary: '米津玄師',
  artist_ko: null,
  categories: ['jpop', 'anime'],
  karaoke_numbers: { tj: '67890', ky: null, joysound: null },
  release_year: null,
  source_url: 'https://example.invalid/b',
};

describe('EmptyState favorites surfacing', () => {
  let host: HTMLElement;
  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('does not render a favorites section when favoriteIds is empty', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={[]}
        byId={new Map()}
        isFavorite={() => false}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    expect(host.querySelector('.empty-favorites-section')).toBeNull();
  });

  it('renders a favorites section first with N cards in newest-first order', () => {
    const byId = new Map<string, SongRecord>();
    byId.set(recA.id, recA);
    byId.set(recB.id, recB);
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={[recB.id, recA.id]}
        byId={byId}
        isFavorite={(id) => id === recB.id || id === recA.id}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const section = host.querySelector('.empty-favorites-section');
    expect(section).not.toBeNull();
    const cards = section?.querySelectorAll<HTMLElement>('[data-testid="result-card"]');
    expect(cards?.length).toBe(2);
    // Newest-first: recB before recA.
    expect(cards?.[0]?.textContent).toContain('KICK BACK');
    expect(cards?.[1]?.textContent).toContain('Idol');
    // Title contains the count.
    const title = section?.querySelector('.empty-favorites-title');
    expect(title?.textContent).toContain('(2)');
  });

  it('silently skips ids that no longer exist in the loaded corpus', () => {
    const byId = new Map<string, SongRecord>();
    byId.set(recA.id, recA);
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <EmptyState
        onPickArtist={() => {}}
        favoriteIds={['stale-id', recA.id]}
        byId={byId}
        isFavorite={(id) => id === recA.id}
        onToggleFavorite={() => {}}
      />,
      host,
    );
    const cards = host.querySelectorAll('[data-testid="result-card"]');
    // Only recA renders; stale-id is silently skipped.
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Idol');
  });
});
```

- [ ] **Step 2: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/EmptyState.test.tsx
```

Expected: FAIL — `EmptyState` currently doesn't accept the new props; TS rejects the call sites.

- [ ] **Step 3: Update `EmptyState.tsx` to render the favorites section**

Replace the entire file:

```tsx
import type { SongRecord } from '@karaoke/schema';
import { featured } from '../data/featured.js';
import { ResultCard } from './ResultCard.js';

interface EmptyStateProps {
  onPickArtist: (name: string) => void;
  favoriteIds: string[];
  byId: Map<string, SongRecord> | null;
  isFavorite: (id: string) => boolean;
  onToggleFavorite: (id: string) => void;
}

const SECTIONS: ReadonlyArray<{ key: keyof typeof featured; label: string }> = [
  { key: 'jpop', label: 'J-POP' },
  { key: 'vocaloid', label: 'Vocaloid' },
  { key: 'anime', label: 'Anime' },
];

/**
 * Default landing view shown when `query` is empty.
 *
 * If the user has any favorites, the favorites section renders FIRST. The id
 * list comes from `useFavorites().orderedIds` (already newest-first); ids that
 * no longer resolve in the loaded corpus (`byId`) are silently skipped.
 */
export function EmptyState({
  onPickArtist,
  favoriteIds,
  byId,
  isFavorite,
  onToggleFavorite,
}: EmptyStateProps) {
  // Resolve favorite ids to records, dropping stale/unloaded ids silently.
  const favoriteRecords: SongRecord[] = [];
  if (byId !== null) {
    for (const id of favoriteIds) {
      const rec = byId.get(id);
      if (rec !== undefined) favoriteRecords.push(rec);
    }
  }

  return (
    <div class="empty-state">
      {favoriteRecords.length > 0 && (
        <section class="empty-section empty-favorites-section">
          <h2 class="empty-section-title empty-favorites-title">
            ★ 즐겨찾기 ({favoriteRecords.length}) / Favorites
          </h2>
          <ul class="result-list">
            {favoriteRecords.map((r) => (
              <li key={r.id} class="result-list-item">
                <ResultCard
                  record={r}
                  isFavorite={isFavorite(r.id)}
                  onToggleFavorite={onToggleFavorite}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {SECTIONS.map((section) => {
        const artists = featured[section.key];
        return (
          <section key={section.key} class="empty-section">
            <h2 class={`empty-section-title empty-section-title-${section.key}`}>
              {section.label}
            </h2>
            {artists.length === 0 ? (
              <p class="empty-section-placeholder">아직 없음 / Not yet</p>
            ) : (
              <div class="empty-section-chips">
                {artists.map((name) => (
                  <button
                    key={name}
                    type="button"
                    class="featured-chip"
                    onClick={() => onPickArtist(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Update the `EmptyState` call site in `App.tsx` (deferred from Task 12)**

```diff
-      ) : query === '' ? (
-        <EmptyState onPickArtist={handlePickArtist} />
+      ) : query === '' ? (
+        <EmptyState
+          onPickArtist={handlePickArtist}
+          favoriteIds={favoriteIds}
+          byId={bundle?.byId ?? null}
+          isFavorite={isFavorite}
+          onToggleFavorite={toggleFavorite}
+        />
```

(Task 12 already added the `useFavorites()` call and destructured `favoriteIds`, `isFavorite`, `toggleFavorite`. If you skipped that step, add them now.)

- [ ] **Step 5: Add the favorites-title styling in `index.astro`**

The `.empty-favorites-title` element reuses `.empty-section-title` for typography. Add a single accent rule (gold to match the star) at the same insertion point as the per-category title rules:

```css
      .empty-favorites-title {
        color: #ffc857;
        border-left-color: #ffc857;
      }
```

- [ ] **Step 6: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/EmptyState.test.tsx
```

Expected: PASS — all three cases.

- [ ] **Step 7: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, favorite 2-3 records, clear the search box. Confirm the favorites section renders first, in newest-first order, with the count in the title. Tap a star inside a favorite card — it un-favorites and disappears from the section on the next render. Stop dev server.

- [ ] **Step 8: Run biome + full test + build**

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/EmptyState.tsx apps/web/src/components/EmptyState.test.tsx apps/web/src/pages/index.astro
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/EmptyState.tsx apps/web/src/components/EmptyState.test.tsx apps/web/src/pages/index.astro
git commit -m "feat(web): surface favorites section first in empty state"
```

---

## Task 14: Loading mitigation — render empty state during load

**Files:**
- Modify: `apps/web/src/components/App.tsx` (restructure render: always render `<SearchBox>` and the empty/results area; gate the result-list slot behind `loading`)
- Modify: `apps/web/src/components/SearchBox.tsx` (accept `disabled`; flip `placeholder` while loading)

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/App.test.tsx` (created in Task 9):

```tsx
import { afterEach as afterEach2, describe as describe2, expect as expect2, it as it2 } from 'vitest';

describe2('App loading-state mitigation', () => {
  let host: HTMLElement;
  afterEach2(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it2('renders the empty state immediately on mount, alongside the loading indicator', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    // Note: rendering App triggers loadIndex(); we are NOT awaiting it. The
    // test asserts the synchronous initial render before the fetch resolves.
    const { render } = await import('preact');
    const { App } = await import('./App.js');
    render(<App />, host);
    // EmptyState root is present.
    expect2(host.querySelector('.empty-state')).not.toBeNull();
    // Loading indicator is present (inside the result-list slot).
    expect2(host.querySelector('.loading')).not.toBeNull();
    // SearchBox is present and disabled.
    const input = host.querySelector<HTMLInputElement>('.search-input');
    expect2(input).not.toBeNull();
    expect2(input?.disabled).toBe(true);
    expect2(input?.placeholder).toMatch(/Loading search index/);
  });
});
```

(The duplicated `describe2`/`it2`/`expect2`/`afterEach2` aliases prevent collision with the existing imports at the top of the file. Replace with a single shared import block if you prefer — both work.)

- [ ] **Step 2: Run the test — must fail**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/App.test.tsx
```

Expected: FAIL — current `App.tsx` short-circuits the render to only the loading paragraph while `loading=true`.

- [ ] **Step 3: Restructure the `App` render**

Replace the JSX returned by `App()` with:

```tsx
  return (
    <main class="results">
      <SearchBox value={inputValue} onInput={handleInputChange} disabled={loading} />
      <CategoryChips selected={selectedCategories} onToggle={toggleCategory} />
      <VendorChips selected={selectedVendors} onToggle={toggleVendor} />
      <span class="sr-only" aria-live="polite" aria-atomic="true" data-testid="result-count">
        {resultCount}건 / {resultCount} results
      </span>
      {error !== null ? (
        <ErrorState message={error} />
      ) : query === '' ? (
        <>
          <EmptyState
            onPickArtist={handlePickArtist}
            favoriteIds={favoriteIds}
            byId={bundle?.byId ?? null}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
          />
          {loading && (
            <p class="loading">
              {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
              <span class="loading-dot" aria-hidden="true">.</span>
              <span class="loading-dot" aria-hidden="true">.</span>
              <span class="loading-dot" aria-hidden="true">.</span>
            </p>
          )}
        </>
      ) : loading ? (
        <p class="loading">
          {SONG_COUNT_DISPLAY}곡 검색 인덱스 빌드 중 / Building {SONG_COUNT_DISPLAY}-song index
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
          <span class="loading-dot" aria-hidden="true">.</span>
        </p>
      ) : results.length === 0 ? (
        <NoResults />
      ) : (
        <ul class="result-list">
          {results.map((r) => (
            <li key={r.id} class="result-list-item">
              <ResultCard
                record={r}
                isFavorite={isFavorite(r.id)}
                onToggleFavorite={toggleFavorite}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
```

The control flow is: errors win, else empty state always renders; if a query is active and the index hasn't loaded yet, the result-list slot shows the same loading indicator. The favorites section inside `EmptyState` works during loading because `bundle?.byId ?? null` short-circuits to no favorite cards rendered (stale-id skip path covers the empty-Map case).

- [ ] **Step 4: Update `SearchBox.tsx` to accept `disabled` and flip the placeholder**

```tsx
interface SearchBoxProps {
  value: string;
  onInput: (value: string) => void;
  disabled?: boolean;
}

export function SearchBox({ value, onInput, disabled = false }: SearchBoxProps) {
  const handleInput = (e: Event) => {
    onInput((e.currentTarget as HTMLInputElement).value);
  };
  const placeholder = disabled
    ? '검색 인덱스 로딩 중… / Loading search index…'
    : '곡명/가수명';

  return (
    <div class="search-input-wrap">
      <svg
        class="search-input-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M10 4a6 6 0 1 0 3.873 10.59l4.768 4.768 1.414-1.415-4.768-4.767A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          fill="currentColor"
        />
      </svg>
      <input
        class="search-input"
        type="search"
        aria-label="가라오케 검색"
        placeholder={placeholder}
        autocomplete="off"
        spellcheck={false}
        enterkeyhint="search"
        value={value}
        disabled={disabled}
        onInput={handleInput}
      />
    </div>
  );
}
```

- [ ] **Step 5: Re-run the test — must pass**

Run:

```bash
corepack pnpm --filter @karaoke/web test src/components/App.test.tsx
```

Expected: PASS for both the original Task 9 case and the new mitigation case.

- [ ] **Step 6: Manual visual verification**

Run `corepack pnpm --filter @karaoke/web dev`, throttle network to "Slow 3G". Confirm: on first paint the page already shows the empty-state featured-artist sections, the favorites section (if any), the disabled search input with the loading placeholder, and the footer; the loading paragraph (with dots) sits beneath the empty-state. Once the index resolves, the input enables, the placeholder reverts, and the loading paragraph disappears. Stop dev server.

- [ ] **Step 7: Run biome + full test + build**

```bash
corepack pnpm exec biome check apps/web/src/components/App.tsx apps/web/src/components/SearchBox.tsx
corepack pnpm --filter @karaoke/web test
corepack pnpm -r build
```

Expected: 0 errors. Bundle size guard passes.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/App.tsx apps/web/src/components/SearchBox.tsx apps/web/src/components/App.test.tsx
git commit -m "feat(web): render empty state during index load (loading mitigation)"
```

---

## Final pass — full verification

After Task 14, run the spec's acceptance suite end-to-end.

- [ ] **Step 1: Schema and crawler tests still pass (untouched)**

```bash
corepack pnpm --filter @karaoke/schema test
corepack pnpm --filter @karaoke/crawler test
```

Expected: schema 18/18 PASS, crawler 106/106 PASS — both unchanged from baseline.

- [ ] **Step 2: Web tests all pass**

```bash
corepack pnpm --filter @karaoke/web test
```

Expected: previous 18 + new tests (App: 2, footer-date: 4, favorites: 5, ResultCard: 3, EmptyState: 3) = 35/35 PASS. Recount once you arrive — the actual additions will hint if any test was lost.

- [ ] **Step 3: Bilingual sweep**

```bash
grep -rnE "[ぁ-んァ-ヶ]" apps/web/src/components apps/web/src/pages
```

Expected: zero hits.

- [ ] **Step 4: `source_url` data preserved**

```bash
grep -c '"source_url"' apps/web/public/data/songs.json
```

Expected: ≥ 26,000 (one per record).

- [ ] **Step 5: Bundle size guard**

```bash
corepack pnpm -r build
```

Expected: bundle gzipped ≤ 50 KB; postbuild script exits 0.

- [ ] **Step 6: Optional Playwright e2e on the staging URL**

```bash
E2E_BASE_URL=http://localhost:4321/karaoke-search/ corepack pnpm --filter @karaoke/web test:e2e
```

(Requires `corepack pnpm exec playwright install chromium` once.) Optional — if the e2e suite asserts on any of the now-removed strings (`Source ↗`, `該当なし`), update those assertions in the same final commit. Spec only requires manual iOS-Safari behavior checks (zoom-on-focus and no auto-focus), which are visual and can be done on a real device.

- [ ] **Step 7: Lighthouse mobile a11y baseline**

Per the spec: "Lighthouse mobile a11y score does not regress." Capture the pre-change baseline once at the start of the implementation (run Lighthouse against `https://ghkim887.github.io/karaoke-search/` and record the score). After the PR preview deploys, re-run against the preview URL. The post-change score must be ≥ baseline. This step is informational — block the merge only on a regression.

---

## Self-review

Spec coverage map:

- §Visual polish — Category badge tinting → **Task 3**. Typography refinements → **Task 4** (h1, result-title, badge-number desktop) + **Task 7** (empty-state titles) + **Task 8** (badge-number mobile). Result card baseline + hover → **Task 5**. Source link removal → **Task 1**. Search input polish (icon, padding, focus halo, enterkeyhint, no auto-focus) → **Task 6** (input attributes do not include autofocus, so "no auto-focus" is the default). Empty-state section titles → **Task 7**. Loading state with 3-dot animation → **Task 9**.
- §Mobile first — Tap-target audit → **Task 8**. Catalog-number primary-action emphasis → **Task 8**. Search input on mobile (16 px font already, enterkeyhint, no auto-focus) → covered by **Task 6** + **Task 8**.
- §Favorites — Storage + hook → **Task 11**. Star button → **Task 12**. Empty-state surfacing → **Task 13**. No filter-by-favorites toggle → confirmed not implemented (no task adds it).
- §Footer — **Task 10**.
- §Loading mitigation — **Task 14**.
- §Bilingual flip — **Task 2**.

No gaps detected.

Placeholder scan: searched the plan for "TBD", "TODO", "fill in details", "similar to Task" — zero matches. The `recount once you arrive` notes in Tasks 12 and the final pass are operational hints (the literal test totals depend on which sub-tests vitest discovers), not placeholders for content; the Step intent and command are concrete.

Type consistency: `useFavorites()` returns `{ favorites: Set<string>, toggle, isFavorite, orderedIds }` (Task 11). Task 12 destructures `{ isFavorite, toggle: toggleFavorite, orderedIds: favoriteIds }`. Task 13's `EmptyState` accepts `favoriteIds: string[]`, `byId: Map<string, SongRecord> | null`, `isFavorite: (id: string) => boolean`, `onToggleFavorite: (id: string) => void` — matches what Task 12 passes through `App`. Task 14's restructured render uses the same destructured names. `ResultCard` props are consistent across Tasks 12, 13 (`isFavorite: boolean`, `onToggleFavorite: (id: string) => void`).

Inter-task ordering note: Task 12 step 4 deliberately defers the `EmptyState` call-site update to Task 13 step 4 to avoid landing a TypeScript-broken intermediate commit. The plan calls this out at the deferral and re-introduces it at landing.

Test-count drift: spec §Acceptance criteria says "18 existing + new". The plan adds 17 new tests (App: 2, footer-date: 4, favorites: 5, ResultCard: 3, EmptyState: 3) for a 35/35 total. If a test was lost during a string flip in Task 2, the final-pass step will surface it.
