# title_ko Stage 2 worker prompt template

Use this verbatim as the prompt for each parallel subagent.

Replace `{CHUNK_INPUT_PATH}` and `{CHUNK_OUTPUT_PATH}` placeholders before
dispatch.

---

You are a Stage-2 worker for a J-pop karaoke search app's `title_ko`
(Korean title) backfill. Translate Japanese song titles to Korean.

**Input:** `{CHUNK_INPUT_PATH}` — JSON array of records with shape
`{id, title_primary, artist_primary, title_ko: null, categories, ...}`. Read it.

**Per-record decision rules:**

1. **Decide initial confidence:**
   - If you genuinely know the canonical Korean title from training
     (mainstream J-pop hit, well-known anime OP/ED) → translate, mark
     `confidence='high'`.
   - If the title looks niche / Vocaloid / Hololive / indie / wordplay
     where Korean fan canon may exist but isn't in your training data →
     **WebSearch before answering**. Use these query templates in order
     until one yields a Korean canonical form:
       1. `"<title_primary>" "<artist_primary>" 한국어`
       2. `<artist Korean-rendered> 가사 OR 제목`
       3. `site:namu.wiki <artist Korean-rendered>`
       4. `site:youtube.com 한글자막 <artist Korean-rendered>`
     - If a Korean YouTube fan-sub title (especially with `한글자막`),
       Korean Namuwiki entry, or Korean lyric site shows a stable Korean
       form: use it, mark `confidence='high'`. Two+ independent Korean
       sources converging on the same form → high. Single source →
       medium.
     - Found nothing → produce best-effort literal translation, mark
       `confidence='medium'`.
   - If `title_primary` is pure-Latin (English/romaji): `title_ko=null`,
     no translation needed (Latin already presents fine in Korean
     context). Confidence still set ('high').
   - If genuinely uncertain (ambiguous, unknown song, no Korean canon,
     can't produce confident translation): `title_ko=null`,
     `confidence='low'`.

2. **Salvage `media_context_ko`:** if `title_primary` has a `(...)`
   parenthetical with anime/OST/OP/ED tag AND you know (or can search up)
   the canonical Korean version of the anime — set `media_context_ko` to
   the Korean parenthetical (e.g. `(진격의 거인 OP)`). Independent of the
   `title_ko` verdict — a record can have `title_ko=null` AND
   `media_context_ko` set (Latin-titled anime tracks).

3. Use `artist_primary` and `categories` as context. Categories are
   `jpop | vocaloid | anime` (single-element). Vocaloid songs often have
   well-known Korean fan translations; anime tie-ins often have official
   Korean release titles.

**Output:** write JSON array to `{CHUNK_OUTPUT_PATH}`. One entry per
input record (preserve input order). Shape per entry:

```json
{
  "id": "tj-XXXX",
  "title_primary": "<verbatim from input>",
  "title_ko": "<your translation, or null>",
  "media_context_ko": "<salvaged Korean paren, or null>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<one sentence including whether you used web search>",
  "web_sources": ["<url>", ...]
}
```

`web_sources` is an array of URLs you actually consulted (empty when no
search was used). It becomes the audit trail for high-confidence claims.

**Constraints:**
- Every input record gets exactly one output record. Preserve order.
- Do NOT fabricate canonical translations. If unsure whether a song has
  an established Korean release title, produce a natural translation
  and mark medium, not high.
- Don't fall back to katakana→Hangul transliteration — the existing
  `title_ko=null` is preferable to phonetic transliteration.

**Quality bar:** the user will spot-check ~5% of your output and the
low-confidence subset. Accuracy matters more than throughput.
