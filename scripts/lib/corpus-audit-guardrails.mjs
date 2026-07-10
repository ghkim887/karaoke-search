import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stableStringify } from './canonical-json.mjs';
import { isCliInvocation } from './cli.mjs';

const SAMPLE_LIMIT = 20;
const RE_HANGUL = /[\uac00-\ud7af]/u;
const RE_HIRAGANA = /[\u3040-\u309f]/u;
const RE_KATAKANA = /[\u30a0-\u30ff\uff66-\uff9f]/u;
const RE_HAN = /[\u3400-\u9fff]/u;
const RE_ASCII_LETTER = /[A-Za-z]/u;
const RE_LATIN_VOCALOID_SURFACE = /\b(?:GUMI|MEIKO|KAITO)\b|\bflower\b/iu;
const RE_LATIN_VOCALOID_SAFE_CONTEXT =
  /\bfeat\.?\s*(?:v[._\s-]*)?flower\b|\bv[._\s-]*flower\b|\b(?:GUMI|MEIKO|KAITO)\b/iu;
const RE_BARE_ANIME_TOKEN = /(?:^|[^A-Za-z0-9])(?:OP|ED)(?:[^A-Za-z0-9]|$)/u;
const STRONG_ANIME_TOKENS = ['アニメ', 'TVアニメ', '劇場版', '特撮', 'キャラクター', 'CV:'];
const GENERIC_ARTIST_RE = /^(?:Various Artists|Various|Unknown|Unknown Artist|オムニバス)$/iu;
const GENERIC_ARTIST_KEYS = new Set([
  'variousartists',
  'variousartist',
  'various',
  'unknown',
  'unknownartist',
  'オムニバス',
]);

const KOREAN_ACT_PATTERNS = [
  /\b(?:aespa|BABYMONSTER|BIG\s*BANG|CORTIS|ENHYPEN|FT\s*ISLAND|ITZY|IVE|IZ\*ONE|LE\s*SSERAFIM|NCT\s*DREAM|NCT\s*WISH|NMIXX|PLAVE|SEVENTEEN|STRAY\s*KIDS|ZEROBASEONE|BTS|BLACKPINK|TWICE|TOMORROW\s*X\s*TOGETHER|TXT|TREASURE|BIGBANG|2NE1|GFRIEND|SUPER\s*JUNIOR|RED\s*VELVET|MONSTA\s*X|MAMAMOO|GOT7|EXO|ATEEZ|Kep1er|BOYNEXTDOOR|KISS\s*OF\s*LIFE|SHINee|KARA)\b/iu,
  /(?:防弾少年団|東方神起|少女時代|エスパ|アイヴ|エンハイプン|エヌシーティー|ストレイキッズ|セブンティーン|チョンソミ|ニュージーンズ|ルセラフィム|ベイビーモンスター|ゼロベースワン|トゥワイス|ブラックピンク|トゥモローバイトゥギャザー|トレジャー|レッドベルベット|モンスタエックス|ママムー|ヨジャチング|スーパージュニア|ビッグバン|トゥエニィワン|エクソ|エイティーズ|ケプラー|ボーイネクストドア|キスオブライフ|ゴットセブン)/u,
];

const WESTERN_ACT_COMPONENTS = new Set([
  'ADELE',
  'ARIANA GRANDE',
  'BACKSTREET BOYS',
  'BILLIE EILISH',
  'BRUNO MARS',
  'CELINE DION',
  'CHARLIE PUTH',
  'COLDPLAY',
  'DUA LIPA',
  'ED SHEERAN',
  'HARRY STYLES',
  'JUSTIN BIEBER',
  'LADY GAGA',
  'OLIVIA RODRIGO',
  'QUEEN',
  'RIHANNA',
  'SABRINA CARPENTER',
  'TAYLOR SWIFT',
  'THE WEEKND',
  'セリーヌディオン',
  'バックストリートボーイズ',
  'レディーガガ',
]);

const GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST = GENERIC_ARTIST_KEYS;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function addCount(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function sourceOf(record) {
  const id = asString(record?.id);
  return id.length > 0 ? id.split('-')[0] : '(missing)';
}

function isOfficialJoysoundSource(record) {
  return (
    asString(record?.id).startsWith('joysound-') ||
    asString(record?.source_url).includes('joysound.com')
  );
}

function songText(record) {
  return [
    record?.title_primary,
    record?.title_ko,
    record?.artist_primary,
    record?.artist_ko,
    ...(Array.isArray(record?.artist_aliases) ? record.artist_aliases : []),
    record?.media_context_ko,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function titleArtistText(record) {
  return [record?.title_primary, record?.artist_primary]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function listingText(row) {
  return [row?.songName, row?.artistName, row?.tieupInfo]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function listingTitleArtistText(row) {
  return [row?.songName, row?.artistName].filter((value) => typeof value === 'string').join(' ');
}

function hasKana(value) {
  return RE_HIRAGANA.test(value) || RE_KATAKANA.test(value);
}

function hasJapaneseOrAmbiguousHan(value) {
  return hasKana(value) || RE_HAN.test(value);
}

function isAsciiOnlyTitleArtist(value) {
  return RE_ASCII_LETTER.test(value) && !hasJapaneseOrAmbiguousHan(value) && !RE_HANGUL.test(value);
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizeWesternActComponent(component) {
  return component
    .normalize('NFKC')
    .replace(/[・･]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase();
}

function artistComponents(surface) {
  return surface
    .split(/\s*(?:×|,|、|\(|\)|（|）|\bfeaturing\b|\bfeat\.?\b)\s*/iu)
    .map((part) => normalizeWesternActComponent(part))
    .filter((part) => part.length > 0);
}

function isKnownWesternAct(surface) {
  return artistComponents(surface).some((part) => WESTERN_ACT_COMPONENTS.has(part));
}

function matchesDropListArtist(surface, keys) {
  return splitArtistCollabForAudit(surface).some((component) =>
    keys.has(normalizeForMatch(component)),
  );
}

function isGenericArtist(surface) {
  return GENERIC_ARTIST_RE.test(surface) || GENERIC_ARTIST_KEYS.has(normalizeForMatch(surface));
}

function isProductionDropListArtist(surface) {
  return (
    matchesDropListArtist(surface, KOREAN_DROP_KEYS) ||
    matchesDropListArtist(surface, CHINESE_DROP_KEYS)
  );
}

function isPolicyExcludedOfficialArtist(surface) {
  return (
    isGenericArtist(surface) ||
    isProductionDropListArtist(surface) ||
    matchesAny(surface, KOREAN_ACT_PATTERNS) ||
    isKnownWesternAct(surface)
  );
}

function isBareAnimeTokenRisk(surface) {
  return (
    RE_BARE_ANIME_TOKEN.test(surface) &&
    !STRONG_ANIME_TOKENS.some((token) => surface.includes(token))
  );
}

function isLatinVocaloidSubstringRisk(surface) {
  return RE_LATIN_VOCALOID_SURFACE.test(surface) && !RE_LATIN_VOCALOID_SAFE_CONTEXT.test(surface);
}

function makeBucketStore(names) {
  return Object.fromEntries(names.map((name) => [name, []]));
}

function bucketReport(buckets, sampleMapper) {
  const counts = {};
  const samples = {};
  for (const [name, records] of Object.entries(buckets)) {
    counts[name] = { count: records.length };
    samples[name] = records.slice(0, SAMPLE_LIMIT).map(sampleMapper);
  }
  return { buckets: counts, samples };
}

function sampleRecord(record) {
  return {
    id: record.id ?? null,
    source_url: record.source_url ?? null,
    title_primary: record.title_primary ?? null,
    artist_primary: record.artist_primary ?? null,
    tj: record.karaoke_numbers?.tj ?? null,
    ky: record.karaoke_numbers?.ky ?? null,
    joysound: record.karaoke_numbers?.joysound ?? null,
  };
}

function sampleRichRecord(record) {
  return {
    ...sampleRecord(record),
    title_ko: record.title_ko ?? null,
    artist_ko: record.artist_ko ?? null,
    artist_aliases: Array.isArray(record.artist_aliases) ? record.artist_aliases : [],
    media_context_ko: record.media_context_ko ?? null,
  };
}

function sampleListingRow(row) {
  return {
    naviGroupId: row.naviGroupId ?? null,
    selSongNo: row.selSongNo ?? null,
    songName: row.songName ?? null,
    artistName: row.artistName ?? null,
    tieupInfo: row.tieupInfo ?? null,
  };
}

function sampleListingAuditItem(item) {
  const row = item?.row ?? item;
  const sample = sampleListingRow(row);
  if (Array.isArray(item?.baseline)) {
    sample.baseline = item.baseline.map(sampleRichRecord);
  }
  return sample;
}

function issueRow(mode, bucket, payload) {
  return { mode, bucket, ...payload };
}

function collectCorpusIssueRows(records) {
  const issues = [];
  for (const record of records) {
    const fullText = songText(record);
    const titleArtist = titleArtistText(record);
    const artist = asString(record?.artist_primary);
    if (matchesAny(artist, KOREAN_ACT_PATTERNS)) {
      issues.push(issueRow('corpus', 'knownKoreanAct', { record: sampleRecord(record) }));
    }
    if (isKnownWesternAct(artist)) {
      issues.push(issueRow('corpus', 'knownWesternAct', { record: sampleRecord(record) }));
    }
    if (RE_HANGUL.test(titleArtist) && !hasKana(titleArtist)) {
      issues.push(issueRow('corpus', 'hangulNoJapaneseScript', { record: sampleRecord(record) }));
    }
    if (isGenericArtist(artist) && !hasKana(fullText)) {
      issues.push(
        issueRow('corpus', 'genericArtistNoJapaneseScript', { record: sampleRecord(record) }),
      );
    }
    if (isAsciiOnlyTitleArtist(titleArtist)) {
      issues.push(issueRow('corpus', 'asciiOnlyTitleArtist', { record: sampleRecord(record) }));
    }
  }
  return issues;
}

function collectJoysoundListingIssueRows(rows, options = {}) {
  const issues = [];
  const baselineNumbers = baselineJoysoundNumberMap(options.baselineRecords);
  const seenKeys = new Set();
  for (const row of rows) {
    const key = `${row?.naviGroupId ?? ''}|${row?.selSongNo ?? ''}`;
    if (seenKeys.has(key)) {
      issues.push(
        issueRow('joysound-listing', 'duplicateKey', { key, row: sampleListingRow(row) }),
      );
    } else {
      seenKeys.add(key);
    }

    const surface = listingText(row);
    const titleArtist = listingTitleArtistText(row);
    const artist = asString(row?.artistName);
    if (matchesAny(artist, KOREAN_ACT_PATTERNS)) {
      issues.push(issueRow('joysound-listing', 'knownKoreanAct', { row: sampleListingRow(row) }));
    }
    if (isKnownWesternAct(artist)) {
      issues.push(issueRow('joysound-listing', 'knownWesternAct', { row: sampleListingRow(row) }));
    }
    if (!hasJapaneseOrAmbiguousHan(titleArtist)) {
      issues.push(
        issueRow('joysound-listing', 'noJapaneseTitleArtist', { row: sampleListingRow(row) }),
      );
    }
    if (isAsciiOnlyTitleArtist(titleArtist)) {
      issues.push(
        issueRow('joysound-listing', 'asciiOnlyTitleArtist', { row: sampleListingRow(row) }),
      );
    }
    if (isBareAnimeTokenRisk(surface)) {
      issues.push(
        issueRow('joysound-listing', 'bareAnimeTokenRisk', { row: sampleListingRow(row) }),
      );
    }
    if (isLatinVocaloidSubstringRisk(surface)) {
      issues.push(
        issueRow('joysound-listing', 'latinVocaloidSubstringRisk', { row: sampleListingRow(row) }),
      );
    }

    const baselineMatches = baselineNumbers.get(normalizeJoysoundNumber(row?.selSongNo));
    if (baselineMatches) {
      const payload = {
        row: sampleListingRow(row),
        baseline: baselineMatches.map(sampleRichRecord),
      };
      issues.push(issueRow('joysound-listing', 'existingJoysoundNumberOverlap', payload));
      if (!baselineMatches.some((record) => sameTitleArtist(row, record))) {
        issues.push(issueRow('joysound-listing', 'existingJoysoundNumberConflict', payload));
      }
    }
  }
  return issues;
}

function collectMergeDeltaIssueRows(baselineRecords, candidateRecords) {
  const issues = [];
  const baselineDuplicates = duplicateIdReport(baselineRecords);
  const candidateDuplicates = duplicateIdReport(candidateRecords);
  const baseline = mapById(baselineRecords);
  const candidate = mapById(candidateRecords);
  const added = candidateRecords.filter((record) => !baseline.has(record.id));
  const removed = baselineRecords.filter((record) => !candidate.has(record.id));

  for (const record of removed)
    issues.push(issueRow('merge-delta', 'removed', { record: sampleRichRecord(record) }));
  for (const duplicate of baselineDuplicates)
    issues.push(issueRow('merge-delta', 'duplicateBaselineId', duplicate));
  for (const duplicate of candidateDuplicates)
    issues.push(issueRow('merge-delta', 'duplicateCandidateId', duplicate));

  for (const [id, before] of baseline) {
    const after = candidate.get(id);
    if (!after) continue;
    if (stableStringify(before) !== stableStringify(after)) {
      issues.push(
        issueRow('merge-delta', 'mutatedExisting', {
          id,
          before: sampleRichRecord(before),
          after: sampleRichRecord(after),
          changedFields: changedTopLevelFields(before, after),
        }),
      );
    }
    const lostFields = lostRichFields(before, after);
    if (lostFields.length > 0) {
      issues.push(
        issueRow('merge-delta', 'richFieldLoss', {
          id,
          lostFields,
          before: sampleRichRecord(before),
          after: sampleRichRecord(after),
        }),
      );
    }
  }

  for (const record of added)
    issues.push(issueRow('merge-delta', 'added', { record: sampleRichRecord(record) }));
  for (const suspicious of collectCorpusIssueRows(added)) {
    issues.push(
      issueRow('merge-delta', `suspiciousAddition.${suspicious.bucket}`, {
        record: suspicious.record,
      }),
    );
  }
  return issues;
}

export function analyzeCorpus(records) {
  if (!Array.isArray(records)) throw new Error('analyzeCorpus: records must be an array');

  const sourceCounts = {};
  const buckets = makeBucketStore([
    'knownKoreanAct',
    'knownWesternAct',
    'hangulNoJapaneseScript',
    'genericArtistNoJapaneseScript',
    'asciiOnlyTitleArtist',
  ]);

  let officialJoysoundSourceRecords = 0;
  let recordsWithJoysoundNumber = 0;
  let officialJoysoundSourceRecordsWithNumber = 0;
  let nonOfficialRecordsWithJoysoundNumber = 0;

  for (const record of records) {
    addCount(sourceCounts, sourceOf(record));
    const officialJoysoundSource = isOfficialJoysoundSource(record);
    const hasJoysoundNumber = typeof record?.karaoke_numbers?.joysound === 'string';
    if (officialJoysoundSource) officialJoysoundSourceRecords++;
    if (hasJoysoundNumber) recordsWithJoysoundNumber++;
    if (officialJoysoundSource && hasJoysoundNumber) officialJoysoundSourceRecordsWithNumber++;
    if (!officialJoysoundSource && hasJoysoundNumber) nonOfficialRecordsWithJoysoundNumber++;

    const fullText = songText(record);
    const titleArtist = titleArtistText(record);
    const artist = asString(record?.artist_primary);
    if (matchesAny(artist, KOREAN_ACT_PATTERNS)) buckets.knownKoreanAct.push(record);
    if (isKnownWesternAct(artist)) buckets.knownWesternAct.push(record);
    if (RE_HANGUL.test(titleArtist) && !hasKana(titleArtist))
      buckets.hangulNoJapaneseScript.push(record);
    if (isGenericArtist(artist) && !hasKana(fullText)) {
      buckets.genericArtistNoJapaneseScript.push(record);
    }
    if (isAsciiOnlyTitleArtist(titleArtist)) buckets.asciiOnlyTitleArtist.push(record);
  }

  const bucketData = bucketReport(buckets, sampleRecord);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: records.length,
      officialJoysoundSourceRecords,
      recordsWithJoysoundNumber,
      officialJoysoundSourceRecordsWithNumber,
      nonOfficialRecordsWithJoysoundNumber,
    },
    sourceCounts,
    ...bucketData,
  };
}

const TJ_FP_BUCKETS = [
  'officialNonJpnPro',
  'missingOfficialPro',
  'hangulNoJapaneseEvidence',
  'hanNoKanaMandopopRisk',
  'asciiOnlyWeakEvidence',
  'genericArtistRisk',
  'rescueOnlyRisk',
  'titleArtistConflict',
  'knownKoreanAct',
  'knownWesternAct',
];

const TJ_FN_BUCKETS = [
  'exactProJpnMissing',
  'artistJpnMissing',
  'strongScriptJpMissing',
  'animeVocaloidLikelyMissing',
  'policyExcludedOfficialJpn',
  'weakEvidenceMissing',
  'sameSongNoTjNumber',
];

function tjNumberKey(value) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : asString(value);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/^0+/u, '') || '0';
}

function recordTjKey(record) {
  return tjNumberKey(record?.karaoke_numbers?.tj);
}

function catalogTjKey(row) {
  return tjNumberKey(row?.pro ?? row?.tj ?? row?.tjNumber);
}

function officialTitle(row) {
  return asString(row?.indexTitle ?? row?.title ?? row?.title_primary);
}

function officialArtist(row) {
  return asString(row?.indexSong ?? row?.artist ?? row?.artist_primary);
}

function cacheProEntry(cache, tj) {
  return cache?.proEnrichmentMap?.[tj] ?? cache?.proEnrichmentMap?.[tjNumberKey(tj)] ?? null;
}

function normalizeNationalityCode(value) {
  const code = asString(value).trim().toLocaleUpperCase('en-US');
  return code.length > 0 ? code : null;
}

function cacheArtistEntryForKey(cache, key) {
  if (key.length === 0) return null;
  return cache?.artistNationalityMap?.[key] ?? null;
}

function artistCacheKeys(artist) {
  return new Set([
    artist,
    normalizeForComparison(artist),
    normalizeForMatch(artist),
    normalizeWesternActComponent(artist).toLocaleLowerCase('ja-JP'),
    ...splitArtistCollabForAudit(artist).map((component) => normalizeForMatch(component)),
  ]);
}

function cacheArtistEntry(cache, artist) {
  const map = cache?.artistNationalityMap ?? {};
  const keys = artistCacheKeys(artist);
  for (const key of keys) {
    if (typeof key === 'string' && map[key]) return map[key];
  }
  return null;
}

function cacheAnyJpnArtistEntry(cache, artist) {
  const map = cache?.artistNationalityMap ?? {};
  let firstEntry = null;
  for (const key of artistCacheKeys(artist)) {
    const entry = typeof key === 'string' ? map[key] : null;
    if (!entry) continue;
    if (!firstEntry) firstEntry = entry;
    if (normalizeNationalityCode(entry.code) === 'JPN') return entry;
  }
  return firstEntry;
}

function leadArtistKey(artist) {
  const components = splitArtistCollabForAudit(artist);
  const lead = components.length >= 2 ? components[1] : components[0];
  const key = normalizeForMatch(lead);
  return GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST.has(key) ? '' : key;
}

function cacheLeadArtistEntry(cache, artist) {
  return cacheArtistEntryForKey(cache, leadArtistKey(artist));
}

function catalogNationalcode(row, cache, tj) {
  return (
    normalizeNationalityCode(row?.nationalcode) ??
    normalizeNationalityCode(row?.nationalCode) ??
    normalizeNationalityCode(cacheProEntry(cache, tj)?.nationalcode)
  );
}

function scriptSignalFor(titleArtist) {
  const parts = [];
  if (hasKana(titleArtist)) parts.push('kana');
  if (RE_HAN.test(titleArtist)) parts.push('han');
  if (RE_HANGUL.test(titleArtist)) parts.push('hangul');
  if (isAsciiOnlyTitleArtist(titleArtist)) parts.push('ascii-only');
  return parts.length > 0 ? parts.join('+') : 'none';
}

function sameCatalogTitleArtist(row, record) {
  return (
    normalizeForComparison(officialTitle(row)) === normalizeForComparison(record?.title_primary) &&
    normalizeForComparison(officialArtist(row)) === normalizeForComparison(record?.artist_primary)
  );
}

function evidenceRow({
  bucket,
  priority,
  record = null,
  row = null,
  cache = {},
  why,
  suggested,
  tjOverride = null,
}) {
  const tj =
    tjOverride ??
    (record && recordTjKey(record).length > 0 ? recordTjKey(record) : catalogTjKey(row));
  const official = row;
  const currentTitleArtist = record ? titleArtistText(record) : '';
  const officialTitleArtist = row ? `${officialTitle(row)} ${officialArtist(row)}`.trim() : '';
  const artistForCache = record?.artist_primary ?? officialArtist(row);
  const proEntry = cacheProEntry(cache, tj);
  const leadArtistEntry = cacheLeadArtistEntry(cache, artistForCache);
  const anyArtistEntry = cacheAnyJpnArtistEntry(cache, artistForCache);
  return {
    bucket,
    priority,
    tj,
    current_id: record?.id ?? '',
    current_source: record ? sourceOf(record) : '',
    current_title: record?.title_primary ?? '',
    current_artist: record?.artist_primary ?? '',
    official_title: official ? officialTitle(official) : '',
    official_artist: official ? officialArtist(official) : '',
    official_nationalcode: official
      ? (catalogNationalcode(official, cache, tj) ?? '')
      : (normalizeNationalityCode(proEntry?.nationalcode) ?? ''),
    artist_cache_code: normalizeNationalityCode(leadArtistEntry?.code) ?? '',
    artist_cache_any_code: normalizeNationalityCode(anyArtistEntry?.code) ?? '',
    pro_cache_nationalcode: normalizeNationalityCode(proEntry?.nationalcode) ?? '',
    script_signal: scriptSignalFor(`${currentTitleArtist} ${officialTitleArtist}`),
    why_flagged: why,
    suggested_verdict: suggested,
    reviewer_verdict: '',
    reviewer_note: '',
  };
}

function pushIssue(buckets, bucket, row) {
  buckets[bucket].push(row);
}

function tjBucketData(buckets) {
  return bucketReport(buckets, (row) => row);
}

function tjCatalogMap(tjCatalog) {
  const map = new Map();
  for (const row of tjCatalog) {
    const key = catalogTjKey(row);
    if (key.length === 0) continue;
    const existing = map.get(key) ?? [];
    existing.push(row);
    map.set(key, existing);
  }
  return map;
}

function corpusTjMap(records) {
  const map = new Map();
  for (const record of records) {
    const key = recordTjKey(record);
    if (key.length === 0) continue;
    const existing = map.get(key) ?? [];
    existing.push(record);
    map.set(key, existing);
  }
  return map;
}

function titleArtistKey(title, artist) {
  return `${normalizeForComparison(title)}|${normalizeForComparison(artist)}`;
}

function sameSongWithoutTjMap(records) {
  const map = new Map();
  for (const record of records) {
    if (recordTjKey(record).length > 0) continue;
    const key = titleArtistKey(record?.title_primary, record?.artist_primary);
    if (key === '|') continue;
    const existing = map.get(key) ?? [];
    existing.push(record);
    map.set(key, existing);
  }
  return map;
}

function currentCorpusTjSummary(records, byTj) {
  const withTj = [...byTj.values()].flat();
  return {
    totalRecords: records.length,
    recordsWithTjNumber: withTj.length,
    directTjSourceRecords: withTj.filter((record) => sourceOf(record) === 'tj').length,
    tjpdfSourceRecords: withTj.filter((record) => sourceOf(record) === 'tjpdf').length,
    blogRecordsWithTjNumber: withTj.filter((record) => sourceOf(record) === 'blog').length,
    duplicateTjNumbers: [...byTj.values()].filter((matches) => matches.length > 1).length,
  };
}

function collectTjDatabaseIssues({ records, tjCatalog, cache = {} }) {
  const byTj = corpusTjMap(records);
  const byCatalogTj = tjCatalogMap(tjCatalog);
  const bySameSongWithoutTj = sameSongWithoutTjMap(records);
  const falsePositive = makeBucketStore(TJ_FP_BUCKETS);
  const falseNegative = makeBucketStore(TJ_FN_BUCKETS);

  for (const matches of byTj.values()) {
    for (const record of matches) {
      const tj = recordTjKey(record);
      const catalogRows = byCatalogTj.get(tj) ?? [];
      const official = catalogRows[0] ?? null;
      const titleArtist = titleArtistText(record);
      const fullText = songText(record);
      const artist = asString(record?.artist_primary);
      const proCode = catalogNationalcode(official, cache, tj);
      const artistCode = normalizeNationalityCode(cacheLeadArtistEntry(cache, artist)?.code);
      const hasOfficialJpnEvidence = proCode === 'JPN' || artistCode === 'JPN';

      if (catalogRows.length === 0) {
        pushIssue(
          falsePositive,
          'missingOfficialPro',
          evidenceRow({
            bucket: 'missingOfficialPro',
            priority: 'P0',
            record,
            cache,
            why: 'current corpus has a TJ number that is absent from the official TJ catalog snapshot',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (proCode && proCode !== 'JPN') {
        pushIssue(
          falsePositive,
          'officialNonJpnPro',
          evidenceRow({
            bucket: 'officialNonJpnPro',
            priority: 'P0',
            record,
            row: official,
            cache,
            why: `exact-pro official/cache nationalcode is ${proCode}`,
            suggested: 'DROP_FALSE_POSITIVE',
          }),
        );
      }
      if (official && !catalogRows.some((row) => sameCatalogTitleArtist(row, record))) {
        pushIssue(
          falsePositive,
          'titleArtistConflict',
          evidenceRow({
            bucket: 'titleArtistConflict',
            priority: 'P1',
            record,
            row: official,
            cache,
            why: 'same TJ number exists but product title/artist differs from official title/artist',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (
        RE_HANGUL.test(titleArtist) &&
        !hasJapaneseOrAmbiguousHan(titleArtist) &&
        !hasOfficialJpnEvidence
      ) {
        pushIssue(
          falsePositive,
          'hangulNoJapaneseEvidence',
          evidenceRow({
            bucket: 'hangulNoJapaneseEvidence',
            priority: 'P1',
            record,
            row: official,
            cache,
            why: 'Hangul title/artist without kana/Han or official JPN evidence',
            suggested: 'DROP_FALSE_POSITIVE',
          }),
        );
      }
      if (RE_HAN.test(titleArtist) && !hasKana(titleArtist) && !hasOfficialJpnEvidence) {
        pushIssue(
          falsePositive,
          'hanNoKanaMandopopRisk',
          evidenceRow({
            bucket: 'hanNoKanaMandopopRisk',
            priority: 'P2',
            record,
            row: official,
            cache,
            why: 'Han-only/no-kana title/artist without official JPN evidence',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (isAsciiOnlyTitleArtist(titleArtist) && !hasOfficialJpnEvidence) {
        pushIssue(
          falsePositive,
          'asciiOnlyWeakEvidence',
          evidenceRow({
            bucket: 'asciiOnlyWeakEvidence',
            priority: 'P2',
            record,
            row: official,
            cache,
            why: 'Latin-only title/artist without exact-pro JPN or lead-artist-cache JPN evidence',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (isGenericArtist(artist) && !hasKana(fullText) && !hasOfficialJpnEvidence) {
        pushIssue(
          falsePositive,
          'genericArtistRisk',
          evidenceRow({
            bucket: 'genericArtistRisk',
            priority: 'P1',
            record,
            row: official,
            cache,
            why: 'generic artist label without Japanese or official JPN evidence',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (sourceOf(record) === 'blog' && !hasOfficialJpnEvidence) {
        pushIssue(
          falsePositive,
          'rescueOnlyRisk',
          evidenceRow({
            bucket: 'rescueOnlyRisk',
            priority: 'P2',
            record,
            row: official,
            cache,
            why: 'blog-carried TJ number lacks exact official JPN or lead-artist-cache JPN evidence',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (isProductionDropListArtist(artist) || matchesAny(artist, KOREAN_ACT_PATTERNS)) {
        pushIssue(
          falsePositive,
          'knownKoreanAct',
          evidenceRow({
            bucket: 'knownKoreanAct',
            priority: 'P0',
            record,
            row: official,
            cache,
            why: 'artist matches production Korean/Chinese drop-list or known Korean act deny bucket',
            suggested: 'DROP_FALSE_POSITIVE',
          }),
        );
      }
      if (isKnownWesternAct(artist)) {
        pushIssue(
          falsePositive,
          'knownWesternAct',
          evidenceRow({
            bucket: 'knownWesternAct',
            priority: 'P1',
            record,
            row: official,
            cache,
            why: 'artist matches known Western act review bucket',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
    }
  }

  for (const [tj, rows] of byCatalogTj) {
    if (byTj.has(tj)) continue;
    const row = rows[0];
    const titleArtist = `${officialTitle(row)} ${officialArtist(row)}`.trim();
    const proCode = catalogNationalcode(row, cache, tj);
    const artistCode = normalizeNationalityCode(
      cacheLeadArtistEntry(cache, officialArtist(row))?.code,
    );
    const anyArtistCode = normalizeNationalityCode(
      cacheAnyJpnArtistEntry(cache, officialArtist(row))?.code,
    );
    const artistCachePolicyEdge = anyArtistCode === 'JPN' && artistCode !== 'JPN';
    const policyExcluded =
      isPolicyExcludedOfficialArtist(officialArtist(row)) || artistCachePolicyEdge;
    const policyExcludedPriority =
      proCode === 'JPN'
        ? 'P0'
        : artistCode === 'JPN'
          ? 'P1'
          : hasJapaneseOrAmbiguousHan(titleArtist)
            ? 'P2'
            : 'P4';
    if (proCode && proCode !== 'JPN') continue;
    const sameSongMatches =
      bySameSongWithoutTj.get(titleArtistKey(officialTitle(row), officialArtist(row))) ?? [];
    for (const record of sameSongMatches) {
      pushIssue(
        falseNegative,
        'sameSongNoTjNumber',
        evidenceRow({
          bucket: 'sameSongNoTjNumber',
          priority: policyExcluded
            ? policyExcludedPriority
            : proCode === 'JPN' || artistCode === 'JPN'
              ? 'P1'
              : 'P2',
          record,
          row,
          cache,
          why: 'same normalized title/artist already exists in current corpus but lacks this official TJ number',
          suggested: policyExcluded
            ? 'POLICY_EDGE'
            : proCode === 'JPN' || artistCode === 'JPN'
              ? 'ADD_FALSE_NEGATIVE'
              : 'NEEDS_MORE_EVIDENCE',
        }),
      );
    }
    if (policyExcluded) {
      pushIssue(
        falseNegative,
        'policyExcludedOfficialJpn',
        evidenceRow({
          bucket: 'policyExcludedOfficialJpn',
          priority: policyExcludedPriority,
          row,
          cache,
          why: 'official row is missing and may be JPN, but artist matches known non-Japanese policy-exclusion bucket',
          suggested: 'POLICY_EDGE',
        }),
      );
    } else if (proCode === 'JPN') {
      pushIssue(
        falseNegative,
        'exactProJpnMissing',
        evidenceRow({
          bucket: 'exactProJpnMissing',
          priority: 'P0',
          row,
          cache,
          why: 'official/cache exact-pro evidence says JPN but current corpus lacks this TJ number',
          suggested: 'ADD_FALSE_NEGATIVE',
        }),
      );
    } else if (artistCode === 'JPN' && proCode !== 'KOR' && proCode !== 'ENG') {
      pushIssue(
        falseNegative,
        'artistJpnMissing',
        evidenceRow({
          bucket: 'artistJpnMissing',
          priority: 'P1',
          row,
          cache,
          why: 'artist cache says JPN and current corpus lacks this TJ number',
          suggested: 'ADD_FALSE_NEGATIVE',
        }),
      );
    } else if (hasKana(titleArtist)) {
      pushIssue(
        falseNegative,
        'strongScriptJpMissing',
        evidenceRow({
          bucket: 'strongScriptJpMissing',
          priority: 'P2',
          row,
          cache,
          why: 'official title/artist has kana and current corpus lacks this TJ number',
          suggested: 'NEEDS_MORE_EVIDENCE',
        }),
      );
    } else if (isBareAnimeTokenRisk(titleArtist)) {
      pushIssue(
        falseNegative,
        'animeVocaloidLikelyMissing',
        evidenceRow({
          bucket: 'animeVocaloidLikelyMissing',
          priority: 'P3',
          row,
          cache,
          why: 'official title/artist has anime-like token but needs policy confirmation',
          suggested: 'NEEDS_MORE_EVIDENCE',
        }),
      );
    } else {
      pushIssue(
        falseNegative,
        'weakEvidenceMissing',
        evidenceRow({
          bucket: 'weakEvidenceMissing',
          priority: 'P4',
          row,
          cache,
          why: 'official catalog row is absent from current corpus but lacks strong JPN evidence',
          suggested: 'NEEDS_MORE_EVIDENCE',
        }),
      );
    }
  }

  return { falsePositive, falseNegative, byTj, byCatalogTj };
}

export function analyzeTjDatabase({ records, tjCatalog, cache = {} }) {
  if (!Array.isArray(records)) throw new Error('analyzeTjDatabase: records must be an array');
  if (!Array.isArray(tjCatalog)) throw new Error('analyzeTjDatabase: tjCatalog must be an array');
  const { falsePositive, falseNegative, byTj, byCatalogTj } = collectTjDatabaseIssues({
    records,
    tjCatalog,
    cache,
  });
  const fpData = tjBucketData(falsePositive);
  const fnData = tjBucketData(falseNegative);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      currentCorpus: currentCorpusTjSummary(records, byTj),
      officialCatalog: {
        totalRows: tjCatalog.length,
        uniqueProNumbers: byCatalogTj.size,
        missingFromCurrentCorpus: [...byCatalogTj.keys()].filter((tj) => !byTj.has(tj)).length,
        proCacheEntries: Object.keys(cache?.proEnrichmentMap ?? {}).length,
        artistCacheEntries: Object.keys(cache?.artistNationalityMap ?? {}).length,
      },
    },
    falsePositive: fpData,
    falseNegative: fnData,
  };
}

function collectTjDatabaseIssueRows(records, tjCatalog, cache) {
  const { falsePositive, falseNegative } = collectTjDatabaseIssues({ records, tjCatalog, cache });
  return {
    falsePositiveRows: Object.values(falsePositive)
      .flat()
      .map((row) => issueRow('tj-db-false-positive', row.bucket, row)),
    falseNegativeRows: Object.values(falseNegative)
      .flat()
      .map((row) => issueRow('tj-db-false-negative', row.bucket, row)),
  };
}

function normalizeJoysoundNumber(value) {
  // Canonical JOYSOUND number = strip all hyphens (`190-001` -> `190001`). The
  // corpus stores dashless numbers but live listing rows carry the hyphenated
  // `selSongNo` form, so both compare sides MUST normalize through this helper.
  return asString(value).replace(/-/gu, '');
}

function baselineJoysoundNumberMap(records) {
  const numbers = new Map();
  for (const record of records ?? []) {
    const value = record?.karaoke_numbers?.joysound;
    if (typeof value !== 'string' || value.length === 0) continue;
    const key = normalizeJoysoundNumber(value);
    if (key === '') continue;
    const existing = numbers.get(key) ?? [];
    existing.push(record);
    numbers.set(key, existing);
  }
  return numbers;
}

export function normalizeForComparison(value) {
  return asString(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
}

function normalizeForMatch(value) {
  return asString(value).replace(/\s+/gu, '').toLowerCase().normalize('NFKC');
}

const FEAT_PAREN_RE = /\s*\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)\s*/gi;
const SPLIT_RE = /\s*[&＆,×｜]\s*|\s+with\s+|\s+meets\s+|\s*feat\.\s*/i;
const OF_RE = /\s+of\s+/i;

function splitArtistCollabForAudit(artist) {
  const whole = asString(artist).trim();
  if (whole === '') return [];
  const parts = [whole];
  const featContents = [];
  const main = whole
    .replace(FEAT_PAREN_RE, (_, inner) => {
      featContents.push(inner);
      return ' ';
    })
    .trim();
  if (main !== '') {
    for (const piece of main.split(SPLIT_RE)) {
      const trimmed = piece.trim();
      if (trimmed !== '') parts.push(trimmed);
    }
  }
  for (const inner of featContents) {
    if (inner !== '') parts.push(inner);
    if (inner !== '' && OF_RE.test(inner)) {
      for (const piece of inner.split(OF_RE)) {
        const trimmed = piece.trim();
        if (trimmed !== '') parts.push(trimmed);
      }
    }
  }
  const seen = new Set();
  return parts.filter((part) => {
    const key = normalizeForMatch(part);
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readDropListKeys(relativePath) {
  let source;
  try {
    source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`required TJ production drop-list source is missing: ${relativePath}`);
    }
    throw err;
  }
  const keys = new Set();
  for (const [, rawVariants] of source.matchAll(/variants:\s*\[([\s\S]*?)\]/gu)) {
    for (const match of rawVariants.matchAll(/'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"/gu)) {
      const raw = match[1] ?? match[2] ?? '';
      const variant = raw.replace(/\\(['"\\])/gu, '$1');
      const key = normalizeForMatch(variant);
      if (key !== '') keys.add(key);
    }
  }
  if (keys.size === 0) {
    throw new Error(`required TJ production drop-list source produced no keys: ${relativePath}`);
  }
  return keys;
}

const KOREAN_DROP_KEYS = readDropListKeys(
  '../../packages/crawler/src/curated/koreanArtistDropList.ts',
);
const CHINESE_DROP_KEYS = readDropListKeys(
  '../../packages/crawler/src/curated/chineseArtistDropList.ts',
);

function sameTitleArtist(row, record) {
  return (
    normalizeForComparison(row?.songName) === normalizeForComparison(record?.title_primary) &&
    normalizeForComparison(row?.artistName) === normalizeForComparison(record?.artist_primary)
  );
}

export function analyzeJoysoundListing(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error('analyzeJoysoundListing: rows must be an array');

  const baselineNumbers = baselineJoysoundNumberMap(options.baselineRecords);
  const seenKeys = new Set();
  const duplicateRows = [];
  const buckets = makeBucketStore([
    'knownKoreanAct',
    'knownWesternAct',
    'noJapaneseTitleArtist',
    'asciiOnlyTitleArtist',
    'bareAnimeTokenRisk',
    'latinVocaloidSubstringRisk',
    'existingJoysoundNumberOverlap',
    'existingJoysoundNumberConflict',
  ]);

  for (const row of rows) {
    const key = `${row?.naviGroupId ?? ''}|${row?.selSongNo ?? ''}`;
    if (seenKeys.has(key)) {
      duplicateRows.push(row);
    } else {
      seenKeys.add(key);
    }

    const surface = listingText(row);
    const titleArtist = listingTitleArtistText(row);
    const artist = asString(row?.artistName);
    if (matchesAny(artist, KOREAN_ACT_PATTERNS)) buckets.knownKoreanAct.push(row);
    if (isKnownWesternAct(artist)) buckets.knownWesternAct.push(row);
    if (!hasJapaneseOrAmbiguousHan(titleArtist)) buckets.noJapaneseTitleArtist.push(row);
    if (isAsciiOnlyTitleArtist(titleArtist)) buckets.asciiOnlyTitleArtist.push(row);
    if (isBareAnimeTokenRisk(surface)) buckets.bareAnimeTokenRisk.push(row);
    if (isLatinVocaloidSubstringRisk(surface)) buckets.latinVocaloidSubstringRisk.push(row);
    const baselineMatches = baselineNumbers.get(normalizeJoysoundNumber(row?.selSongNo));
    if (baselineMatches) {
      const auditItem = { row, baseline: baselineMatches };
      buckets.existingJoysoundNumberOverlap.push(auditItem);
      if (!baselineMatches.some((record) => sameTitleArtist(row, record))) {
        buckets.existingJoysoundNumberConflict.push(auditItem);
      }
    }
  }

  const bucketData = bucketReport(buckets, sampleListingAuditItem);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalRows: rows.length,
      uniqueKeys: seenKeys.size,
      duplicateKeys: duplicateRows.length,
      baselineJoysoundNumbers: baselineNumbers.size,
    },
    ...bucketData,
  };
}

const JOYSOUND_DB_FP_BUCKETS = [
  'existingNumberConflict',
  'foreignActAdmitted',
  'hanNoKanaAdmitted',
  'asciiOnlyAdmitted',
  'categoryAmbiguous',
];

const JOYSOUND_DB_FN_BUCKETS = [
  'droppedHasKana',
  'droppedKnownJpArtist',
  'droppedForeignButJpRelease',
  'droppedHanAmbiguous',
  'droppedAsciiOnly',
];

// Admit paths whose primary evidence is a STRONG positive signal (corpus-confirmed
// Japanese act, or a curated hand-review allow), NOT weak-script heuristics. These
// rows must NOT land in the Han-only / ASCII-only weak-script FP buckets — their
// script shape is irrelevant given the strong signal. Token-based admit-vocaloid /
// admit-anime admits are intentionally NOT excluded: a token + Han-only/ASCII-only
// title could still be a non-Japanese coincidence worth the P2 look.
const STRONG_SIGNAL_ADMIT_REASONS = new Set(['admit-jp-artist', 'reviewed-allow']);

function decisionLogTitleArtist(entry) {
  return [entry?.title, entry?.artist].filter((value) => typeof value === 'string').join(' ');
}

function decisionLogMatchesRecord(entry, record) {
  return (
    normalizeForComparison(entry?.title) === normalizeForComparison(record?.title_primary) &&
    normalizeForComparison(entry?.artist) === normalizeForComparison(record?.artist_primary)
  );
}

function isAuditForeignAct(artist) {
  return (
    isProductionDropListArtist(artist) ||
    matchesAny(artist, KOREAN_ACT_PATTERNS) ||
    isKnownWesternAct(artist)
  );
}

function corpusArtistKeySet(records) {
  const keys = new Set();
  for (const record of records ?? []) {
    const key = normalizeForComparison(record?.artist_primary);
    if (key.length > 0) keys.add(key);
  }
  return keys;
}

function joysoundDecisionEvidenceRow({ bucket, priority, entry, why, suggested }) {
  return {
    bucket,
    priority,
    selSongNo: normalizeJoysoundNumber(entry?.selSongNo),
    title: asString(entry?.title),
    artist: asString(entry?.artist),
    decision: asString(entry?.decision),
    reason: asString(entry?.reason),
    why_flagged: why,
    suggested_verdict: suggested,
    script_signal: scriptSignalFor(decisionLogTitleArtist(entry)),
    reviewer_verdict: '',
    reviewer_note: '',
  };
}

function joysoundDbBucketData(buckets) {
  return bucketReport(buckets, (row) => row);
}

function collectJoysoundDatabaseIssues({ decisionLog, records }) {
  const baselineNumbers = baselineJoysoundNumberMap(records);
  const corpusArtists = corpusArtistKeySet(records);
  const falsePositive = makeBucketStore(JOYSOUND_DB_FP_BUCKETS);
  const falseNegative = makeBucketStore(JOYSOUND_DB_FN_BUCKETS);
  let conflicts = 0;
  let admitted = 0;
  let dropped = 0;
  const byReason = {};

  for (const entry of decisionLog) {
    addCount(byReason, asString(entry?.reason) || '(missing)');
    const titleArtist = decisionLogTitleArtist(entry);
    const artist = asString(entry?.artist);
    const numberKey = normalizeJoysoundNumber(entry?.selSongNo);
    const baselineMatches = numberKey === '' ? undefined : baselineNumbers.get(numberKey);
    const baselineConflict =
      Array.isArray(baselineMatches) &&
      baselineMatches.length > 0 &&
      !baselineMatches.some((record) => decisionLogMatchesRecord(entry, record));
    if (baselineConflict) conflicts++;

    if (entry?.decision === 'admit') {
      admitted++;
      const isStrongSignalAdmit = STRONG_SIGNAL_ADMIT_REASONS.has(asString(entry?.reason));
      if (baselineConflict) {
        pushIssue(
          falsePositive,
          'existingNumberConflict',
          joysoundDecisionEvidenceRow({
            bucket: 'existingNumberConflict',
            priority: 'P0',
            entry,
            why: 'admitted JOYSOUND number already in corpus but maps to a different title/artist',
            suggested: 'DROP_FALSE_POSITIVE',
          }),
        );
      }
      if (isAuditForeignAct(artist)) {
        pushIssue(
          falsePositive,
          'foreignActAdmitted',
          joysoundDecisionEvidenceRow({
            bucket: 'foreignActAdmitted',
            priority: 'P0',
            entry,
            why: 'admitted but artist trips the audit Korean/Chinese/Western foreign-act lists',
            suggested: 'DROP_FALSE_POSITIVE',
          }),
        );
      }
      if (!isStrongSignalAdmit && RE_HAN.test(titleArtist) && !hasKana(titleArtist)) {
        pushIssue(
          falsePositive,
          'hanNoKanaAdmitted',
          joysoundDecisionEvidenceRow({
            bucket: 'hanNoKanaAdmitted',
            priority: 'P2',
            entry,
            why: 'admitted with Han-but-no-kana title/artist (Mandopop risk)',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (!isStrongSignalAdmit && isAsciiOnlyTitleArtist(titleArtist)) {
        pushIssue(
          falsePositive,
          'asciiOnlyAdmitted',
          joysoundDecisionEvidenceRow({
            bucket: 'asciiOnlyAdmitted',
            priority: 'P2',
            entry,
            why: 'admitted Latin-only title/artist with weak Japanese evidence',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (entry?.detailFlipRisk === true) {
        pushIssue(
          falsePositive,
          'categoryAmbiguous',
          joysoundDecisionEvidenceRow({
            bucket: 'categoryAmbiguous',
            priority: 'P3',
            entry,
            why: 'admitted but the listing-level verdict may flip with per-song detail',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
    } else if (entry?.decision === 'drop') {
      dropped++;
      const isForeignReason =
        entry?.reason === 'foreign-korean' ||
        entry?.reason === 'foreign-western' ||
        entry?.reason === 'foreign-chinese';
      if (hasKana(titleArtist)) {
        pushIssue(
          falseNegative,
          'droppedHasKana',
          joysoundDecisionEvidenceRow({
            bucket: 'droppedHasKana',
            priority: 'P0',
            entry,
            why: 'dropped though title/artist has kana',
            suggested: 'ADD_FALSE_NEGATIVE',
          }),
        );
      }
      if (corpusArtists.has(normalizeForComparison(artist))) {
        pushIssue(
          falseNegative,
          'droppedKnownJpArtist',
          joysoundDecisionEvidenceRow({
            bucket: 'droppedKnownJpArtist',
            priority: 'P1',
            entry,
            why: 'dropped but artist matches a known Japanese act already present in the corpus',
            suggested: 'ADD_FALSE_NEGATIVE',
          }),
        );
      }
      if (isForeignReason && hasKana(titleArtist)) {
        pushIssue(
          falseNegative,
          'droppedForeignButJpRelease',
          joysoundDecisionEvidenceRow({
            bucket: 'droppedForeignButJpRelease',
            priority: 'P1',
            entry,
            why: 'dropped as foreign but title/artist has kana (likely Japanese release/collab → ALLOW candidate)',
            suggested: 'POLICY_EDGE',
          }),
        );
      }
      if (entry?.reason === 'drop-han-only') {
        pushIssue(
          falseNegative,
          'droppedHanAmbiguous',
          joysoundDecisionEvidenceRow({
            bucket: 'droppedHanAmbiguous',
            priority: 'P3',
            entry,
            why: 'dropped Han-only that may be Japanese kanji',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
      if (entry?.reason === 'drop-ascii-only') {
        pushIssue(
          falseNegative,
          'droppedAsciiOnly',
          joysoundDecisionEvidenceRow({
            bucket: 'droppedAsciiOnly',
            priority: 'P3',
            entry,
            why: 'dropped Latin-only that may be a Latin-named Japanese act',
            suggested: 'NEEDS_MORE_EVIDENCE',
          }),
        );
      }
    }
  }

  return {
    falsePositive,
    falseNegative,
    summary: {
      decisionLogRows: decisionLog.length,
      admitted,
      dropped,
      byReason,
      corpusJoysoundNumbers: baselineNumbers.size,
      conflicts,
    },
  };
}

export function analyzeJoysoundDatabase({ decisionLog, records }) {
  if (!Array.isArray(decisionLog)) {
    throw new Error('analyzeJoysoundDatabase: decisionLog must be an array');
  }
  if (!Array.isArray(records)) {
    throw new Error('analyzeJoysoundDatabase: records must be an array');
  }
  const { falsePositive, falseNegative, summary } = collectJoysoundDatabaseIssues({
    decisionLog,
    records,
  });
  return {
    generatedAt: new Date().toISOString(),
    summary,
    falsePositive: joysoundDbBucketData(falsePositive),
    falseNegative: joysoundDbBucketData(falseNegative),
  };
}

function collectJoysoundDatabaseIssueRows(decisionLog, records) {
  const { falsePositive, falseNegative } = collectJoysoundDatabaseIssues({ decisionLog, records });
  return {
    falsePositiveRows: Object.values(falsePositive)
      .flat()
      .map((row) => issueRow('joysound-db-false-positive', row.bucket, row)),
    falseNegativeRows: Object.values(falseNegative)
      .flat()
      .map((row) => issueRow('joysound-db-false-negative', row.bucket, row)),
  };
}

function mapById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function duplicateIdReport(records) {
  const byId = new Map();
  for (const record of records) {
    const id = record?.id ?? '(missing)';
    const existing = byId.get(id) ?? [];
    existing.push(record);
    byId.set(id, existing);
  }
  return [...byId.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([id, matches]) => ({
      id,
      count: matches.length,
      samples: matches.slice(0, SAMPLE_LIMIT).map(sampleRichRecord),
    }));
}

function isPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

function valueAt(record, path) {
  let current = record;
  for (const part of path) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function sourceCountsFor(records) {
  const counts = {};
  for (const record of records) addCount(counts, sourceOf(record));
  return counts;
}

function providerNumberCounts(records) {
  const counts = { tj: 0, ky: 0, joysound: 0 };
  for (const record of records) {
    for (const provider of Object.keys(counts)) {
      if (typeof record?.karaoke_numbers?.[provider] === 'string') counts[provider]++;
    }
  }
  return counts;
}

function changedTopLevelFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => stableStringify(before[key]) !== stableStringify(after[key]))
    .sort();
}

function lostRichFields(before, after) {
  const fields = [
    ['title_primary'],
    ['title_ko'],
    ['artist_primary'],
    ['artist_ko'],
    ['artist_aliases'],
    ['media_context_ko'],
    ['karaoke_numbers', 'tj'],
    ['karaoke_numbers', 'ky'],
    ['karaoke_numbers', 'joysound'],
  ];
  return fields
    .filter((path) => isPresent(valueAt(before, path)) && !isPresent(valueAt(after, path)))
    .map((path) => path.join('.'));
}

export function compareCorpora(baselineRecords, candidateRecords) {
  if (!Array.isArray(baselineRecords)) throw new Error('compareCorpora: baseline must be an array');
  if (!Array.isArray(candidateRecords))
    throw new Error('compareCorpora: candidate must be an array');

  const baselineDuplicates = duplicateIdReport(baselineRecords);
  const candidateDuplicates = duplicateIdReport(candidateRecords);
  const baseline = mapById(baselineRecords);
  const candidate = mapById(candidateRecords);
  const added = candidateRecords.filter((record) => !baseline.has(record.id));
  const removed = baselineRecords.filter((record) => !candidate.has(record.id));
  const mutated = [];
  const richFieldLoss = [];

  for (const [id, before] of baseline) {
    const after = candidate.get(id);
    if (!after) continue;
    if (stableStringify(before) !== stableStringify(after)) {
      mutated.push({
        id,
        before: sampleRichRecord(before),
        after: sampleRichRecord(after),
        changedFields: changedTopLevelFields(before, after),
      });
    }
    const lostFields = lostRichFields(before, after);
    if (lostFields.length > 0) {
      richFieldLoss.push({
        id,
        lostFields,
        before: sampleRichRecord(before),
        after: sampleRichRecord(after),
      });
    }
  }

  const suspiciousAdditions = analyzeCorpus(added);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      baselineCount: baselineRecords.length,
      candidateCount: candidateRecords.length,
      added: added.length,
      removed: removed.length,
      intersection: baselineRecords.length - removed.length,
      mutatedExisting: mutated.length,
      richFieldLoss: richFieldLoss.length,
      duplicateBaselineIds: baselineDuplicates.length,
      duplicateCandidateIds: candidateDuplicates.length,
      officialJoysoundAdditions: added.filter(isOfficialJoysoundSource).length,
    },
    sourceCounts: {
      baseline: sourceCountsFor(baselineRecords),
      candidate: sourceCountsFor(candidateRecords),
      added: sourceCountsFor(added),
      removed: sourceCountsFor(removed),
    },
    providerNumberCounts: {
      baseline: providerNumberCounts(baselineRecords),
      candidate: providerNumberCounts(candidateRecords),
    },
    duplicateIdSamples: {
      baseline: baselineDuplicates.slice(0, SAMPLE_LIMIT),
      candidate: candidateDuplicates.slice(0, SAMPLE_LIMIT),
    },
    removedSamples: removed.slice(0, SAMPLE_LIMIT).map(sampleRecord),
    addedSamples: added.slice(0, SAMPLE_LIMIT).map(sampleRecord),
    mutatedSamples: mutated.slice(0, SAMPLE_LIMIT),
    richFieldLossSamples: richFieldLoss.slice(0, SAMPLE_LIMIT),
    suspiciousAdditions,
  };
}

function readJsonArray(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array`);
  return parsed;
}

function readJsonOrJsonlArray(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return [];
  if (raw.startsWith('[')) return readJsonArray(path);
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const flags = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key ?? '(end)'}`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

function requireFlag(flags, name) {
  if (typeof flags[name] !== 'string' || flags[name].length === 0) {
    throw new Error(`missing --${name}`);
  }
  return flags[name];
}

function realPathIfExists(path) {
  try {
    return realpathSync.native(path);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

const TJ_REVIEW_QUEUE_FILENAMES = [
  'review-fp-high.tsv',
  'review-fp-policy-edge.tsv',
  'review-fn-high.tsv',
  'review-fn-medium.tsv',
];

const JOYSOUND_REVIEW_QUEUE_FILENAMES = [
  'review-fp-high.tsv',
  'review-fp-other.tsv',
  'review-fn-high.tsv',
  'review-fn-other.tsv',
];

function outputFlagEntries(flags, reviewQueueFilenames = TJ_REVIEW_QUEUE_FILENAMES) {
  const outputs = ['out', 'issues-out', 'fp-issues-out', 'fn-issues-out']
    .map((name) => [name, flags[name]])
    .filter(([, value]) => typeof value === 'string' && value.length > 0);
  if (typeof flags['review-dir'] === 'string' && flags['review-dir'].length > 0) {
    outputs.push(['review-dir', flags['review-dir']]);
    for (const filename of reviewQueueFilenames) {
      outputs.push([`review-dir/${filename}`, resolve(flags['review-dir'], filename)]);
    }
  }
  return outputs;
}

function assertOutputDoesNotOverwriteInput(
  flags,
  names,
  reviewQueueFilenames = TJ_REVIEW_QUEUE_FILENAMES,
) {
  const outputs = outputFlagEntries(flags, reviewQueueFilenames);
  for (const [outputName, outputValue] of outputs) {
    const outputPath = resolve(outputValue);
    const outputRealPath = realPathIfExists(outputPath);
    try {
      if (lstatSync(outputPath).isSymbolicLink()) {
        throw new Error(
          `refusing to write audit output through symlink: --${outputName} is a symbolic link`,
        );
      }
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;
    }

    for (const name of names) {
      const value = flags[name];
      if (typeof value !== 'string' || value.length === 0) continue;
      const inputPath = resolve(value);
      const inputRealPath = realPathIfExists(inputPath);
      if (
        inputPath === outputPath ||
        (outputRealPath && inputRealPath && outputRealPath === inputRealPath)
      ) {
        throw new Error(
          `refusing to write audit output over input path: --${outputName} matches --${name}`,
        );
      }
    }
  }

  for (let i = 0; i < outputs.length; i++) {
    const [leftName, leftValue] = outputs[i];
    const leftPath = resolve(leftValue);
    for (const [rightName, rightValue] of outputs.slice(i + 1)) {
      if (leftPath === resolve(rightValue)) {
        throw new Error(
          `refusing to use the same audit output path for --${leftName} and --${rightName}`,
        );
      }
    }
  }
}

function writeJsonl(path, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '');
}

const TJ_REVIEW_COLUMNS = [
  'bucket',
  'priority',
  'tj',
  'current_id',
  'current_source',
  'current_title',
  'current_artist',
  'official_title',
  'official_artist',
  'official_nationalcode',
  'artist_cache_code',
  'artist_cache_any_code',
  'pro_cache_nationalcode',
  'script_signal',
  'why_flagged',
  'suggested_verdict',
  'reviewer_verdict',
  'reviewer_note',
];

const JOYSOUND_REVIEW_COLUMNS = [
  'bucket',
  'priority',
  'selSongNo',
  'title',
  'artist',
  'decision',
  'reason',
  'script_signal',
  'why_flagged',
  'suggested_verdict',
  'reviewer_verdict',
  'reviewer_note',
];

function tsvCell(value) {
  return asString(value ?? '')
    .replace(/\r?\n/gu, ' ')
    .replace(/\t/gu, ' ');
}

function writeTsv(path, rows, columns = TJ_REVIEW_COLUMNS) {
  const lines = [
    columns.join('\t'),
    ...rows.map((row) => columns.map((column) => tsvCell(row[column])).join('\t')),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function writeTjReviewQueues(reviewDir, falsePositiveRows, falseNegativeRows) {
  mkdirSync(reviewDir, { recursive: true });
  const rawFp = falsePositiveRows.map(({ mode: _mode, ...row }) => row);
  const rawFn = falseNegativeRows.map(({ mode: _mode, ...row }) => row);
  writeTsv(
    resolve(reviewDir, 'review-fp-high.tsv'),
    rawFp.filter((row) => row.priority === 'P0' || row.priority === 'P1'),
  );
  writeTsv(
    resolve(reviewDir, 'review-fp-policy-edge.tsv'),
    rawFp.filter((row) => row.priority !== 'P0' && row.priority !== 'P1'),
  );
  writeTsv(
    resolve(reviewDir, 'review-fn-high.tsv'),
    rawFn.filter((row) => row.priority === 'P0' || row.priority === 'P1'),
  );
  writeTsv(
    resolve(reviewDir, 'review-fn-medium.tsv'),
    rawFn.filter((row) => row.priority === 'P2' || row.priority === 'P3'),
  );
}

function isHighPriority(row) {
  return row.priority === 'P0' || row.priority === 'P1';
}

function writeJoysoundReviewQueues(reviewDir, falsePositiveRows, falseNegativeRows) {
  mkdirSync(reviewDir, { recursive: true });
  const rawFp = falsePositiveRows.map(({ mode: _mode, ...row }) => row);
  const rawFn = falseNegativeRows.map(({ mode: _mode, ...row }) => row);
  writeTsv(
    resolve(reviewDir, 'review-fp-high.tsv'),
    rawFp.filter(isHighPriority),
    JOYSOUND_REVIEW_COLUMNS,
  );
  writeTsv(
    resolve(reviewDir, 'review-fp-other.tsv'),
    rawFp.filter((row) => !isHighPriority(row)),
    JOYSOUND_REVIEW_COLUMNS,
  );
  writeTsv(
    resolve(reviewDir, 'review-fn-high.tsv'),
    rawFn.filter(isHighPriority),
    JOYSOUND_REVIEW_COLUMNS,
  );
  writeTsv(
    resolve(reviewDir, 'review-fn-other.tsv'),
    rawFn.filter((row) => !isHighPriority(row)),
    JOYSOUND_REVIEW_COLUMNS,
  );
}

function readJsonObject(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  let report;
  let issueRows = [];
  const extraJsonlWrites = [];
  let reviewQueueWrite = null;
  if (flags.mode === 'corpus') {
    const inputPath = requireFlag(flags, 'in');
    assertOutputDoesNotOverwriteInput(flags, ['in']);
    const records = readJsonArray(inputPath);
    report = analyzeCorpus(records);
    issueRows = collectCorpusIssueRows(records);
  } else if (flags.mode === 'joysound-listing') {
    const inputPath = requireFlag(flags, 'in');
    const baselinePath = flags.baseline;
    assertOutputDoesNotOverwriteInput(flags, ['in', 'baseline']);
    const rows = readJsonOrJsonlArray(inputPath);
    const baselineRecords = baselinePath ? readJsonArray(baselinePath) : [];
    report = analyzeJoysoundListing(rows, { baselineRecords });
    issueRows = collectJoysoundListingIssueRows(rows, { baselineRecords });
  } else if (flags.mode === 'merge-delta') {
    assertOutputDoesNotOverwriteInput(flags, ['baseline', 'candidate']);
    const baselineRecords = readJsonArray(requireFlag(flags, 'baseline'));
    const candidateRecords = readJsonArray(requireFlag(flags, 'candidate'));
    report = compareCorpora(baselineRecords, candidateRecords);
    issueRows = collectMergeDeltaIssueRows(baselineRecords, candidateRecords);
  } else if (flags.mode === 'tj-db') {
    assertOutputDoesNotOverwriteInput(flags, ['corpus', 'tj-catalog', 'cache']);
    const records = readJsonArray(requireFlag(flags, 'corpus'));
    const tjCatalog = readJsonOrJsonlArray(requireFlag(flags, 'tj-catalog'));
    const cache = flags.cache ? readJsonObject(flags.cache) : {};
    report = analyzeTjDatabase({ records, tjCatalog, cache });
    const { falsePositiveRows, falseNegativeRows } = collectTjDatabaseIssueRows(
      records,
      tjCatalog,
      cache,
    );
    issueRows = [...falsePositiveRows, ...falseNegativeRows];
    if (flags['fp-issues-out']) extraJsonlWrites.push([flags['fp-issues-out'], falsePositiveRows]);
    if (flags['fn-issues-out']) extraJsonlWrites.push([flags['fn-issues-out'], falseNegativeRows]);
    if (flags['review-dir']) {
      reviewQueueWrite = () =>
        writeTjReviewQueues(flags['review-dir'], falsePositiveRows, falseNegativeRows);
    }
  } else if (flags.mode === 'joysound-db') {
    assertOutputDoesNotOverwriteInput(
      flags,
      ['decision-log', 'corpus'],
      JOYSOUND_REVIEW_QUEUE_FILENAMES,
    );
    const decisionLog = readJsonOrJsonlArray(requireFlag(flags, 'decision-log'));
    const records = readJsonArray(requireFlag(flags, 'corpus'));
    report = analyzeJoysoundDatabase({ decisionLog, records });
    const { falsePositiveRows, falseNegativeRows } = collectJoysoundDatabaseIssueRows(
      decisionLog,
      records,
    );
    issueRows = [...falsePositiveRows, ...falseNegativeRows];
    if (flags['fp-issues-out']) extraJsonlWrites.push([flags['fp-issues-out'], falsePositiveRows]);
    if (flags['fn-issues-out']) extraJsonlWrites.push([flags['fn-issues-out'], falseNegativeRows]);
    if (flags['review-dir']) {
      reviewQueueWrite = () =>
        writeJoysoundReviewQueues(flags['review-dir'], falsePositiveRows, falseNegativeRows);
    }
  } else {
    throw new Error(
      'usage: audit-corpus-guardrails.mjs <corpus|joysound-listing|merge-delta> --in PATH --out PATH [--issues-out PATH] OR tj-db --corpus PATH --tj-catalog PATH [--cache PATH] --out PATH [--issues-out PATH] [--fp-issues-out PATH] [--fn-issues-out PATH] [--review-dir DIR] OR joysound-db --decision-log PATH --corpus PATH --out PATH [--issues-out PATH] [--fp-issues-out PATH] [--fn-issues-out PATH] [--review-dir DIR]',
    );
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (flags.out) writeFileSync(flags.out, json);
  else process.stdout.write(json);
  if (flags['issues-out']) writeJsonl(flags['issues-out'], issueRows);
  for (const [path, rows] of extraJsonlWrites) writeJsonl(path, rows);
  if (reviewQueueWrite) reviewQueueWrite();
  return report;
}

if (isCliInvocation(import.meta.url)) {
  try {
    runCli();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  }
}
