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
 * The `'tier_c_merge'`, `'tier_d_context_title_merge'`, and
 * `'tier_e_artist_credit_merge'` field values document successful soft merges
 * (one marker emitted per cluster, not per record-pair) so the merge surfaces
 * in the crawl PR body for review. Sunset cadence per
 * `2026-05-01-kpop-leak-and-merge-fix-design.md` §3.C: 4 weeks of clean
 * cross-source output, then downgrade to a per-cluster log line.
 */
export interface MergeConflict {
  /**
   * Soft-merge cluster key. Tier B/C keys use `clusterKeyPart(title)|...`; Tier
   * D keys use `clusterKeyPart(refinedStripContext(title))|clusterKeyPart(artist)`;
   * Tier E keys use `tj:<number>|joysound:<number>` from the reviewed pair.
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
    | 'tier_e_artist_credit_merge';
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
      c.field !== 'tier_e_artist_credit_merge',
  );
}

// --- Union-Find ----------------------------------------------------------

const VENDORS = ['tj', 'ky', 'joysound'] as const satisfies readonly (keyof KaraokeNumbers)[];

type Vendor = (typeof VENDORS)[number];

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
  conflicts: MergeConflict[],
): SongRecord {
  if (cluster.length === 0) throw new Error('empty cluster');

  // Tier C/D clusters reuse Tier B's vendor-conflict reporting surface under a
  // folded soft-key shape so existing PR-body aggregation continues to work.
  const softClusterKey =
    wasTierE && tierEClusterKeyValue !== null
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

  return merged;
}

// --- Public API ----------------------------------------------------------

/**
 * Five-tier dedup + per-field-ownership merge.
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
 * Conflict warnings (Tier B vendor-number disagreements + Tier C/D/E cluster
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
    merged.push(
      mergeCluster(
        cluster,
        wasTierB,
        wasTierC,
        wasTierD,
        wasTierE,
        tierEClusterKeyByRoot.get(root) ?? null,
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
