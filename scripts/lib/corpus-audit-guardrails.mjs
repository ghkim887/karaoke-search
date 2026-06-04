import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const GENERIC_ARTIST_RE = /^(?:Various Artists|Various|Unknown|オムニバス)$/iu;

const KOREAN_ACT_PATTERNS = [
  /\b(?:aespa|BABYMONSTER|ENHYPEN|ITZY|IVE|NCT\s*DREAM|NCT\s*WISH|NMIXX|SEVENTEEN|STRAY\s*KIDS|ZEROBASEONE|BTS|BLACKPINK|TWICE|TOMORROW\s*X\s*TOGETHER|TXT|TREASURE|BIGBANG|2NE1|GFRIEND|SUPER\s*JUNIOR|RED\s*VELVET|MONSTA\s*X|MAMAMOO|GOT7|EXO|ATEEZ|Kep1er|BOYNEXTDOOR|KISS\s*OF\s*LIFE|SHINee|KARA)\b/iu,
  /(?:東方神起|少女時代|エスパ|アイヴ|エンハイプン|エヌシーティー|ストレイキッズ|セブンティーン|チョンソミ|ニュージーンズ|ルセラフィム|ベイビーモンスター|ゼロベースワン|トゥワイス|ブラックピンク|トゥモローバイトゥギャザー|トレジャー|レッドベルベット|モンスタエックス|ママムー|ヨジャチング|スーパージュニア|ビッグバン|トゥエニィワン|エクソ|エイティーズ|ケプラー|ボーイネクストドア|キスオブライフ|ゴットセブン)/u,
];

const WESTERN_ACT_COMPONENTS = new Set([
  'ADELE',
  'ARIANA GRANDE',
  'BACKSTREET BOYS',
  'BILLIE EILISH',
  'BRUNO MARS',
  'CELINE DION',
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
    categories: asArray(record.categories),
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

export function analyzeCorpus(records) {
  if (!Array.isArray(records)) throw new Error('analyzeCorpus: records must be an array');

  const sourceCounts = {};
  const categoryCounts = {};
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
    for (const category of asArray(record.categories)) addCount(categoryCounts, category);
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
    if (GENERIC_ARTIST_RE.test(artist) && !hasKana(fullText)) {
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
    categoryCounts,
    ...bucketData,
  };
}

function baselineJoysoundNumberMap(records) {
  const numbers = new Map();
  for (const record of records ?? []) {
    const value = record?.karaoke_numbers?.joysound;
    if (typeof value !== 'string' || value.length === 0) continue;
    const existing = numbers.get(value) ?? [];
    existing.push(record);
    numbers.set(value, existing);
  }
  return numbers;
}

function normalizeForComparison(value) {
  return asString(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
}

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
    const baselineMatches = baselineNumbers.get(row?.selSongNo);
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function categoryCountsFor(records) {
  const counts = {};
  for (const record of records) {
    for (const category of asArray(record.categories)) addCount(counts, category);
  }
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
    categoryCounts: {
      baseline: categoryCountsFor(baselineRecords),
      candidate: categoryCountsFor(candidateRecords),
      added: categoryCountsFor(added),
      removed: categoryCountsFor(removed),
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

function assertOutputDoesNotOverwriteInput(flags, names) {
  if (typeof flags.out !== 'string' || flags.out.length === 0) return;
  const outputPath = resolve(flags.out);
  const outputRealPath = realPathIfExists(outputPath);
  try {
    if (lstatSync(outputPath).isSymbolicLink()) {
      throw new Error('refusing to write audit output through symlink: --out is a symbolic link');
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
      throw new Error(`refusing to write audit output over input path: --out matches --${name}`);
    }
  }
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  let report;
  if (flags.mode === 'corpus') {
    const inputPath = requireFlag(flags, 'in');
    assertOutputDoesNotOverwriteInput(flags, ['in']);
    report = analyzeCorpus(readJsonArray(inputPath));
  } else if (flags.mode === 'joysound-listing') {
    const inputPath = requireFlag(flags, 'in');
    const baselinePath = flags.baseline;
    assertOutputDoesNotOverwriteInput(flags, ['in', 'baseline']);
    report = analyzeJoysoundListing(readJsonOrJsonlArray(inputPath), {
      baselineRecords: baselinePath ? readJsonArray(baselinePath) : [],
    });
  } else if (flags.mode === 'merge-delta') {
    assertOutputDoesNotOverwriteInput(flags, ['baseline', 'candidate']);
    report = compareCorpora(
      readJsonArray(requireFlag(flags, 'baseline')),
      readJsonArray(requireFlag(flags, 'candidate')),
    );
  } else {
    throw new Error(
      'usage: audit-corpus-guardrails.mjs <corpus|joysound-listing|merge-delta> --in PATH --out PATH',
    );
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (flags.out) writeFileSync(flags.out, json);
  else process.stdout.write(json);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  }
}
