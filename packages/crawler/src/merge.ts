import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { getLeadComponent } from './clustering.js';
import { normalize } from './normalize.js';

/**
 * Source priority (lower number = higher priority). Single source of truth
 * for tiebreaks across this file. The order blog > tj > tjpdf > joysound
 * is retained for known active corpus sources, with unknown legacy or
 * experimental prefixes falling back to lowest priority instead of shaping
 * merge semantics.
 *
 * joysound is intentionally lowest priority: it joins the merge primarily
 * to union its karaoke_numbers.joysound cell. Listing it here gives
 * pickByPriority a deterministic tiebreak without allowing JOYSOUND to
 * displace existing sources.
 */
const SOURCE_RANK: Record<string, number> = {
  blog: 1,
  tj: 2,
  tjpdf: 3,
  joysound: 4,
};

const TITLE_ARTIST_CHAIN = ['tj', 'blog', 'tjpdf', 'joysound'] as const;

// `tj` is an explicit member of the Korean-fields chain (lowest priority)
// because the TJ-direct adapter's `searchSong` translit pass (PR-1) writes
// `title_ko` / `artist_ko`. Pre-PR-1 the field fell through `pickByOwnership`'s
// unlisted-source fallback, which is order-dependent and silently ambiguous if
// a future source also writes Korean fields. Listing `tj` here makes the
// priority `blog > tj > tjpdf > joysound` explicit.
const KO_CHAIN = ['blog', 'tj', 'tjpdf', 'joysound'] as const;

/**
 * Source slug derived from the `id` prefix (everything before the first `-`).
 * The schema's `id` pattern is `^[a-z0-9-]+-\d+$`, so the slug may itself
 * contain `-` only if the source convention uses it; for the v1 blog source
 * (`blog-449-0`) the slug is `blog`. Examples: `tj-52498` → `tj`,
 * `blog-487-1` → `blog`, `tjpdf-12345` → `tjpdf`.
 *
 * Used for two distinct purposes:
 *   1. Per-field ownership and source-priority tiebreaks in `pickByOwnership`,
 *      `pickByPriority`, and `mergeKaraokeNumbers` (lookup against
 *      `SOURCE_RANK`).
 *   2. Tier C/D cross-source gating: soft clusters fire only when ≥ 2
 *      distinct slugs are represented, blocking same-source twins (e.g. two
 *      TJ releases of `방탄소년단(Feat.Nicki Minaj)` vs `방탄소년단`) from
 *      wrongly merging.
 */
function sourceSlug(r: SongRecord): string {
  const dash = r.id.indexOf('-');
  return dash === -1 ? r.id : r.id.slice(0, dash);
}

function sourceRank(slug: string): number {
  return SOURCE_RANK[slug] ?? Number.POSITIVE_INFINITY;
}

/**
 * Dash / prolonged-sound-mark fold applied ON TOP of `normalize()` for the
 * merger's Tier B/C/D clustering keys ONLY (deliberately NOT in the shared
 * `normalize()` — aliases.ts / clustering.ts / search keying keep their
 * semantics).
 *
 * Motivation: TJ's catalog writes the katakana long vowel `ー` (U+30FC) as an
 * ASCII hyphen (e.g. `特者生存ワンダラダ-!!` vs JOYSOUND's
 * `特者生存ワンダラダー!!`), splitting the same song into two records when no
 * karaoke number is shared. `normalize()` already strips every punctuation
 * dash (U+002D, U+FF0D, U+2010/2011, U+2013/2014/2015, U+2212 — all outside
 * `\p{L}\p{N}\p{M}`; U+FF70 `ｰ` NFKC-folds to U+30FC first), but U+30FC
 * itself is category Lm (Letter, modifier) and SURVIVES. Stripping the whole
 * dash class here folds `ダ-` / `ダー` / `ダ` to the same key. On the
 * `normalize()`-composed key parts (Tier B title/artist, Tier C title) the
 * pre-stripped punctuation-dash members are defense-in-depth against future
 * `normalize()` changes; on the Tier C ARTIST side — which composes over
 * `normalizeForMatch`, where punctuation survives — those same members are
 * LIVE (see `tierCKey`).
 */
const CLUSTER_DASH_FOLD_RE = /[-ー‐‑–—―−ｰ]/g;

function foldDashes(s: string): string {
  return s.replace(CLUSTER_DASH_FOLD_RE, '');
}

/** `normalize()` + dash fold — the merger's clustering-key normalization. */
function clusterKeyPart(s: string): string {
  return foldDashes(normalize(s));
}

/** Tier B clustering key (used for residuals after Tier A union-find). */
function tierBKey(r: SongRecord): string {
  return `${clusterKeyPart(r.title_primary)}|${clusterKeyPart(r.artist_primary)}`;
}

/**
 * Pre-fold Tier B key (plain `normalize()`, no dash fold). Used to decide
 * whether a Tier B group was brought together BY the fold — see the
 * cross-source gate in `mergeRecords`.
 */
function tierBKeyUnfolded(r: SongRecord): string {
  return `${normalize(r.title_primary)}|${normalize(r.artist_primary)}`;
}

/**
 * Tier C cluster key —
 * `clusterKeyPart(title_primary) | foldDashes(getLeadComponent(artist_primary))`.
 * Returns `null` when either field is empty after normalization, in which
 * case the record is unkeyable for Tier C and stays a singleton.
 *
 * Fix A.2 (2026-05-01): the lead-component extraction is now sourced from
 * the canonical `getLeadComponent` helper in the shared `clustering.ts` module
 * — the same helper the parser's lead-admit rule consumes. The previous
 * inline `primaryArtistToken` had a SUBSET of `splitArtistCollab`'s delimiter
 * regex (no `×` or `＆`), risking silent divergence: the same artist string
 * could produce different lead tokens between the merger's clustering key and
 * the parser's admit rule. Unifying through `getLeadComponent` eliminates
 * that drift class.
 */
function tierCKey(r: SongRecord): string | null {
  const t = clusterKeyPart(r.title_primary);
  // `getLeadComponent` returns `normalizeForMatch(lead)` (whitespace-strip +
  // lowercase + NFKC — punctuation KEPT; see clustering.ts), NOT a
  // `normalize()`d token. The dash fold is applied on top WITHOUT touching
  // the shared helper (the parser's lead-admit rule consumes it with
  // un-folded semantics). Because punctuation survives `normalizeForMatch`,
  // the ASCII/punctuation-dash members of CLUSTER_DASH_FOLD_RE are LIVE on
  // this artist side (not defense-in-depth as on the `normalize()`d title
  // side): `normalizeForMatch('X-Japan')` keeps the hyphen and `foldDashes`
  // strips it, so `X-Japan` vs `XJAPAN` leads now collide. This broadening
  // is INTENDED — Tier C unions stay cross-source-gated, so same-source
  // dash-variant leads never merge on this path alone.
  const a = foldDashes(getLeadComponent(r.artist_primary));
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

const CONTEXT_SUFFIX_RE = /\s*[\(（]([^()（）]{1,180})[\)）]\s*$/u;
const CONTEXT_ROLE_RE =
  /(?:^|[^a-z])(?:op|ed|ost|opening|ending|theme)(?:$|[^a-z])|ＯＰ|ＥＤ|ＯＳＴ|主題歌|挿入歌|オープニング|エンディング|テーマ/iu;
const CONTEXT_VERSION_RE =
  /(?:tv\s*size|tvサイズ|テレビ.*サイズ|サイズ|\bsize\b|anime\s*ver\.?|アニメ\s*ver\.?|movie\s*ver\.?|short\s*ver\.?|remix|リミックス|cover|カバー|version|\bver\.?\b|バージョン|m@ster|acoustic|live|instrumental)/iu;
const CONTEXT_ROLE_TOKEN_RE =
  /(?<![a-z])(?:op|ed|ost|opening|ending|theme)(?:\s*[\d０-９]+)?(?=$|[^a-z])|(?:ＯＰ|ＥＤ|ＯＳＴ|主題歌|挿入歌|オープニング|エンディング|テーマ)(?:\s*[\d０-９]+)?/giu;
const CONTEXT_SEASON_ONLY_RE =
  /(?:第\s*)?[\d０-９一二三四五六七八九十]+\s*期|season\s*[\d０-９]+|シーズン\s*[\d０-９一二三四五六七八九十]+|[\d０-９]+(?:st|nd|rd|th)?/giu;
const CONTEXT_NON_TEXT_RE = /[\s\-–—_:：/\\・!！.。'"“”‘’、,，]/gu;

function hasNonRoleContextText(inner: string): boolean {
  return (
    inner
      .replace(CONTEXT_ROLE_TOKEN_RE, '')
      .replace(CONTEXT_SEASON_ONLY_RE, '')
      .replace(CONTEXT_NON_TEXT_RE, '')
      .trim() !== ''
  );
}

function stripContextSuffix(title: string): { title: string; changed: boolean } {
  let current = title;
  let changed = false;
  while (true) {
    const match = current.match(CONTEXT_SUFFIX_RE);
    if (!match) break;
    const inner = match[1]?.trim() ?? '';
    // Version/size markers win over role/context markers inside the same
    // parenthetical: `テレビオープニングサイズ` contains `オープニング`, but
    // denotes a distinct karaoke cut and must stay keyed separately.
    if (CONTEXT_VERSION_RE.test(inner)) break;
    if (!CONTEXT_ROLE_RE.test(inner)) break;
    // Bare `(OP)` / `(ED)` / `(Ending)` labels are version-like risk. Strip
    // only when a work/franchise name is present alongside the role token.
    if (!hasNonRoleContextText(inner)) break;
    current = current.slice(0, match.index).trimEnd();
    changed = true;
  }
  return { title: current, changed };
}

function tierDKey(r: SongRecord): string | null {
  const stripped = stripContextSuffix(r.title_primary).title;
  const t = clusterKeyPart(stripped);
  const a = clusterKeyPart(r.artist_primary);
  if (t === '' || a === '') return null;
  return `${t}|${a}`;
}

/**
 * Tier E is intentionally NOT a broad artist-containment rule. `SongRecord`
 * does not preserve JOYSOUND tieups or lyricist/composer evidence, so the safe
 * deployable surface is the exact set of 65 TJ↔JOYSOUND pairs raw-reviewed on
 * 2026-06-13 as `MERGE_CANDIDATE_STRONG`.
 *
 * Excluded by design:
 * - 4 `MERGE_CANDIDATE_REVIEWED` rows that require raw tieup/credit evidence
 *   absent from SongRecord (`Radio Happy`, `ファンサ`, etc.).
 * - 6 `ハッピー☆マテリアル` rows where one TJ number maps to multiple
 *   JOYSOUND monthly/opening variants.
 * - 1 short-token false positive (`FLOW X GRANRODEO` vs `XG`).
 */
const REVIEWED_TIER_E_STRONG_PAIRS = [
  ['25031', '492355'], // 六幻 / 林勇 ↔ 佐野万次郎(CV:林勇)
  ['25134', '492356'], // Rusted Fist / 新祐樹 ↔ 花垣武道(CV:新祐樹)
  ['25257', '36852'], // For フルーツバスケット / 岡崎律子 外 ↔ 岡崎律子
  ['25283', '53411'], // Let Me Be With You / Round table ↔ ROUND TABLE featuring Nino
  ['25372', '26946'], // 御旗のもとに / 巴里華撃団 ↔ 日高のり子ほか (巴里華撃団)
  ['25468', '27700'], // もっと!モット!ときめき / 金月真美 ↔ 金月真美(藤崎詩織)
  ['25542', '36509'], // storm / JAM Project ↔ JAM Project featuring 水木一郎&影山ヒロノブ
  ['25663', '37378'], // Fire wars / JAM Project ↔ JAM Project featuring 影山ヒロノブ
  ['25715', '4586'], // 恋しさとせつなさと心強さと / 篠原涼子 ↔ 篠原涼子 with t.komuro
  ['25780', '53543'], // WHITE LINE / 青酢 ↔ 青酢(皆川純子/置鮎龍太郎/近藤孝行/甲斐田ゆき)
  ['25798', '60803'], // Agape / メロキュア ↔ メロキュア(岡崎律子/日向めぐみ)
  ['25918', '65161'], // スクランブル / 堀江由衣 ↔ 堀江由衣 with UNSCANDAL
  ['25963', '32521'], // あぁいいな! / ダブルユー ↔ W(ダブルユー)
  ['26007', '62537'], // チチをもげ! / パルコ・フォルゴレ(高橋広樹) ↔ 高橋広樹
  ['26112', '78294'], // 黄色いバカンス / 桃月学園1年C組(Feat.片桐姫子) ↔ 桃月学園1年C組 feat.片桐姫子(折笠富美子)
  ['26190', '61149'], // 静かな夜に / 田中理恵 ↔ 田中理恵(ラクス・クライン)
  ['26293', '198114'], // しあわせの魔法 / 丹下桜 ↔ 木之本桜(丹下桜)
  ['26324', '68716'], // くじびきアンバランス / UNDER17 ↔ UNDER17(桃井はるこ)
  ['26334', '71482'], // 魔神見参!! / JAM Project ↔ JAM Project featuring 遠藤正明
  ['26405', '7807'], // 翔べ! ガンダム / 池田 鴻 ↔ 池田鴻/フィーリングフリー/ミュージッククリエイション
  ['26505', '102326'], // 星の在り処 / う～み ↔ ファルコム/う～み
  ['26540', '162503'], // 倦怠ライフ・リターンズ! / 杉田智和 ↔ キョン(杉田智和)
  ['26556', '121767'], // 少女Q / 桃月学園1年C組 ↔ 桃月学園1年C組 feat.上原都(堀江由衣)
  ['26601', '163329'], // 明日は明日の 君が生まれる / AKB48 ↔ Chocolove from AKB48
  ['26633', '57892'], // 愛しいかけら / メロキュア ↔ メロキュア(岡崎律子/日向めぐみ)
  ['26655', '31939'], // Now or Never / CHEMISTRY ↔ CHEMISTRY meets m-flo
  ['26701', '163798'], // アンインストール / 石川智晶 ↔ 石川智晶(石川知亜紀)
  ['26731', '166809'], // 人として軸がぶれている / 大槻ケンヂと絶望少女達 ↔ 大槻ケンヂと絶望少女達(...)
  ['26745', '60710'], // Like an angel / 石川智晶 ↔ 石川智晶(石川知亜紀)
  ['26770', '13283'], // SEVENTH MOON / Fire bomber ↔ Fire Bomber featuring BASARA NEKKI
  ['26929', '135661'], // 本日、満開ワタシ色 / 桂ヒナギクwith白皇学院生徒会三人娘 ↔ 桂ヒナギク with ...
  ['26961', '162935'], // STORMBRINGER / JAM Project ↔ JAM Project(...)
  ['27655', '94213'], // ミライボウル / ももいろクローバーZ ↔ ももいろクローバー
  ['27800', '728174'], // Cutie Panther / BiBi ↔ BiBi ～... from μ's～
  ['27827', '726997'], // Starlog / ChouCho ↔ ChouCho(ちょうちょ)
  ['27895', '682372'], // QUESTION / 3年E組うた担 ↔ 3年E組うた担 (...)
  ['27897', '681824'], // もうそうえくすぷれす / 花澤香菜 ↔ 千石撫子(花澤香菜)
  ['27931', '682354'], // SIX SHAME FACES ~今夜も最高!!!!!!~ / トト子(...) ↔ トト子 feat....
  ['27948', '687699'], // Stay Alive / 高橋李依 ↔ エミリア (CV : 高橋李依)
  ['27952', '687133'], // SAKURAスキップ / Fourfolium ↔ fourfolium ...
  ['27962', '156842'], // 好きな人がいること / JY(知英) ↔ JY
  ['27991', '688892'], // Wishing / 水瀬いのり ↔ レム (CV:水瀬いのり)
  ['28652', '671090'], // 太陽のFlare Sherbet / 久保田未夢 ↔ そふぃ(cv.久保田未夢)
  ['28740', '696488'], // STEP by STEP UP / Fourfolium ↔ fourfolium ...
  ['28786', '423155'], // にめんせい☆ ウラオモテライフ! / 田中あいみ ↔ 土間うまる(CV:田中あいみ)
  ['28802', '689913'], // 旅立ちのうた / 3年E組うた担 ↔ 3年E組
  ['28991', '685194'], // EZ DO DANCE -K.O.P. REMIX- / 増田俊樹,武内駿輔 ↔ 仁科カヅキ vs ...
  ['52786', '443607'], // メイド・イン・トキメキ♪ / Ra*bits ↔ Ra*bits(...)
  ['52787', '692333'], // Neo Sanctuary / fine ↔ fine(...)
  ['68021', '425517'], // ルナティックDEStiNy / 蒼井翔太 ↔ 如月ルヰ (CV.蒼井翔太)
  ['68042', '439823'], // チカっとチカ千花っ / 小原好美 ↔ 藤原千花(CV.小原好美)
  ['68097', '441786'], // マッチョアネーム? / 石川界人 ↔ 街雄鳴造(CV:石川界人)
  ['68142', '444804'], // 魔法の川の子守唄 / 吉田羊 ↔ 吉田羊(イドゥナ王妃)
  ['68143', '444810'], // わたしにできること / 神田沙也加 ↔ 神田沙也加(アナ)
  ['68153', '444919'], // 1・2・3 / After the Rain ↔ After the Rain [そらる×まふまふ]
  ['68250', '448615'], // WHITE GRAVITY / WHITE GRAVITY ↔ WHITE GRAVITY[...]
  ['68265', '448749'], // Ready to / 諸星すみれ ↔ 影森みちる (CV:諸星すみれ)
  ['68310', '314362'], // 約束の絆 / 妖夢討伐隊 ↔ 妖夢討伐隊 ...
  ['68322', '486984'], // 灰色のサーガ / ChouCho ↔ ChouCho(ちょうちょ)
  ['68340', '486983'], // 快眠！安眠！スヤリスト生活 / 水瀬いのり ↔ スヤリス姫(CV.水瀬いのり)
  ['68382', '443457'], // サニードロップ / 山下七海 ↔ 大槻唯(CV:山下七海)
  ['68443', '693032'], // イシュカン・コミュニケーション / ちょろゴンず ↔ ちょろゴンず(...)
  ['68576', '493580'], // I Believe / 狩野翔 ↔ 松野千冬(CV:狩野翔)
  ['68734', '493581'], // Rest In Rampage / 水中雅章 ↔ 場地圭介(CV:水中雅章)
  ['68825', '618291'], // サインはＢ -アイ Solo Ver.- / Ｂ小町アイ ↔ B小町 アイ (CV:高橋李依)
] as const satisfies ReadonlyArray<readonly [string, string]>;

const REVIEWED_TIER_E_JOYS_BY_TJ = new Map<string, Set<string>>();
for (const [tj, joysound] of REVIEWED_TIER_E_STRONG_PAIRS) {
  const existing = REVIEWED_TIER_E_JOYS_BY_TJ.get(tj);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_E_JOYS_BY_TJ.set(tj, new Set([joysound]));
}

const EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT = 65;
const REVIEWED_TIER_E_FORBIDDEN_PAIRS = new Set([
  '26121|65623',
  '26121|77873',
  '26121|78108',
  '26121|78109',
  '26121|78110',
  '26121|78111',
  '26750|168779',
  '28852|631988',
  '68183|683200',
  '68258|445312',
  '68290|731408',
]);

function assertReviewedTierEPairInvariant(): void {
  if (REVIEWED_TIER_E_STRONG_PAIRS.length !== EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT) {
    throw new Error(
      `Tier E reviewed-strong allowlist must contain exactly ${EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT} pairs`,
    );
  }

  const pairs = new Set<string>();
  const tjs = new Set<string>();
  const joys = new Set<string>();
  for (const [tj, joysound] of REVIEWED_TIER_E_STRONG_PAIRS) {
    const pairKey = `${tj}|${joysound}`;
    if (pairs.has(pairKey)) throw new Error(`Tier E duplicate reviewed pair: ${pairKey}`);
    if (tjs.has(tj)) throw new Error(`Tier E duplicate TJ number in reviewed pairs: ${tj}`);
    if (joys.has(joysound))
      throw new Error(`Tier E duplicate JOYSOUND number in reviewed pairs: ${joysound}`);
    if (REVIEWED_TIER_E_FORBIDDEN_PAIRS.has(pairKey)) {
      throw new Error(`Tier E forbidden non-strong pair present in allowlist: ${pairKey}`);
    }
    pairs.add(pairKey);
    tjs.add(tj);
    joys.add(joysound);
  }
}

assertReviewedTierEPairInvariant();

/**
 * Structured warning emitted when records cluster via Tier B (fuzzy
 * title+artist) AND disagree on a vendor field neither side used as the
 * clustering key. The merger does NOT abort — highest-priority source wins
 * per the ownership table — but the warning is surfaced for the crawl PR
 * body summary.
 *
 * The `'tier_c_merge'`, `'tier_d_context_title_merge'`,
 * `'tier_e_artist_credit_merge'`, and `'tier_f_postcrawl_split_merge'` field
 * values document successful soft merges (one marker emitted per cluster, not
 * per record-pair) so the merge surfaces
 * in the crawl PR body for review. Sunset cadence per
 * `2026-05-01-kpop-leak-and-merge-fix-design.md` §3.C: 4 weeks of clean
 * cross-source output, then downgrade to a per-cluster log line.
 */
export interface MergeConflict {
  /**
   * Soft-merge cluster key. Tier B/C keys use `clusterKeyPart(title)|...`; Tier
   * D keys use `clusterKeyPart(refinedStripContext(title))|clusterKeyPart(artist)`;
   * Tier E keys use `tj:<number>|joysound:<number>` from the reviewed pair;
   * Tier F keys use `<vendor>:<number>|joysound:<number>` from the post-crawl
   * reviewed split-pair allowlist.
   * Conflict `cluster_key` strings are FOLDED since 2026-06-13 — cosmetic for
   * PR-body aggregation.
   */
  cluster_key: string;
  field:
    | 'tj'
    | 'ky'
    | 'joysound'
    | 'tier_c_merge'
    | 'tier_d_context_title_merge'
    | 'tier_e_artist_credit_merge'
    | 'tier_f_postcrawl_split_merge';
  values: { source: string; value: string }[];
  /** The value that wins per source priority, or the merged record id for marker rows. */
  winner: string;
}

export interface MergeResult {
  records: SongRecord[];
  conflicts: MergeConflict[];
}

/**
 * Filter out soft-merge marker entries so the headline "merge conflicts" count
 * reported to the crawl PR body / CLI stdout reflects only true vendor-number
 * disagreements.
 *
 * Fix B.1 (2026-05-01): Tier C merges are NOT disagreements — they're
 * successful soft-merges flagged for visibility. Tier D context-title merges
 * and Tier E reviewed-pair merges follow the same marker semantics. The full
 * conflicts list (and any `sample` slice) keeps marker entries for forensic
 * inspection; only the headline `total` is filtered. Centralised here so
 * `pipeline.ts` and `cli.ts` share one definition.
 */
export function headlineConflicts(conflicts: MergeConflict[]): MergeConflict[] {
  return conflicts.filter(
    (c) =>
      c.field !== 'tier_c_merge' &&
      c.field !== 'tier_d_context_title_merge' &&
      c.field !== 'tier_e_artist_credit_merge' &&
      c.field !== 'tier_f_postcrawl_split_merge',
  );
}

// --- Union-Find ----------------------------------------------------------

const VENDORS = ['tj', 'ky', 'joysound'] as const satisfies readonly (keyof KaraokeNumbers)[];

type Vendor = (typeof VENDORS)[number];

type NonJoysoundVendor = Exclude<Vendor, 'joysound'>;

/**
 * Tier F is a post-crawl residual split-pair allowlist derived from the
 * 2026-06-15 full JOYSOUND detail/ruby audit. Unlike Tier E, these pairs are
 * not all raw official `tj` ↔ `joysound` singletons: some are blog/tjpdf rows
 * that carry only a TJ/KY number and pair to a JOYSOUND-bearing row. Therefore
 * the deployable surface is still exact pair-level evidence, not a broad
 * artist-alias or title-only rule.
 *
 * Inclusion rules used to generate this first slice:
 * - broad audit bucket `proposed_strong` only;
 * - one best candidate, no same-provider conflict, unique target/JOY numbers;
 * - recomputed evidence is artist exact, target artist contained in candidate
 *   credit, or artist_ko exact with no collab/paren punctuation on either
 *   primary artist;
 * - explicitly excluded: feature-artist Korean-name leakage, short numeric
 *   artist tokens (`19` ↔ `19(ジューク)`), and the existing Tier E
 *   reviewed-but-not-strong pairs whose raw tieup/credit evidence is not
 *   retained in `SongRecord`.
 */
const REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS = [
  ['tj', '52784', '634289'], // うつくしい世界('出光興産' CM) / Aimer ↔ うつくしい世界 / Aimer
  ['tj', '28636', '166838'], // コスって!オーマイハニー / 平野綾 ↔ コスって!オーマイハニー / こなたとパティ(平野綾とささきのぞみ)
  ['ky', '44158', '689337'], // No title / Reol ↔ No title / れをる
  ['tj', '25041', '21879'], // LOVE 2000 / 安室奈美惠 ↔ LOVE 2000 / 安室奈美恵
  ['tj', '25048', '26759'], // 君のためにできること / Gackt ↔ 君のためにできること / GACKT(Gackt)
  ['tj', '25087', '20220'], // Mizerable / Gackt ↔ Mizerable / GACKT(Gackt)
  ['tj', '25107', '24986'], // U+K / Gackt ↔ U+K / GACKT(Gackt)
  ['tj', '25169', '22448'], // I WILL / 安室奈美惠 ↔ I WILL / 安室奈美恵
  ['tj', '25170', '11837'], // Another World / Gackt ↔ ANOTHER WORLD / GACKT(Gackt)
  ['tj', '25203', '26563'], // Think of me / 安室奈美惠 ↔ think of me / 安室奈美恵
  ['tj', '25208', '22704'], // 忘れないから / Gackt ↔ 忘れないから / GACKT(Gackt)
  ['tj', '25211', '26331'], // Secret Garden / Gackt ↔ Secret Garden / GACKT(Gackt)
  ['tj', '25214', '24085'], // Mirror / Gackt ↔ Mirror / GACKT(Gackt)
  ['tj', '25321', '14283'], // SWEET 19 BLUES / 安室奈美惠 ↔ SWEET 19 BLUES / 安室奈美恵
  ['tj', '25358', '9148'], // 太陽のSEASON / 安室奈美惠 ↔ 太陽のSEASON / 安室奈美恵
  ['tj', '25427', '9678'], // Chase the Chance / 安室奈美惠 ↔ Chase the Chance / 安室奈美恵
  ['tj', '25486', '24125'], // OASIS / Gackt ↔ OASIS / GACKT(Gackt)
  ['tj', '25515', '28526'], // shine more / 安室奈美惠 ↔ shine more / 安室奈美恵
  ['tj', '25520', '28590'], // 君が追いかけた夢 / Gackt ↔ 君が追いかけた夢 / GACKT(Gackt)
  ['tj', '25572', '28873'], // 月の詩 / Gackt ↔ 月の詩 / GACKT(Gackt)
  ['tj', '25637', '31857'], // SO CRAZY / 安室奈美惠 ↔ SO CRAZY / 安室奈美恵
  ['tj', '25656', '31959'], // Last Song / Gackt ↔ Last Song / GACKT(Gackt)
  ['tj', '25703', '22108'], // sha la la / Skoop On Somebody ↔ sha la la / Skoop On Somebody(SKOOP)
  ['tj', '25763', '36540'], // MARIA / Gackt ↔ Maria / GACKT(Gackt)
  ['tj', '25772', '30774'], // ALARM / 安室奈美惠 ↔ ALARM / 安室奈美恵
  ['tj', '25823', '58967'], // 暁の車(機動戦士ガンダムSEED) / Fiction Junction YUUKA ↔ 暁の車 / FictionJunction YUUKA
  ['tj', '25828', '32720'], // ALL FOR YOU / 安室奈美惠 ↔ ALL FOR YOU / 安室奈美恵
  ['tj', '25872', '71446'], // トイレットペッパーマン / SMAP ↔ トイレットペッパーマン / 中居正広(SMAP)
  ['tj', '25875', '10140'], // ロボキッス / ダブルユー ↔ ロボキッス / W(ダブルユー)
  ['tj', '25885', '10155'], // 君に逢いたくて / Gackt ↔ 君に逢いたくて / GACKT(Gackt)
  ['tj', '25983', '10756'], // Want me, want me / 安室奈美惠 ↔ WANT ME，WANT ME / 安室奈美恵
  ['tj', '25994', '17857'], // 愛の意味を教えて! / ダブルユー ↔ 愛の意味を教えて! / W(ダブルユー)
  ['tj', '26002', '9369'], // STOP THE MUSIC / 安室奈美惠 ↔ Stop the music / 安室奈美恵
  ['tj', '26113', '28630'], // Meteor―ミーティア―(機動戦士ガンダムSEED) / T.M.Revolution ↔ Meteor -ミーティア- / T.M.Revolution
  ['tj', '26117', '33867'], // Asrun Dream / Gackt ↔ Asrun Dream / GACKT(Gackt)
  ['tj', '26124', '18958'], // White Light / 安室奈美惠 ↔ White Light / 安室奈美恵
  ['tj', '26265', '59538'], // ヒトリジメ / GUMI ↔ ヒトリジメ / グミ
  ['tj', '26284', '52119'], // INDIGO BLUE LOVE / モーニング娘。 ↔ INDIGO BLUE LOVE / 新垣/田中/亀井(モーニング娘。)
  ['tj', '26351', '36777'], // 鋼の魂(スーパーロボットスピリッツ CM) / 水木一郎,影山ヒロノブ ↔ 鋼の魂 / 水木一郎/影山ヒロノブ
  ['tj', '26353', '23614'], // 君に贈る歌 / 小池徹平 ↔ 君に贈る歌 / 小池徹平(WaT)
  ['tj', '26419', '51537'], // Emotion(機動戦士ガンダムSEED Character Song) / 田中理恵 ↔ EMOTION / 田中理恵(ミーア・キャンベル)
  ['tj', '26439', '24536'], // FUNKY TOWN / 安室奈美惠 ↔ FUNKY TOWN / 安室奈美恵
  ['tj', '26593', '701067'], // Stay Gold / Hi-STANDARD ↔ STAY GOLD《本人映像》 / Hi-STANDARD
  ['tj', '26630', '164853'], // 君がくれたあの日 / 茅原美里 ↔ 君がくれたあの日 / 茅原実里
  ['tj', '26689', '168322'], // みくみくにしてあげる / 初音ミク ↔ みくみくにしてあげる♪ / ika_mo feat.初音ミク
  ['tj', '26755', '27477'], // WHAT A FEELING / 安室奈美惠 ↔ WHAT A FEELING / 安室奈美恵
  ['tj', '26852', '27845'], // Sexy Girl / 安室奈美惠 ↔ Sexy Girl / 安室奈美恵
  ['tj', '26897', '90344'], // WILD / 安室奈美惠 ↔ WILD / 安室奈美恵
  ['tj', '26903', '138428'], // 炉心融解 / 鏡音リン ↔ 炉心融解 / iroha(sasaki) feat.鏡音リン
  ['tj', '27004', '138537'], // 火葬曲 / 初音ミク ↔ 火葬曲 / No.D/上野悠仁 feat.初音ミク
  ['tj', '27029', '137780'], // Magnet / 初音ミク, 巡音ルカ ↔ magnet / minato(流星P) feat.初音ミク、巡音ルカ
  ['tj', '27035', '313880'], // 天樂 / 鏡音リン ↔ 天樂 / ゆうゆ feat.鏡音リン
  ['tj', '27225', '28994'], // Fighters / 三代目 J Soul Brothers ↔ FIGHTERS / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27246', '29443'], // リフレイン / 三代目 J Soul Brothers ↔ リフレイン / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27289', '106500'], // ハッピーシンセサイザ / 巡音ルカ,GUMI ↔ ハッピーシンセサイザ / EasyPop feat.巡音ルカ、GUMI
  ['tj', '27353', '31344'], // 花火 / 三代目 J Soul Brothers ↔ 花火 / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27441', '32984'], // SPARK / 三代目 J Soul Brothers ↔ SPARK / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '27512', '119208'], // くまモンもん / 森高千里 ↔ くまモンもん / くまモン[うた:森高千里]
  ['tj', '27736', '736117'], // 居酒屋「津軽」 / 大石まどか ↔ 居酒屋「津軽」 / 大石まどか(大石 円)
  ['tj', '27930', '119568'], // R.Y.U.S.E.I. / 三代目 J Soul Brothers ↔ R.Y.U.S.E.I. / 三代目 J SOUL BROTHERS from EXILE TRIBE
  ['tj', '28829', '698687'], // 四季折々に揺蕩いて / After the Rain ↔ 四季折々に揺蕩いて / After the Rain [そらる×まふまふ]
  ['tj', '28902', '174857'], // 卑怯戦隊うろたんだー / KAITO ↔ 卑怯戦隊うろたんだー / シンP feat.KAITO、MEIKO、初音ミク
  ['tj', '52418', '805808'], // 失礼しますが、RIP▽ / Mori Calliope ↔ 失礼しますが、RIP《本人映像》 / Mori Calliope
  ['tj', '52817', '629460'], // Keep on Moving ( 'アクエリアス'CM) / NEXZ ↔ Keep on Moving / NEXZ
  ['tj', '52869', '434866'], // Hello, Morning / KizunaAI ↔ Hello，Morning / KizunaAI(キズナアイ)
  ['tj', '52883', '635245'], // かもね / KizunaAI ↔ かもね / KizunaAI(キズナアイ)
  ['tj', '52970', '692552'], // 明日も('NTTドコモ' CM) / SHISHAMO ↔ 明日も / SHISHAMO
  ['tj', '6136', '2811'], // 悲しみのゆくえ / チョーヨンピル ↔ 悲しみのゆくえ / 趙容弼(チョー・ヨンピル)
  ['tj', '6194', '2840'], // 想いで迷子 / チョーヨンピル ↔ 想いで迷子 / 趙容弼(チョー・ヨンピル)
  ['tj', '6234', '2078'], // 涙の朝 / 八代亞紀 ↔ 涙の朝 / 八代亜紀
  ['tj', '6319', '2768'], // 私について / 工藤靜香 ↔ 私について / 工藤静香
  ['tj', '6320', '111441'], // 大田ブルース / 李 成愛 ↔ 大田ブルース / 李成愛(イ・ソンエ)
  ['tj', '6324', '2331'], // 離別(イビョル) / 李 成愛 ↔ 離別(イビョル) / 李成愛(イ・ソンエ)
  ['tj', '6334', '1898'], // 愛の共犯者 / チョーヨンピル ↔ 愛の共犯者 / 趙容弼(チョー・ヨンピル)
  ['tj', '6449', '27150'], // 蘇州夜曲 / 渡辺はま子 ↔ 蘇州夜曲 / 渡辺はま子/霧島昇
  ['tj', '6611', '2879'], // 出で湯橋 / 大川英策 ↔ 出で湯橋 / 大川栄策
  ['tj', '6633', '27068'], // さよならはダンスの後に / 倍賞千惠子 ↔ さよならはダンスの後に / 倍賞千恵子
  ['tj', '6653', '1391'], // 熱いさよなら / 五輪眞弓 ↔ 熱いさよなら / 五輪真弓
  ['tj', '6751', '27008'], // 下町の太陽 / 倍賞千惠子 ↔ 下町の太陽 / 倍賞千恵子
  ['tj', '6752', '1890'], // 紅い落葉 / チョーヨンピル ↔ 紅い落葉 / 趙容弼(チョー・ヨンピル)
  ['tj', '6778', '17094'], // 球 根 / Yellow Monkey ↔ 球根 / THE YELLOW MONKEY
  ['tj', '68628', '431052'], // 快感*エブリディ / B-PROJECT ↔ 快感*エブリディ / B-PROJECT[キタコレ・THRIVE・MooNs・KiLLER KiNG]
  ['tj', '68705', '610059'], // うらたねこ♀ / うらたぬき ↔ うらたねこ♀ / うらたぬき(浦島坂田船)
  ['tj', '68764', '492851'], // ワタシノミカタ / 夏川椎菜(Feat.HoneyWorks) ↔ ワタシノミカタ / mona(CV:夏川椎菜) feat. HoneyWorks
  ['tj', '6878', '19877'], // RESPECT the POWER OF LOVE / 安室奈美惠 ↔ RESPECT the POWER OF LOVE / 安室奈美恵
  ['tj', '6922', '17408'], // Nostalgia / 相川七瀨 ↔ Nostalgia / 相川七瀬
  ['tj', '6942', '24985'], // NEVER END / 安室奈美惠 ↔ NEVER END / 安室奈美恵
  ['tj', '6963', '18086'], // in the sky / 工藤靜香 ↔ in the sky / 工藤静香
  ['tj', '27542', '196477'], // 優しさの理由 / ChouCho ↔ 優しさの理由 / ChouCho(ちょうちょ)
  ['tj', '27874', '178358'], // 守るべきもの / 國分優香里 ↔ 守るべきもの / 沢田綱吉(國分優香里)
  ['tj', '27890', '166465'], // スキ?キライ!?スキ!!! / 釘宮理恵 ↔ スキ? キライ!? スキ!!! / ルイズ(釘宮理恵)
  ['tj', '28004', '71040'], // 1st Priority / メロキュア ↔ 1st Priority / メロキュア(岡崎律子/日向めぐみ)
  ['tj', '28048', '94825'], // Episode.0 / Gackt ↔ Episode.0 / GACKT(Gackt)
  ['tj', '28067', '136421'], // Heart Goes Boom!! / 日笠陽子 ↔ Heart Goes Boom!! / 秋山澪(日笠陽子)
  ['tj', '28070', '168186'], // Help Me, ERINNNNNN!! / ビートまりお ↔ Help me，ERINNNNNN!! / ビートまりお(COOL&CREATE)
  ['tj', '28088', '109803'], // Love Marginal / Printemps ↔ Love marginal / Printemps ～高坂穂乃果(新田恵海)、南ことり(内田彩)、小泉花陽(久保ユリカ) from μ's～
  ['tj', '28115', '20003'], // Redemption / Gackt ↔ REDEMPTION / GACKT(Gackt)
  ['tj', '28119', '138614'], // Ring My Bell / blue drops ↔ Ring My Bell / blue drops(吉田仁美&イカロス(早見沙織))
  ['tj', '28123', '125615'], // Select? / 茅原実里 ↔ SELECT? / 長門有希(茅原実里)
  ['tj', '28148', '139260'], // Treasure / 碧陽学園生徒会 ↔ Treasure / 碧陽学園生徒会(本多真梨子/斉藤佑圭/富樫美鈴/堀中優希)
  ['tj', '28151', '137949'], // Under Mebius / 茅原実里 ↔ under“Mebius” / 長門有希(茅原実里)
  ['tj', '28176', '722675'], // アイドル活動 / STAR☆ANIS ↔ アイドル活動! / わか・ふうり・すなお from STAR☆ANIS
  ['tj', '28179', '138579'], // エージェント夜を往く / 平田宏美 ↔ エージェント夜を往く / 菊地真(平田宏美)
  ['tj', '28184', '110810'], // オリオンで Shout Out / 谷山紀章 ↔ オリオンでSHOUT OUT / 四ノ宮那月(谷山紀章)
  ['tj', '28194', '731219'], // キミが光であるために / 小野賢章 ↔ キミが光であるために / 黒子テツヤ(CV.小野賢章)
  ['tj', '28201', '169339'], // クフフのフ~僕と契約~ / 飯田利信 ↔ クフフのフ ～僕と契約～ / 六道 骸(飯田利信)
  ['tj', '28250', '171544'], // ひとりぼっちの運命 / 近藤隆 ↔ ひとりぼっちの運命 / 雲雀恭弥(近藤隆)
  ['tj', '28253', '173631'], // ファミリー~約束の場所~ / 國分優香里 Withボンゴレファミリー ↔ ファミリー ～約束の場所～ / 沢田綱吉(國分優香里) with ボンゴレファミリー(ニーコ・市瀬秀和・井上優・木内秀信・近藤隆・飯田利信・竹内順子・津田健次郎・稲村優奈・吉田仁美・チャン・リーメイ)
  ['tj', '28268', '162483'], // まっがーれ↓スペクタクル / 小野大輔 ↔ まっがーれ↓スペクタクル / 古泉一樹(小野大輔)
  ['tj', '28281', '738026'], // ラブノベルス / BiBi ↔ ラブノベルス / BiBi ～絢瀬絵里(南條愛乃)、西木野真姫(Pile)、矢澤にこ(徳井青空) from μ's～
  ['tj', '28308', '669102'], // 冬がくれた予感 / BiBi ↔ 冬がくれた予感 / BiBi ～絢瀬絵里(南條愛乃)、西木野真姫(Pile)、矢澤にこ(徳井青空) from μ's～
  ['tj', '28315', '313909'], // 恋のヒメヒメぺったんこ / 田村ゆかり ↔ 恋のヒメヒメぺったんこ / 姫野湖鳥 (cv.田村ゆかり)
  ['tj', '28316', '723689'], // 恋は渾沌の隷也 / 後ろから這いより隊G ↔ 恋は渾沌の隷也 / 後ろから這いより隊G(ニャル子×クー子×珠緒)
  ['tj', '28320', '136364'], // 林檎もぎれビーム! / 大槻ケンヂと絶望少女達 ↔ 林檎もぎれビーム! / 大槻ケンヂと絶望少女達(風浦可符香、木津千里、木村カエレ、関内・マリア・太郎、日塔奈美)
  ['tj', '28347', '91884'], // 雪月花~The End Of Silence~ / Gackt ↔ 雪月花 -The end of silence- / GACKT(Gackt)
  ['tj', '28357', '60776'], // 水の証 / 田中理恵 ↔ 水の証 / 田中理恵(ラクス・クライン)
  ['tj', '28376', '198159'], // 月に叢雲華に風 / 幽閉サテライト ↔ 月に叢雲華に風 / 幽閉サテライト/senya
  ['tj', '28398', '162045'], // 天壌を翔る者たち / Love Planet Five ↔ 天壌を翔る者たち / Love Planet Five(I've special unit)
  ['tj', '28400', '670792'], // 青春サツバツ論 / 3年E組うた担 ↔ 青春サツバツ論 / 3年E組うた担 (渚&茅野&業&磯貝&前原)
  ['tj', '28406', '111543'], // 七色のコンパス / 宮野真守 ↔ 七色のコンパス / 一ノ瀬トキヤ(宮野真守)
  ['tj', '28407', '167106'], // 寝・逃・げでリセット! / 福原香織 ↔ 寝・逃・げでリセット! / 柊つかさ(福原香織)
  ['tj', '28409', '197839'], // 太陽曰く燃えよカオス / 後ろから這いより隊G ↔ 太陽曰く燃えよカオス / 後ろから這いより隊G(ニャル子×クー子×珠緒)
  ['tj', '28415', '736438'], // 回レ!雪月花 / 歌組雪月花 ↔ 回レ!雪月花 / 歌組雪月花 夜々 (CV 原田ひとみ) いろり (CV 茅野愛衣) 小紫 (CV 小倉唯)
  ['tj', '28421', '677993'], // かくしん的めたまるふぉ~ぜっ / 田中あいみ ↔ かくしん的☆めたまるふぉ～ぜっ! / 土間うまる(CV:田中あいみ)
  ['tj', '28460', '22254'], // ミニハムずの愛の唄 / ミニモニ。 ↔ ミニハムずの愛の唄 / ミニハムず(ミニモニ。)
  ['tj', '28518', '171072'], // 炎神戦隊ゴーオンジャー / 高橋秀幸 ↔ 炎神戦隊ゴーオンジャー / 高橋秀幸(Project.R)
  ['tj', '28577', '127980'], // 帰り道 / 加藤英美里 ↔ 帰り道 / 八九寺真宵(加藤英美里)
  ['tj', '28634', '76837'], // Fields of hope / 田中理恵 ↔ Fields of hope / 田中理恵(ラクス・クライン)
  ['tj', '28643', '173546'], // 無限回廊 / 田村ゆかり ↔ 無限回廊 / 古手梨花(田村ゆかり)
  ['tj', '28685', '693440'], // アンチクロックワイズ / After the Rain ↔ アンチクロックワイズ / After the Rain [そらる×まふまふ]
  ['tj', '28722', '693441'], // 解読不能 / After the Rain ↔ 解読不能 / After the Rain [そらる×まふまふ]
  ['tj', '28723', '692651'], // Los! Los! Los! / 悠木碧 ↔ Los! Los! Los! / ターニャ・デグレチャフ(CV:悠木碧)
  ['tj', '28796', '176015'], // 隣に... / たかはし智秋 ↔ 隣に・・・ / 三浦あずさ(たかはし智秋)
  ['tj', '28969', '136105'], // 蒼い鳥 / 今井麻美 ↔ 蒼い鳥 / 如月千早(今井麻美)
  ['tj', '68053', '430430'], // レッドナイト・ヴァンパイア / 武内駿輔,八代拓,内田雄馬 ↔ レッドナイト・ヴァンパイア / 大和アレクサンダー、十王院カケル、涼野ユウ(cv.武内駿輔、八代拓、内田雄馬)
  ['tj', '68064', '685969'], // nth color / 宍戸留美 ↔ nth color / 天羽ジュネ cv. 宍戸留美
  ['tj', '68082', '430428'], // Starved For You / 蒼井翔太,武内駿輔 ↔ Starved For You / 如月ルヰ、大和アレクサンダー(cv.蒼井翔太、武内駿輔)
  ['tj', '68262', '680296'], // 秘密のトワレ / 藍原ことみ ↔ 秘密のトワレ / 一ノ瀬志希(CV 藍原ことみ)
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT = 138;
const REVIEWED_TIER_F_FORBIDDEN_PAIRS = [
  ['tj', '28895', '441874'], // MISIA feat. HIDE(GReeeeN) matched to GReeeeN-only artist_ko donor
  ['tj', '25022', '11802'], // short numeric artist 19 requires manual review
  ['tj', '6927', '19868'], // short numeric artist 19 requires manual review
  ['tj', '6935', '21182'], // short numeric artist 19 requires manual review
  ['tj', '26750', '168779'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68183', '683200'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68258', '445312'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
  ['tj', '68290', '731408'], // Tier E reviewed-but-not-strong: raw tieup/credit evidence not retained
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS = new Map<
  string,
  Partial<Record<NonJoysoundVendor, string>>
>([
  // `No title` / Reol: the KY-only target attaches to a row that already has
  // the reviewed TJ↔JOY merge (`tj-28704` + JOY 689337). This is an explicit
  // triple, not a general permission to import arbitrary JOY-side TJ/KY cells.
  [reviewedTierFPairKey('ky', '44158', '689337'), { tj: '28704' }],
]);

function reviewedTierFPairKey(vendor: NonJoysoundVendor, number: string, joysound: string): string {
  return `${vendor}|${number}|${joysound}`;
}

function isReviewedTierFJoySideShape(
  vendor: NonJoysoundVendor,
  number: string,
  joysound: string,
  joy: SongRecord,
): boolean {
  if (joy.karaoke_numbers.joysound !== joysound || joy.karaoke_numbers[vendor] !== null) {
    return false;
  }
  if (nonNullVendorNumberCount(joy) === 1) return true;

  const allowedExtra = REVIEWED_TIER_F_ALLOWED_JOY_SIDE_EXTRA_PROVIDERS.get(
    reviewedTierFPairKey(vendor, number, joysound),
  );
  if (allowedExtra === undefined) return false;

  for (const extraVendor of ['tj', 'ky'] as const satisfies readonly NonJoysoundVendor[]) {
    if (extraVendor === vendor) continue;
    const actual = joy.karaoke_numbers[extraVendor];
    const expected = allowedExtra[extraVendor] ?? null;
    if (actual !== expected) return false;
  }
  return true;
}

const REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER = new Map<string, Set<string>>();
for (const [vendor, number, joysound] of REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS) {
  const key = `${vendor}:${number}`;
  const existing = REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER.get(key);
  if (existing) existing.add(joysound);
  else REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER.set(key, new Set([joysound]));
}

function assertReviewedTierFPairInvariant(): void {
  if (
    REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS.length !==
    EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT
  ) {
    throw new Error(
      `Tier F post-crawl allowlist must contain exactly ${EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT} pairs`,
    );
  }

  const pairs = new Set<string>();
  const vendorNumbers = new Set<string>();
  const joys = new Set<string>();
  const forbidden = new Set(
    REVIEWED_TIER_F_FORBIDDEN_PAIRS.map(([vendor, number, joysound]) =>
      reviewedTierFPairKey(vendor, number, joysound),
    ),
  );
  for (const [vendor, number, joysound] of REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS) {
    const pairKey = reviewedTierFPairKey(vendor, number, joysound);
    const vendorNumberKey = `${vendor}:${number}`;
    if (pairs.has(pairKey)) throw new Error(`Tier F duplicate reviewed pair: ${pairKey}`);
    if (vendorNumbers.has(vendorNumberKey))
      throw new Error(`Tier F duplicate target provider number: ${vendorNumberKey}`);
    if (joys.has(joysound)) throw new Error(`Tier F duplicate JOYSOUND number: ${joysound}`);
    if (forbidden.has(pairKey)) {
      throw new Error(`Tier F forbidden non-strong pair present in allowlist: ${pairKey}`);
    }
    pairs.add(pairKey);
    vendorNumbers.add(vendorNumberKey);
    joys.add(joysound);
  }
}

assertReviewedTierFPairInvariant();

type VendorIndexes = Record<Vendor, Map<string, number[]>>;

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      // biome-ignore lint/style/noNonNullAssertion: index is always within bounds
      root = this.parent[root]!;
    }
    // Path compression.
    let cur = i;
    while (this.parent[cur] !== root) {
      // biome-ignore lint/style/noNonNullAssertion: index is always within bounds
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function addToIndex(index: Map<string, number[]>, key: string, recordIndex: number): void {
  const existing = index.get(key);
  if (existing) existing.push(recordIndex);
  else index.set(key, [recordIndex]);
}

function buildVendorIndexes(records: SongRecord[]): VendorIndexes {
  const indexes: VendorIndexes = {
    tj: new Map<string, number[]>(),
    ky: new Map<string, number[]>(),
    joysound: new Map<string, number[]>(),
  };

  for (let i = 0; i < records.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const r = records[i]!;
    for (const vendor of VENDORS) {
      const value = r.karaoke_numbers[vendor];
      if (value !== null) addToIndex(indexes[vendor], value, i);
    }
  }

  return indexes;
}

function unionIndexedDuplicates(uf: UnionFind, indexes: Iterable<Map<string, number[]>>): void {
  for (const index of indexes) {
    for (const idxs of index.values()) {
      if (idxs.length < 2) continue;
      // biome-ignore lint/style/noNonNullAssertion: length >= 2
      const first = idxs[0]!;
      for (let k = 1; k < idxs.length; k++) {
        // biome-ignore lint/style/noNonNullAssertion: k in bounds
        uf.union(first, idxs[k]!);
      }
    }
  }
}

function countRoots(uf: UnionFind, size: number): Map<number, number> {
  const sizeByRoot = new Map<number, number>();
  for (let i = 0; i < size; i++) {
    const root = uf.find(i);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }
  return sizeByRoot;
}

function groupSingletonsByKey(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
  keyForRecord: (record: SongRecord) => string | null,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = keyForRecord(records[i]!);
    if (key === null) continue;
    addToIndex(groups, key, i);
  }
  return groups;
}

function unionIndexGroups(uf: UnionFind, groups: Iterable<number[]>): Set<number> {
  const roots = new Set<number>();
  for (const idxs of groups) {
    if (idxs.length < 2) continue;
    // biome-ignore lint/style/noNonNullAssertion: length >= 2
    const first = idxs[0]!;
    for (let k = 1; k < idxs.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: k in bounds
      uf.union(first, idxs[k]!);
    }
    roots.add(uf.find(first));
  }
  return roots;
}

function hasMultipleSourceSlugs(records: SongRecord[], idxs: number[]): boolean {
  const slugs = new Set<string>();
  for (const i of idxs) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    slugs.add(sourceSlug(records[i]!));
  }
  return slugs.size >= 2;
}

function shouldUnionTierCGroup(records: SongRecord[], idxs: number[]): boolean {
  return hasMultipleSourceSlugs(records, idxs);
}

function hasContextStrippedTitle(records: SongRecord[], idxs: number[]): boolean {
  for (const i of idxs) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    if (stripContextSuffix(records[i]!.title_primary).changed) return true;
  }
  return false;
}

function shouldUnionTierDGroup(records: SongRecord[], idxs: number[]): boolean {
  return hasMultipleSourceSlugs(records, idxs) && hasContextStrippedTitle(records, idxs);
}

function singletonVendorIndex(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
  vendor: Vendor,
): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const root = uf.find(i);
    if (sizeByRoot.get(root) !== 1) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const value = records[i]!.karaoke_numbers[vendor];
    if (value !== null) index.set(value, i);
  }
  return index;
}

function tierEClusterKey(tj: string, joysound: string): string {
  return `tj:${tj}|joysound:${joysound}`;
}

function tierFClusterKey(vendor: NonJoysoundVendor, number: string, joysound: string): string {
  return `${vendor}:${number}|joysound:${joysound}`;
}

function nonNullVendorNumberCount(record: SongRecord): number {
  let count = 0;
  for (const vendor of VENDORS) {
    if (record.karaoke_numbers[vendor] !== null) count += 1;
  }
  return count;
}

function collectTierEReviewedStrongGroups(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const tjIndex = singletonVendorIndex(records, uf, sizeByRoot, 'tj');
  const joysoundIndex = singletonVendorIndex(records, uf, sizeByRoot, 'joysound');

  for (const [tj, joysoundValues] of REVIEWED_TIER_E_JOYS_BY_TJ) {
    const tjIdx = tjIndex.get(tj);
    if (tjIdx === undefined) continue;
    for (const joysound of joysoundValues) {
      const joyIdx = joysoundIndex.get(joysound);
      if (joyIdx === undefined || joyIdx === tjIdx) continue;
      // Tier E was reviewed specifically as raw TJ official ↔ raw JOYSOUND
      // official evidence. A blog/manual singleton carrying one of the same
      // numbers should not widen this 65-pair data change implicitly.
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      if (sourceSlug(records[tjIdx]!) !== 'tj' || sourceSlug(records[joyIdx]!) !== 'joysound')
        continue;
      const idxs = [tjIdx, joyIdx];
      if (!hasMultipleSourceSlugs(records, idxs)) continue;
      groups.set(tierEClusterKey(tj, joysound), idxs);
    }
  }

  return groups;
}

function collectTierFPostcrawlReviewedGroups(
  records: SongRecord[],
  uf: UnionFind,
  sizeByRoot: Map<number, number>,
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  const targetIndexes: Record<NonJoysoundVendor, Map<string, number>> = {
    tj: singletonVendorIndex(records, uf, sizeByRoot, 'tj'),
    ky: singletonVendorIndex(records, uf, sizeByRoot, 'ky'),
  };
  const joysoundIndex = singletonVendorIndex(records, uf, sizeByRoot, 'joysound');

  for (const [vendorNumberKey, joysoundValues] of REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER) {
    const [vendor, number] = vendorNumberKey.split(':') as [NonJoysoundVendor, string];
    const targetIdx = targetIndexes[vendor].get(number);
    if (targetIdx === undefined) continue;
    for (const joysound of joysoundValues) {
      const joyIdx = joysoundIndex.get(joysound);
      if (joyIdx === undefined || joyIdx === targetIdx) continue;
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      const target = records[targetIdx]!;
      // biome-ignore lint/style/noNonNullAssertion: indexes came from records
      const joy = records[joyIdx]!;

      // Preserve the audit scope: target side must still be a single TJ/KY-only
      // row, and the JOYSOUND side must not already carry that same provider.
      if (nonNullVendorNumberCount(target) !== 1) continue;
      if (target.karaoke_numbers[vendor] !== number || target.karaoke_numbers.joysound !== null)
        continue;
      // The reviewed surface is a split pair, not an implicit triple merge:
      // the JOYSOUND-side row must stay JOY-only unless this exact pair also
      // lists an explicit, already-reviewed extra provider number.
      if (!isReviewedTierFJoySideShape(vendor, number, joysound, joy)) continue;

      const cluster = [target, joy];
      if (collectVendorNumberConflicts(cluster).length > 0) continue;
      groups.set(tierFClusterKey(vendor, number, joysound), [targetIdx, joyIdx]);
    }
  }

  return groups;
}

interface VendorNumberConflict {
  vendor: Vendor;
  contributions: { slug: string; value: string }[];
  winner: string;
}

function collectVendorNumberConflicts(cluster: SongRecord[]): VendorNumberConflict[] {
  const out: VendorNumberConflict[] = [];
  for (const vendor of VENDORS) {
    const contributions: { slug: string; value: string }[] = [];
    for (const r of cluster) {
      const value = r.karaoke_numbers[vendor];
      if (value !== null) contributions.push({ slug: sourceSlug(r), value });
    }
    if (new Set(contributions.map((c) => c.value)).size <= 1) continue;

    let winner = contributions[0];
    if (!winner) continue;
    let winnerRank = sourceRank(winner.slug);
    for (let i = 1; i < contributions.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const c = contributions[i]!;
      const rank = sourceRank(c.slug);
      if (rank < winnerRank) {
        winner = c;
        winnerRank = rank;
      }
    }
    out.push({ vendor, contributions, winner: winner.value });
  }
  return out;
}

function recordTierDBlockedConflicts(
  conflicts: MergeConflict[],
  clusterKey: string,
  cluster: SongRecord[],
): void {
  for (const conflict of collectVendorNumberConflicts(cluster)) {
    conflicts.push({
      cluster_key: clusterKey,
      field: conflict.vendor,
      values: conflict.contributions.map((c) => ({ source: c.slug, value: c.value })),
      winner: conflict.winner,
    });
  }
}

function collectClusters(uf: UnionFind, size: number): Map<number, number[]> {
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    const root = uf.find(i);
    const arr = clusters.get(root);
    if (arr) arr.push(i);
    else clusters.set(root, [i]);
  }
  return clusters;
}

// --- Per-field ownership ------------------------------------------------

/**
 * Pick the first non-null value found by walking `ownerOrder` source slugs
 * in priority order. Within a slug, multiple records' contributions are
 * scanned in input order; the first non-null hit wins.
 */
function pickByOwnership<T>(
  cluster: SongRecord[],
  ownerOrder: readonly string[],
  field: (r: SongRecord) => T | null,
): T | null {
  for (const slug of ownerOrder) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug) {
        const v = field(r);
        if (v !== null) return v;
      }
    }
  }
  // Fallback: any record in the cluster from a non-listed source.
  for (const r of cluster) {
    const v = field(r);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Pick a string field by source priority — the highest-priority contributing
 * source's value wins. Used for `id` and `source_url` (the v1 tiebreak rule
 * retained for stable cross-source attribution).
 */
function pickByPriority(cluster: SongRecord[], field: (r: SongRecord) => string): string {
  let winner = cluster[0];
  if (!winner) throw new Error('empty cluster');
  let winnerRank = sourceRank(sourceSlug(winner));
  for (let i = 1; i < cluster.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by cluster length
    const r = cluster[i]!;
    const rank = sourceRank(sourceSlug(r));
    if (rank < winnerRank) {
      winner = r;
      winnerRank = rank;
    }
  }
  return field(winner);
}

/**
 * Merge a cluster's vendor numbers field-by-field.
 *
 *  - For each vendor (tj/ky/joysound), union all non-null contributions.
 *  - When multiple records contribute DIFFERENT non-null values for the SAME
 *    vendor, the highest-priority source's value wins (chain blog→tj→tjpdf→joysound).
 *  - If `tierBClusterKey` is non-null AND disagreement is detected on a
 *    vendor field that was NOT the clustering key, emit a `MergeConflict`.
 *    (Tier A clusters can't disagree on the joining vendor — they share it
 *    by construction — but they CAN disagree on other vendors; those are
 *    silently resolved by priority since the cluster identity is solid.)
 */
function mergeKaraokeNumbers(
  cluster: SongRecord[],
  tierBClusterKey: string | null,
  conflicts: MergeConflict[],
): KaraokeNumbers {
  const result: KaraokeNumbers = { tj: null, ky: null, joysound: null };

  for (const vendor of VENDORS) {
    // Collect (slug, value) pairs of non-null contributions.
    const contributions: { slug: string; value: string }[] = [];
    for (const r of cluster) {
      const v = r.karaoke_numbers[vendor];
      if (v !== null) {
        contributions.push({ slug: sourceSlug(r), value: v });
      }
    }
    if (contributions.length === 0) continue;

    // Highest-priority winner for this vendor.
    let winner = contributions[0];
    if (!winner) continue;
    let winnerRank = sourceRank(winner.slug);
    for (let i = 1; i < contributions.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const c = contributions[i]!;
      const rank = sourceRank(c.slug);
      if (rank < winnerRank) {
        winner = c;
        winnerRank = rank;
      }
    }
    result[vendor] = winner.value;

    // Conflict detection: Tier B cluster + disagreeing non-null values.
    if (tierBClusterKey !== null) {
      const distinctValues = new Set(contributions.map((c) => c.value));
      if (distinctValues.size > 1) {
        conflicts.push({
          cluster_key: tierBClusterKey,
          field: vendor,
          values: contributions.map((c) => ({ source: c.slug, value: c.value })),
          winner: winner.value,
        });
      }
    }
  }

  return result;
}

/**
 * Union the cluster's `artist_aliases` arrays (preserving first-seen order),
 * filter out any alias equal to the merged record's `artist_primary`, and
 * return undefined when the union is empty (the schema prefers absence over
 * `[]` for storage compactness — see §2.B of the alias-dedup spec).
 *
 * The canonical-only filter (`a === mergedArtistPrimary`) is correct because
 * upstream propagation (Phase 3 of `resolveArtistAliases`) guarantees that by
 * the time records reach the merger, any re-keyed record's `artist_primary` is
 * already the canonical surface form. The loser's canonical therefore equals
 * the winner's canonical, so filtering on the merged primary is sufficient to
 * suppress self-aliases without any additional lookup.
 */
function mergeArtistAliases(
  cluster: SongRecord[],
  mergedArtistPrimary: string,
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of cluster) {
    const aliases = r.artist_aliases;
    if (!aliases) continue;
    for (const a of aliases) {
      if (a === mergedArtistPrimary) continue;
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Pick the cluster member whose `title_ko` was selected by `pickByOwnership`
 * walking `koChain`. Both passes walk the chain in identical order so the
 * chosen donor is always the same record whose `title_ko` wins the merge —
 * keeping the trio (`title_ko`, `title_ko_source`, `title_ko_confidence`) and
 * `media_context_ko` coherent on a single record.
 *
 * Two-pass strategy:
 *   1. Prefer a record that has a non-null `title_ko` AND matches a chain slug.
 *   2. Latin-titled fallback: `title_ko` may be null but `media_context_ko`
 *      may be set (e.g. an anime track with a Latin title whose only Korean
 *      signal is the media-context parenthetical).
 *
 * Returns `null` when the cluster has no KO signal at all (all fields absent).
 */
function pickKoDonor(cluster: SongRecord[], koChain: readonly string[]): SongRecord | null {
  // Pass 1: record whose title_ko was selected.
  for (const slug of koChain) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug && r.title_ko !== null) return r;
    }
  }
  // Pass 2: Latin-titled fallback — title_ko is null but media_context_ko set.
  for (const slug of koChain) {
    for (const r of cluster) {
      if (sourceSlug(r) === slug && r.media_context_ko !== undefined) return r;
    }
  }
  // Fallback: any record in the cluster with a media_context_ko (non-listed source).
  for (const r of cluster) {
    if (r.media_context_ko !== undefined) return r;
  }
  return null;
}

function latestCrawledAt(cluster: SongRecord[]): string {
  let latest = cluster[0]?.crawled_at ?? '';
  for (const r of cluster) {
    if (r.crawled_at > latest) latest = r.crawled_at;
  }
  return latest;
}

function optionalKoFields(koDonor: SongRecord | null): Partial<SongRecord> {
  return {
    // Optional KO-pipeline fields: spread from the single donor so the trio
    // (media_context_ko, title_ko_source, title_ko_confidence) stays coherent.
    // Absence is preferred over undefined/null (schema uses optional, not nullable).
    ...(koDonor?.media_context_ko !== undefined
      ? { media_context_ko: koDonor.media_context_ko }
      : {}),
    ...(koDonor?.title_ko_source !== undefined ? { title_ko_source: koDonor.title_ko_source } : {}),
    ...(koDonor?.title_ko_confidence !== undefined
      ? { title_ko_confidence: koDonor.title_ko_confidence }
      : {}),
  };
}

function recordTierCConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  tierBClusterKey: string | null,
): void {
  // Tier C: emit one structured warning per cluster (NOT per record-pair) so
  // the cross-source merge surfaces in the crawl PR body. Sunset per §3.C.
  const cKey = tierCKey(cluster[0] as SongRecord) ?? tierBClusterKey ?? '';
  conflicts.push({
    cluster_key: cKey,
    field: 'tier_c_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierDConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_d_context_title_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierEConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_e_artist_credit_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function recordTierFConflict(
  conflicts: MergeConflict[],
  cluster: SongRecord[],
  winner: string,
  clusterKey: string,
): void {
  conflicts.push({
    cluster_key: clusterKey,
    field: 'tier_f_postcrawl_split_merge',
    values: cluster.map((r) => ({ source: sourceSlug(r), value: r.id })),
    winner,
  });
}

function compareNullableTj(a: string | null, b: string | null): number {
  // Null TJ records sort last regardless of the other side's codepoint.
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (a !== null && b !== null) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function compareMergedRecords(a: SongRecord, b: SongRecord): number {
  const tjOrder = compareNullableTj(a.karaoke_numbers.tj, b.karaoke_numbers.tj);
  if (tjOrder !== 0) return tjOrder;

  const an = normalize(a.title_primary);
  const bn = normalize(b.title_primary);
  if (an < bn) return -1;
  if (an > bn) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sortMergedRecords(records: SongRecord[]): void {
  records.sort(compareMergedRecords);
}

/**
 * Conservative Korean display-key normalization used ONLY by cross-record
 * `artist_ko` propagation (NOT the shared `normalize()`): NFKC + locale-
 * independent lowercase + strip ALL whitespace. It deliberately KEEPS
 * punctuation and script, so it treats spacing differences as equivalent
 * (`마키하라 노리유키` ≡ `마키하라노리유키`) while treating spelling differences
 * (`마키하라 노리유키` ≠ `하타 모토히로`) as a genuine conflict. `normalize()`
 * is wrong here — its `\p{L}\p{N}\p{M}` strip would fold distinct punctuation
 * apart and is meant for identity keying, not Korean display agreement.
 */
function koDisplayKey(s: string): string {
  return s.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, '');
}

/**
 * Cross-record `artist_ko` propagation (spec 2026-06-14). Runs AFTER clusters
 * are materialized: standalone JOYSOUND rows by the same artist are NOT in the
 * same song cluster (no shared karaoke number, different title), so the
 * per-cluster `KO_CHAIN` fill in `mergeCluster` cannot reach them.
 *
 * This is NOT a song merge — it never unions karaoke numbers or collapses
 * rows. It only fills a MISSING `artist_ko` when:
 *   - records share the conservative full-artist identity key
 *     `normalize(artist_primary)` (empty-after-normalize keys are unkeyable
 *     and never propagate), AND
 *   - every donor (record with a non-null `artist_ko`) for that key agrees
 *     after `koDisplayKey` (whitespace-insensitive). If donors disagree the
 *     ENTIRE key group is skipped — no partial fill, no source-based choice.
 *
 * When safe, the display value is chosen by the KO ownership source priority
 * (`SOURCE_RANK`: blog > tj > tjpdf > joysound), with an `id`-ascending
 * tie-break for determinism, then outer whitespace is trimmed. Existing
 * non-null `artist_ko` values are NEVER overwritten — even by a higher-priority
 * donor. Records are not mutated: filled rows are returned as fresh objects and
 * untouched rows pass through by reference.
 */
function propagateArtistKo(records: SongRecord[]): SongRecord[] {
  // Group record indexes by the conservative full-artist identity key.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const key = normalize(records[i]!.artist_primary);
    if (key === '') continue; // unkeyable — never propagate across empties
    addToIndex(groups, key, i);
  }

  // Per group, decide the single safe display value to fill (if any).
  const fillByIndex = new Map<number, string>();
  for (const idxs of groups.values()) {
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const donors = idxs.map((i) => records[i]!).filter((r) => r.artist_ko !== null);
    if (donors.length === 0) continue;

    // Conflict guard: all donor values must agree (whitespace-insensitive).
    const displayKeys = new Set(donors.map((r) => koDisplayKey(r.artist_ko as string)));
    if (displayKeys.size > 1) continue;

    // Pick the display value by KO ownership priority, id-ascending tie-break.
    let winner = donors[0];
    if (!winner) continue;
    let winnerRank = sourceRank(sourceSlug(winner));
    for (let k = 1; k < donors.length; k++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by length
      const d = donors[k]!;
      const rank = sourceRank(sourceSlug(d));
      if (rank < winnerRank || (rank === winnerRank && d.id < winner.id)) {
        winner = d;
        winnerRank = rank;
      }
    }
    const value = (winner.artist_ko as string).trim();
    // Schema requires artist_ko minLength 1; never fill with an empty surface.
    if (value === '') continue;

    for (const i of idxs) {
      // biome-ignore lint/style/noNonNullAssertion: i in bounds
      if (records[i]!.artist_ko === null) fillByIndex.set(i, value);
    }
  }

  if (fillByIndex.size === 0) return records;

  return records.map((r, i) => {
    const fill = fillByIndex.get(i);
    return fill === undefined ? r : { ...r, artist_ko: fill };
  });
}

function mergeCluster(
  cluster: SongRecord[],
  wasTierB: boolean,
  wasTierC: boolean,
  wasTierD: boolean,
  wasTierE: boolean,
  tierEClusterKeyValue: string | null,
  wasTierF: boolean,
  tierFClusterKeyValue: string | null,
  conflicts: MergeConflict[],
): SongRecord {
  if (cluster.length === 0) throw new Error('empty cluster');

  // Tier C/D clusters reuse Tier B's vendor-conflict reporting surface under a
  // folded soft-key shape so existing PR-body aggregation continues to work.
  const softClusterKey =
    wasTierF && tierFClusterKeyValue !== null
      ? tierFClusterKeyValue
      : wasTierE && tierEClusterKeyValue !== null
        ? tierEClusterKeyValue
        : wasTierD && cluster[0]
          ? tierDKey(cluster[0])
          : wasTierB || wasTierC
            ? tierBKey(cluster[0] as SongRecord)
            : null;

  const mergedArtistPrimary =
    pickByOwnership(cluster, TITLE_ARTIST_CHAIN, (r) => r.artist_primary) ??
    cluster[0]?.artist_primary ??
    '';
  const mergedAliases = mergeArtistAliases(cluster, mergedArtistPrimary);
  // Pick the single donor record for the KO optional-field trio so that
  // title_ko_source, title_ko_confidence, and media_context_ko stay paired
  // with the record whose title_ko was selected. This preserves the schema
  // cross-field constraint (title_ko_confidence valid only when
  // title_ko_source === 'llm-translated') because both fields travel together
  // from a donor that already satisfied the constraint.
  const koDonor = pickKoDonor(cluster, KO_CHAIN);
  const merged: SongRecord = {
    id: pickByPriority(cluster, (r) => r.id),
    source_url: pickByPriority(cluster, (r) => r.source_url),
    title_primary:
      pickByOwnership(cluster, TITLE_ARTIST_CHAIN, (r) => r.title_primary) ??
      // Field is non-null in the schema; this fallback should be unreachable
      // but is kept type-safe.
      cluster[0]?.title_primary ??
      '',
    title_ko: pickByOwnership(cluster, KO_CHAIN, (r) => r.title_ko),
    artist_primary: mergedArtistPrimary,
    artist_ko: pickByOwnership(cluster, KO_CHAIN, (r) => r.artist_ko),
    // Spec 2026-05-04: union artist_aliases across the cluster, filtering out
    // any alias that equals the merged canonical (defense-in-depth — the
    // resolver already excludes this case, but a Tier C cluster could pick a
    // non-resolver-emitted canonical via `pickByOwnership`).
    ...(mergedAliases !== undefined ? { artist_aliases: mergedAliases } : {}),
    karaoke_numbers: mergeKaraokeNumbers(cluster, softClusterKey, conflicts),
    crawled_at: latestCrawledAt(cluster),
    ...optionalKoFields(koDonor),
  };

  if (wasTierC) recordTierCConflict(conflicts, cluster, merged.id, softClusterKey);
  if (wasTierD) recordTierDConflict(conflicts, cluster, merged.id, softClusterKey ?? '');
  if (wasTierE) recordTierEConflict(conflicts, cluster, merged.id, softClusterKey ?? '');
  if (wasTierF) recordTierFConflict(conflicts, cluster, merged.id, softClusterKey ?? '');

  return merged;
}

// --- Public API ----------------------------------------------------------

/**
 * Six-tier dedup + per-field-ownership merge.
 *
 *   Tier A (hard match): per-vendor union-find. Records sharing a non-null
 *   value on the same vendor field (`karaoke_numbers.tj` / `.ky` /
 *   `.joysound`) are unioned. Per-vendor — TJ #100 and KY #100 are unrelated.
 *
 *   Tier B (soft match): records still in singleton clusters after Tier A
 *   are grouped by the FOLDED key
 *   `clusterKeyPart(title_primary) + "|" + clusterKeyPart(artist_primary)`
 *   (`normalize()` + dash/long-vowel fold) and unioned. Groups brought
 *   together BY the fold (≥ 2 distinct unfolded keys) additionally require
 *   ≥ 2 distinct source slugs — same-source dash-variant twins stay split
 *   (see the gate comment in the implementation). Records with no peer
 *   remain standalone.
 *
 *   Tier C (cross-source primary-token match): residual singletons after
 *   Tier B are grouped by the folded key
 *   `clusterKeyPart(title) | foldDashes(getLeadComponent(artist))`
 *   — the latter strips collab/feat. decoration so e.g. `椎名もた(Feat.鏡音リン)`
 *   matches `椎名もた｜ぽわぽわP`. A Tier C cluster fires ONLY when ≥ 2 distinct
 *   source prefixes are represented (cross-source case). Same-source clusters
 *   never union: this preserves the BTS-IDOL guard (`tj-98374 IDOL/방탄소년단`
 *   vs `tj-98392 IDOL/방탄소년단(Feat.Nicki Minaj)` are distinct releases that
 *   share a primary token). Each fired cluster emits a
 *   `MergeConflict { field: 'tier_c_merge' }` for crawl-PR-body visibility
 *   (sunset cadence per design doc §3.C).
 *
 *   Tier D (guarded context-suffix title match): residual singletons after
 *   Tier C are grouped by
 *   `clusterKeyPart(refinedStripContext(title)) | clusterKeyPart(full artist)`.
 *   This catches TJ-style trailing work-role parentheticals such as
 *   `(化物語 OP)` / `('プロセカ' OST)` when JOYSOUND has the bare title. It
 *   fires only cross-source, only when at least one title actually stripped,
 *   preserves version/size/remix/etc. suffixes, and blocks auto-union when the
 *   candidate group has multiple non-null values for the same vendor field.
 *   Successful groups emit `tier_d_context_title_merge`; blocked groups stay
 *   split and emit ordinary vendor-number conflicts for review.
 *
 *   Tier E (reviewed strong artist-credit pairs): residual singletons after
 *   Tier D are joined only when their TJ/JOYSOUND numbers match the exact
 *   65-pair raw-reviewed allowlist. This intentionally avoids a broad
 *   artist-containment rule because raw tieup/credit fields are not retained
 *   in `SongRecord`; reviewed-but-not-strong and multi-variant cases stay
 *   split. Successful groups emit `tier_e_artist_credit_merge`.
 *
 *   Tier F (post-crawl reviewed residual split pairs): residual singletons after
 *   Tier E are joined only when their TJ/KY and JOYSOUND numbers match the
 *   exact 2026-06-15 broad-audit `proposed_strong` allowlist after additional
 *   recomputed safety filters. This captures same-song single-provider splits
 *   without broadening title-only, fuzzy, reverse-containment, or multi-candidate
 *   queues. Successful groups emit `tier_f_postcrawl_split_merge`.
 *
 *   Per-cluster ownership: each output field is taken from the
 *   highest-priority contributing source per the spec's per-field table.
 *   See `mergeCluster` for the chains.
 *
 * Determinism: cluster output is sorted by
 *   1) `karaoke_numbers.tj` ascending — null TJ records sort last (explicit
 *      null-handling, see Fix A.1 in the sort comparator below).
 *   2) `normalize(title_primary)` ascending — locale-stable string compare.
 *   3) `id` ascending.
 *
 * Conflict warnings (Tier B vendor-number disagreements + Tier C/D/E/F cluster
 * fires + Tier D blocked vendor-number disagreements) are returned in
 * `result.conflicts`. Console output is forbidden — callers aggregate them.
 */
export function mergeRecords(records: SongRecord[]): MergeResult {
  const conflicts: MergeConflict[] = [];
  const n = records.length;
  if (n === 0) return { records: [], conflicts };

  const uf = new UnionFind(n);

  // --- Tier A: per-vendor union-find ---
  // Three separate index maps. TJ and KY values that happen to match
  // numerically must NOT cluster.
  const vendorIndexes = buildVendorIndexes(records);
  unionIndexedDuplicates(
    uf,
    VENDORS.map((vendor) => vendorIndexes[vendor]),
  );

  // --- Tier B: fallback for records still in singleton clusters ---
  // A record is "still alone" iff its UF root only points to itself among
  // the input set. Compute cluster sizes first, then group singletons by
  // tierBKey and union them.
  const sizeByRoot = countRoots(uf, n);
  const tierBGroups = groupSingletonsByKey(records, uf, sizeByRoot, tierBKey);

  // Track which roots were formed via Tier B so we can scope conflict
  // detection to those clusters only.
  //
  // Dash-fold cross-source gate (2026-06-13): Tier B groups are keyed by the
  // FOLDED key (`clusterKeyPart`). A group whose members all share the same
  // UN-folded key behaves exactly as pre-fold Tier B (union unconditionally).
  // When the dash fold is what brought members together (≥ 2 distinct
  // unfolded keys), the union additionally requires ≥ 2 distinct source
  // slugs — the same cross-source gate Tier C uses. Rationale: a vendor that
  // catalogs two dash-variant spellings side-by-side is cataloging two
  // DISTINCT entries (JOYSOUND lists PUFFY's スイスイ #35118, lyricist
  // 大貫亜美, AND スーイスーイ #35183, lyricist 吉村由美 — different songs),
  // whereas a cross-source dash variant is transcription habit (TJ writes
  // `ー` as ASCII `-`). Same-source groups that fail the gate fall back to
  // pre-fold behavior: their unfolded-key partitions union independently.
  const tierBRoots = new Set<number>();
  for (const idxs of tierBGroups.values()) {
    if (idxs.length < 2) continue;
    const partitions = new Map<string, number[]>();
    for (const i of idxs) {
      // biome-ignore lint/style/noNonNullAssertion: i in bounds
      addToIndex(partitions, tierBKeyUnfolded(records[i]!), i);
    }
    const unionable: Iterable<number[]> =
      partitions.size === 1 || hasMultipleSourceSlugs(records, idxs) ? [idxs] : partitions.values();
    for (const root of unionIndexGroups(uf, unionable)) tierBRoots.add(root);
  }

  // --- Tier C: cross-source residual-singleton clustering ---
  // After Tier B, compute cluster sizes; records still in singletons go
  // through Tier C's `tierCKey` grouping. Gate on cross-source membership
  // (≥ 2 distinct source prefixes) — without the gate, two same-source
  // records like `tj-98374 IDOL/방탄소년단` and `tj-98392 IDOL/방탄소년단(Feat.Nicki Minaj)`
  // would wrongly merge.
  //
  // Fix A.5 (2026-05-01): size-after-B and tier-C grouping are computed in
  // a single pass. The previous version iterated the corpus 3× (size, group,
  // and a third pass during materialization); on a 26k-record corpus that
  // was 3 × O(n) where one pass would suffice. This still does TWO passes
  // because `sizeAfterB.get(root)` requires every root to be counted before
  // any singleton is filtered — so we count, then group.
  const sizeAfterB = countRoots(uf, n);
  const tierCGroups = groupSingletonsByKey(records, uf, sizeAfterB, tierCKey);
  const tierCRoots = new Set<number>();
  for (const idxs of tierCGroups.values()) {
    if (idxs.length < 2) continue;
    // Cross-source gate: clusters where ≥2 distinct source prefixes are
    // represented admit. Same-source clusters never union (preserves the
    // BTS-IDOL guard — same-source twins sharing a primary token are
    // distinct releases, not duplicates).
    if (!shouldUnionTierCGroup(records, idxs)) continue;
    for (const root of unionIndexGroups(uf, [idxs])) tierCRoots.add(root);
  }

  // --- Tier D: guarded context-suffix title clustering ---
  // After Tier C, residual singletons can still represent the same song when
  // TJ carries a trailing anime/game/OST parenthetical and JOYSOUND stores the
  // bare title. Tier D keys on refinedStripContext(title) + FULL artist (not
  // lead artist), fires only cross-source, and refuses any group with multiple
  // non-null values for the same vendor field. Refused groups stay split but
  // emit vendor-number conflicts so the review queue sees them.
  const sizeAfterC = countRoots(uf, n);
  const tierDGroups = groupSingletonsByKey(records, uf, sizeAfterC, tierDKey);
  const tierDRoots = new Set<number>();
  for (const [clusterKey, idxs] of tierDGroups) {
    if (idxs.length < 2) continue;
    if (!shouldUnionTierDGroup(records, idxs)) continue;
    // biome-ignore lint/style/noNonNullAssertion: i in bounds
    const cluster = idxs.map((i) => records[i]!);
    if (collectVendorNumberConflicts(cluster).length > 0) {
      recordTierDBlockedConflicts(conflicts, clusterKey, cluster);
      continue;
    }
    for (const root of unionIndexGroups(uf, [idxs])) tierDRoots.add(root);
  }

  // --- Tier E: reviewed strong TJ↔JOYSOUND artist-credit pairs ---
  // SongRecord does not retain raw JOYSOUND tieup or lyricist/composer fields,
  // so this tier intentionally does not generalize from artist containment.
  // It only unions the 65 raw-reviewed strong pairs listed above, after Tier D,
  // while both sides are still singleton clusters.
  const sizeAfterD = countRoots(uf, n);
  const tierEGroups = collectTierEReviewedStrongGroups(records, uf, sizeAfterD);
  const tierERoots = new Set<number>();
  const tierEClusterKeyByRoot = new Map<number, string>();
  for (const [clusterKey, idxs] of tierEGroups) {
    for (const root of unionIndexGroups(uf, [idxs])) {
      tierERoots.add(root);
      tierEClusterKeyByRoot.set(root, clusterKey);
    }
  }

  // --- Tier F: post-crawl reviewed TJ/KY↔JOYSOUND split-pair allowlist ---
  // This tier is intentionally exact-pair only. It does not generalize from
  // the broad/fuzzy audit queues; rows must still be residual singleton
  // single-provider targets after Tier E, and the JOYSOUND side must have no
  // same-provider conflict.
  const sizeAfterE = countRoots(uf, n);
  const tierFGroups = collectTierFPostcrawlReviewedGroups(records, uf, sizeAfterE);
  const tierFRoots = new Set<number>();
  const tierFClusterKeyByRoot = new Map<number, string>();
  for (const [clusterKey, idxs] of tierFGroups) {
    for (const root of unionIndexGroups(uf, [idxs])) {
      tierFRoots.add(root);
      tierFClusterKeyByRoot.set(root, clusterKey);
    }
  }

  // --- Materialize clusters ---
  const clusters = collectClusters(uf, n);

  const merged: SongRecord[] = [];
  for (const [root, idxs] of clusters) {
    // biome-ignore lint/style/noNonNullAssertion: idx in bounds
    const cluster = idxs.map((i) => records[i]!);
    const wasTierB = tierBRoots.has(root);
    const wasTierC = tierCRoots.has(root);
    const wasTierD = tierDRoots.has(root);
    const wasTierE = tierERoots.has(root);
    const wasTierF = tierFRoots.has(root);
    merged.push(
      mergeCluster(
        cluster,
        wasTierB,
        wasTierC,
        wasTierD,
        wasTierE,
        tierEClusterKeyByRoot.get(root) ?? null,
        wasTierF,
        tierFClusterKeyByRoot.get(root) ?? null,
        conflicts,
      ),
    );
  }

  // Cross-record artist_ko propagation (spec 2026-06-14). Runs after clusters
  // are materialized (standalone JOYSOUND rows by the same artist are NOT in
  // the same song cluster) and before the deterministic sort. Fills a missing
  // artist_ko across records sharing the full-artist identity key when donors
  // agree; never unions rows or overwrites existing values.
  const propagated = propagateArtistKo(merged);

  // Deterministic sort. See docblock above for the rule.
  //
  // Fix A.1 (2026-05-01): null-TJ tiebreak is now explicit — null records
  // sort AFTER any non-null TJ regardless of codepoint. The previous version
  // used `r.karaoke_numbers.tj ?? '￿'` (U+FFFF) as a "push to end" sentinel.
  // That worked for ASCII-digit TJ codes (the only kind in production today)
  // because no ASCII string compares larger than U+FFFF. But supplementary-
  // plane chars (codepoint > U+FFFF, e.g. `'𠀀1'`) sort LOWER than `'￿'`
  // in JS string comparison — their leading UTF-16 surrogate falls in
  // U+D800–DBFF, which is below U+FFFF. A future TJ vendor change to non-
  // ASCII codes (or a hostile fixture) would silently flip the sort. Explicit
  // null-handling removes the tripwire.
  sortMergedRecords(propagated);

  return { records: propagated, conflicts };
}
