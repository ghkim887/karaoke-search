import type { RawSongRecord } from '@karaoke/schema';

/**
 * Parse a TJ Media catalog JSON response into `RawSongRecord`s.
 *
 * Endpoint contract (live-verified 2026-04-27):
 *   POST https://www.tjmedia.com/legacy/api/newSongOfMonth
 *   body: searchYm=200001 (form-urlencoded; "all songs since 2000-01")
 *   response: `{ resultCode, resultData: { itemsTotalCount, items: [...] }, GNB_MENU, resultMsg }`
 *
 * Each `items[i]` entry has the live shape:
 *   { rownumber, thumbnailImg, pro, indexTitle, indexSong,
 *     word, com, icongubun, mv_yn, publishdate }
 *
 * Field mapping:
 *   pro          -> karaoke_numbers.tj (cast to string)
 *   indexTitle   -> title_primary
 *   indexSong    -> artist_primary  (despite the field name, this is the artist)
 *
 * Loose-JP filter: a record is "Japanese-relevant" if its `indexTitle` or
 * `indexSong` contains at least ONE of:
 *   - a hiragana char (`/[぀-ゟ]/`)
 *   - a katakana char (`/[゠-ヿ]/`)
 *   - a CJK unified ideograph (`/[一-鿿]/`) AND the same string contains no
 *     Hangul (`/[가-힯]/`).
 *
 * Strings containing Hangul or only Latin script are NOT Japanese-relevant
 * unless they also contain hiragana or katakana.
 *
 * Chinese-artist denylist: the loose-JP filter accepts pure-Han strings,
 * which leaks well-known Cantopop / Mandopop artists (e.g. 张学友, 邓丽君).
 * After the loose-JP filter passes, the artist name is normalized
 * (whitespace-collapse + lowercase + NFKC) and matched against
 * `CHINESE_ARTIST_DENYLIST`. Matches are dropped.
 *
 * Blog-whitelist rescue: when `options.forceIncludeTjNumbers` is provided
 * and a record's `pro` is in the set, BOTH the loose-JP filter AND the
 * Chinese denylist are bypassed for that record. The blog corpus is
 * canonical for Japanese acts, so any TJ# the blog already knows about
 * is force-included regardless of script content. The record still must
 * have non-empty `pro`, `indexTitle`, and `indexSong`.
 *
 * Items missing/empty `pro`, `indexTitle`, or `indexSong` are skipped.
 *
 * Throws if `json` does not have the expected response shape; the pipeline
 * aborts on this error (single request — there is no retry path).
 */
export interface ParseOptions {
  /**
   * Set of TJ catalog numbers (`pro`, stringified) that should bypass the
   * loose-JP filter and Chinese denylist. Typically the set of TJ numbers
   * already present in the blog corpus — see `TJDirectCrawler` for how this
   * set is sourced.
   */
  forceIncludeTjNumbers?: ReadonlySet<string>;
}

export function parseCatalogResponse(
  json: unknown,
  sourceUrl: string,
  options?: ParseOptions,
): RawSongRecord[] {
  const items = extractItems(json);
  const records: RawSongRecord[] = [];
  const force = options?.forceIncludeTjNumbers;

  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const proRaw = item.pro;
    const title = typeof item.indexTitle === 'string' ? item.indexTitle.trim() : '';
    const artist = typeof item.indexSong === 'string' ? item.indexSong.trim() : '';

    let tj: string | null = null;
    if (typeof proRaw === 'number' && Number.isFinite(proRaw)) {
      tj = String(proRaw);
    } else if (typeof proRaw === 'string' && proRaw.trim() !== '') {
      tj = proRaw.trim();
    }

    if (!tj || !title || !artist) continue;

    const rescued = force?.has(tj) ?? false;
    if (!rescued) {
      if (!isJapaneseRelevant(title) && !isJapaneseRelevant(artist)) continue;
      if (isChineseDeniedArtist(artist)) continue;
    }

    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: null,
      karaoke_numbers: { tj, ky: null, joysound: null },
      categories: ['jpop'],
    });
  }

  return records;
}

function extractItems(json: unknown): unknown[] {
  // Note: the live API returns `resultCode: "99"` for successful catalog
  // responses (not "00" as one might expect). We do not check `resultCode` —
  // only that `resultData.items` is an array.
  if (!isPlainObject(json)) {
    throw new Error('tj-media-direct parser: response is not a JSON object');
  }
  const data = json.resultData;
  if (!isPlainObject(data)) {
    throw new Error('tj-media-direct parser: response.resultData missing or not an object');
  }
  const items = data.items;
  if (!Array.isArray(items)) {
    throw new Error('tj-media-direct parser: response.resultData.items is not an array');
  }
  return items;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const RE_HIRAGANA = /[぀-ゟ]/;
const RE_KATAKANA = /[゠-ヿ]/;
const RE_CJK_HAN = /[一-鿿]/;
const RE_HANGUL = /[가-힯]/;

function isJapaneseRelevant(s: string): boolean {
  if (RE_HIRAGANA.test(s)) return true;
  if (RE_KATAKANA.test(s)) return true;
  if (RE_CJK_HAN.test(s) && !RE_HANGUL.test(s)) return true;
  return false;
}

/**
 * Canonical (un-normalized) source forms of well-known Chinese-music artists
 * that leak through the loose-JP filter (Cantopop / Mandopop / Mainland).
 *
 * These are matched against `artist_primary` after a whitespace-collapse +
 * lowercase + NFKC normalization, so variant spacings (`王菲` / `王 菲`) all
 * match a single entry. Simplified vs traditional are NOT auto-folded —
 * include both forms explicitly when both appear in TJ data
 * (e.g. `范玮琪` and `范瑋琪`).
 *
 * Long-tail Chinese leak (≤4 records per artist) is acceptable scope.
 */
export const CHINESE_ARTIST_DENYLIST: readonly string[] = [
  // Cantopop / HK
  '张学友',
  '刘德华',
  '郭富城',
  '黎明',
  '张国荣',
  '梅艳芳',
  '谭咏麟',
  '陈奕迅',
  '陈慧琳',
  '陈慧娴',
  '黎瑞恩',
  '郑秀文',
  '容祖儿',
  '关淑怡',
  '邝美云',
  '林子祥',
  '叶倩文',
  '林忆莲',
  '古巨基',
  '谢霆锋',
  '周慧敏',
  '张柏芝',
  '古天乐',
  '关之琳',
  '罗文',
  '关正杰',
  '陈百强',
  '卢冠廷',
  '蔡国权',
  '张敬轩',
  '区瑞强',
  '钟镇涛',
  '雷安娜',
  '草蜢',
  '杜德伟',
  '苏永康',
  '林晓培',
  '王菲',
  '王靖雯',
  '叶丽仪',
  '罗大佑',
  '童安格',
  '黄家驹',
  '李克勤',
  '甄妮',
  '袁凤瑛',
  '黄莺莺',
  // Mandopop / Taiwan
  '邓丽君',
  '周华健',
  '李宗盛',
  '周杰伦',
  '王力宏',
  '蔡依林',
  '张惠妹',
  '孙燕姿',
  '林俊杰',
  '陶喆',
  '五月天',
  '范玮琪',
  '范瑋琪',
  '张韶涵',
  '刘若英',
  '萧亚轩',
  '蔡健雅',
  '江美琪',
  '戴佩妮',
  '罗志祥',
  '任贤齐',
  '苏有朋',
  '庾澄庆',
  '吴宗宪',
  '林志颖',
  '林志炫',
  '田馥甄',
  '杨丞琳',
  '阿杜',
  '陶晶莹',
  '萧敬腾',
  '林宥嘉',
  '王心凌',
  '张靓颖',
  '那英',
  '邓紫棋',
  '梁静茹',
  '陈小春',
  '徐怀钰',
  '高胜美',
  '孟庭苇',
  '龙飘飘',
  '梁咏琪',
  '动力火车',
  '赵传',
  '李荣浩',
  '齐秦',
  '李玟',
  '薛之谦',
  '吴奇隆',
  '莫文蔚',
  '范晓萱',
  '蔡琴',
  '周传雄',
  '张碧晨',
  '毛不易',
  '郑中基',
  '阎维文',
  '伍佰',
  '凤飞飞',
  '蔡幸娟',
  '苏芮',
  '陈淑桦',
  '黄品源',
  '优客李林',
  '巫启贤',
  '江蕙',
  '殷正洋',
  '万芳',
  '苏慧伦',
  '伍思凯',
  '徐小凤',
  '潘美辰',
  '张雨生',
  '张宇',
  '辛晓琪',
  '邰正宵',
  '熊天平',
  '迪克牛仔',
  '光良',
  // Mandopop (additions found via post-implementation top-Han audit)
  '张信哲',
  '赵薇',
  '郑智化',
  '王杰',
  '徐若瑄',
  '陈思安',
  'G.E.M.邓紫棋',
  // Catalog meta-label (not an artist; appears as artist on aggregated rows)
  '韩国歌曲',
  // Mainland China
  '韩红',
  '田震',
  '孙楠',
  '刘欢',
  '毛阿敏',
  '韦唯',
  '周深',
  '华晨宇',
  '易烊千玺',
  '王俊凯',
  '鹿晗',
  '许嵩',
  '汪苏泷',
  '海来阿木',
  '张杰',
  '韩磊',
  '谭晶',
  '殷秀梅',
  '宋祖英',
  '彭丽媛',
  '李娜',
  '李双江',
  '黄安',
  '朱海君',
  '谭维维',
  // Older / 70s-80s
  '费玉清',
  '郑钧',
  '张震岳',
  '李玲玉',
  '韩宝仪',
  '叶玉卿',
  '叶启田',
  '成龙',
];

/** Whitespace-collapse + lowercase + NFKC. Used for both denylist normalization
 *  and per-record artist name comparison. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
}

const CHINESE_DENYLIST_NORMALIZED: ReadonlySet<string> = new Set(
  CHINESE_ARTIST_DENYLIST.map(normalizeForMatch),
);

function isChineseDeniedArtist(artist: string): boolean {
  return CHINESE_DENYLIST_NORMALIZED.has(normalizeForMatch(artist));
}
