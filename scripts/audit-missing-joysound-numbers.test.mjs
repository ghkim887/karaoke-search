// Tests for scripts/audit-missing-joysound-numbers.mjs — the R1 read-only
// audit of TJ/KY-but-no-JOYSOUND songs. Covers the pure pieces that hold the
// audit's correctness: the decoration-stripping helper (the second title-match
// axis), the tiering decision, and CSV row serialisation with fields that
// contain commas/quotes. The clustering primitives are stubbed with tiny fakes
// so these tests stay hermetic (no crawler-dist dependency); the ground-truth
// realism check lives in the actual corpus run, not here.

import { describe, expect, it } from 'vitest';
import {
  artistKeySet,
  auditCorpus,
  buildCsvRows,
  findCandidates,
  parseArgs,
  stripDecorations,
  tierForSong,
} from './audit-missing-joysound-numbers.mjs';
import { csvEscape } from './lib/csv.mjs';

// Fakes mirroring the observable behaviour the audit relies on: whitespace
// removal + lowercase for the key, and `&`-splitting for collab artists.
const fakeDeps = {
  normalizeForMatch: (s) => String(s).replace(/\s+/g, '').toLowerCase(),
  splitArtistCollab: (s) => {
    const whole = String(s).trim();
    if (whole === '') return [];
    const parts = [whole, ...whole.split('&').map((p) => p.trim())];
    return [...new Set(parts.filter((p) => p !== ''))];
  },
};

describe('stripDecorations', () => {
  it('peels a trailing tie-up suffix (half-width parens)', () => {
    expect(stripDecorations('マイホーム(ドラマ ED)')).toBe('マイホーム');
  });

  it('peels a trailing suffix in full-width parens', () => {
    expect(stripDecorations('タイトル（アニメ OP）')).toBe('タイトル');
  });

  it('peels repeated trailing parenthesized segments', () => {
    expect(stripDecorations('Title(A)(B)')).toBe('Title');
  });

  it('peels a trailing 〈...〉 version tag (JOYSOUND Days〈Original mix〉 case)', () => {
    expect(stripDecorations('Days〈Original mix〉')).toBe('Days');
  });

  it('peels a trailing 《...》 annotation tag', () => {
    expect(stripDecorations('STAY GOLD《本人映像》')).toBe('STAY GOLD');
  });

  it('collapses internal whitespace runs', () => {
    // TJ emits `抱 擁` where JOYSOUND has `抱擁`.
    expect(stripDecorations('抱  擁')).toBe('抱 擁');
  });

  it('folds curly quotes to ASCII and peels the suffix (けいおん! case)', () => {
    // TJ's typographic apostrophe/quotes (U+2019/U+201C/U+201D) must fold so
    // the stripped key can reach JOYSOUND's ASCII-quoted `Don't say"lazy"`.
    expect(stripDecorations('Don’t say “lazy”(けいおん! ED)')).toBe('Don\'t say "lazy"');
  });

  it('does NOT strip a title that is only a parenthetical (would empty it)', () => {
    expect(stripDecorations('(instrumental)')).toBe('(instrumental)');
    expect(stripDecorations('（インスト）')).toBe('（インスト）');
  });

  it('leaves a leading/mid-title paren untouched', () => {
    expect(stripDecorations('(reprise) main')).toBe('(reprise) main');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(stripDecorations('')).toBe('');
    expect(stripDecorations(null)).toBe('');
    expect(stripDecorations(undefined)).toBe('');
  });
});

describe('tierForSong', () => {
  it('is C when there are no candidates', () => {
    expect(tierForSong([])).toBe('C');
  });

  it('is A when any candidate shares an artist component', () => {
    expect(
      tierForSong([
        { overlapCount: 0, match_kind: 'exact-title' },
        { overlapCount: 2, match_kind: 'stripped-title' },
      ]),
    ).toBe('A');
  });

  it('is B when title matches but no candidate has artist overlap', () => {
    expect(
      tierForSong([
        { overlapCount: 0, match_kind: 'exact-title' },
        { overlapCount: 0, match_kind: 'stripped-title' },
      ]),
    ).toBe('B');
  });
});

describe('artistKeySet', () => {
  it('unions primary, aliases, and artist_ko, split on collab delimiters', () => {
    const keys = artistKeySet(
      {
        artist_primary: 'imase & なとり',
        artist_aliases: ['IMASE'],
        artist_ko: '이마세',
      },
      fakeDeps,
    );
    // 'imase & なとり' -> whole + 'imase' + 'なとり';
    // alias 'IMASE' collapses onto 'imase'; artist_ko adds one more key.
    expect(keys.has('imase')).toBe(true);
    expect(keys.has('なとり')).toBe(true);
    expect(keys.has('이마세')).toBe(true);
  });
});

describe('findCandidates / auditCorpus tiering end to end', () => {
  // Minimal corpus: one affected TJ-only song and JOYSOUND-numbered candidates
  // that exercise exact-vs-stripped ranking and artist-overlap tiering.
  const corpus = [
    {
      id: 'tj-1',
      title_primary: 'Home(ドラマ ED)',
      artist_primary: 'Old Name',
      karaoke_numbers: { tj: '1', ky: null, joysound: null },
    },
    {
      id: 'joy-exact',
      title_primary: 'Home(ドラマ ED)',
      artist_primary: 'Old Name',
      karaoke_numbers: { tj: null, ky: null, joysound: '100' },
    },
    {
      id: 'joy-stripped',
      title_primary: 'Home',
      artist_primary: 'Someone Else',
      karaoke_numbers: { tj: null, ky: null, joysound: '200' },
    },
  ];

  it('ranks exact-title above stripped-title and tiers the song A via overlap', () => {
    const { results, summary } = auditCorpus(corpus, fakeDeps);
    expect(results).toHaveLength(1);
    const [row] = results;
    expect(row.song_id).toBe('tj-1');
    // exact-title candidate (shared artist) must sort first.
    expect(row.candidates[0].candidate_id).toBe('joy-exact');
    expect(row.candidates[0].match_kind).toBe('exact-title');
    expect(row.candidates[0].artist_overlap_keys).toContain('oldname');
    // second is the stripped-title, zero-overlap candidate.
    expect(row.candidates[1].candidate_id).toBe('joy-stripped');
    expect(row.candidates[1].match_kind).toBe('stripped-title');
    // song shares an artist with joy-exact -> tier A.
    expect(row.tier).toBe('A');
    expect(summary.byTier).toEqual({ A: 1, B: 0, C: 0 });
    expect(summary.byMatchKind).toEqual({ 'exact-title': 1, 'stripped-title': 1 });
  });

  it('tiers a title-only match with zero artist overlap as B', () => {
    const bOnly = [
      {
        id: 'tj-2',
        title_primary: 'Solo',
        artist_primary: 'Artist A',
        karaoke_numbers: { tj: '2', ky: null, joysound: null },
      },
      {
        id: 'joy-2',
        title_primary: 'Solo',
        artist_primary: 'Artist B',
        karaoke_numbers: { tj: null, ky: null, joysound: '300' },
      },
    ];
    const { results } = auditCorpus(bOnly, fakeDeps);
    expect(results[0].tier).toBe('B');
    expect(results[0].candidates[0].artist_overlap_keys).toEqual([]);
  });

  it('tiers a song with no title match as C with zero candidates', () => {
    const cOnly = [
      {
        id: 'tj-3',
        title_primary: 'Nowhere',
        artist_primary: 'Ghost',
        karaoke_numbers: { tj: '3', ky: null, joysound: null },
      },
      {
        id: 'joy-3',
        title_primary: 'Different',
        artist_primary: 'Ghost',
        karaoke_numbers: { tj: null, ky: null, joysound: '400' },
      },
    ];
    const { results, summary } = auditCorpus(cOnly, fakeDeps);
    expect(results[0].tier).toBe('C');
    expect(results[0].candidates).toEqual([]);
    expect(summary.songsWithZeroCandidates).toBe(1);
  });

  it('does not match a KY-only song against itself and pools by joysound only', () => {
    // A KY-numbered song with no joysound is affected; it must not be its own
    // candidate even if another joysound row shares its title.
    const song = {
      id: 'blog-9',
      title_primary: 'Shared',
      artist_primary: 'X',
      karaoke_numbers: { tj: null, ky: '9', joysound: null },
    };
    const index = {
      exact: new Map([
        [
          'shared',
          [
            {
              id: 'blog-9',
              joysound: '',
              title: 'Shared',
              artist: 'X',
              artistKeys: new Set(['x']),
            },
          ],
        ],
      ]),
      stripped: new Map(),
    };
    expect(findCandidates(song, index, fakeDeps)).toEqual({
      tier: 'C',
      candidates: [],
      song_artist_ids: '',
      artist_id_match_any: false,
      artist_id_conflict_any: false,
    });
  });

  it('tiers on the FULL match set and keeps the overlap candidate when covers flood the slice', () => {
    // Regression for the sliced-tier bug: a zero-overlap exact-title flood must
    // not bury the sole artist-overlap (stripped-title) candidate. compareCandidates
    // ranks all exact-title above any stripped-title, so without full-set tiering +
    // a reserved slot this song would mis-tier B and drop its only merge target.
    const affected = {
      id: 'tj-flood',
      title_primary: 'Rocket Dive(AWOL OP)',
      artist_primary: 'hide',
      karaoke_numbers: { tj: '1', ky: null, joysound: null },
    };
    // Six unrelated covers whose EXACT title equals the affected exact key.
    const covers = Array.from({ length: 6 }, (_, i) => ({
      id: `joy-cover-${i}`,
      title_primary: 'Rocket Dive(AWOL OP)',
      artist_primary: `Cover Band ${i}`,
      karaoke_numbers: { tj: null, ky: null, joysound: `${100 + i}` },
    }));
    // The real target: matches only after decoration strip, and SHARES 'hide'
    // (the `&` split is what the fake splitArtistCollab keys on).
    const target = {
      id: 'joy-target',
      title_primary: 'Rocket Dive',
      artist_primary: 'hide & Spread Beaver',
      karaoke_numbers: { tj: null, ky: null, joysound: '200' },
    };
    const { results, summary } = auditCorpus([affected, ...covers, target], fakeDeps);
    const [row] = results;
    // Full-set tiering sees the overlap candidate -> A (not B from the slice).
    expect(row.tier).toBe('A');
    // The overlap target survived the slice via the reserved slot.
    const ids = row.candidates.map((c) => c.candidate_id);
    expect(ids).toContain('joy-target');
    expect(row.candidates).toHaveLength(5);
    const kept = row.candidates.find((c) => c.candidate_id === 'joy-target');
    expect(kept.match_kind).toBe('stripped-title');
    expect(kept.artist_overlap_keys).toContain('hide');
    expect(summary.byTier).toEqual({ A: 1, B: 0, C: 0 });
  });
});

describe('artistId signal (R4-4)', () => {
  // A tier-B case: same song, DIFFERENT artist surface strings (a rename), so
  // there is zero artist-key overlap — but both surfaces map to one JOYSOUND
  // artistId, which the signal must catch.
  const corpus = [
    {
      id: 'tj-r',
      title_primary: 'Home',
      artist_primary: 'New Name',
      karaoke_numbers: { tj: '1', ky: null, joysound: null },
    },
    {
      id: 'joysound-166186',
      title_primary: 'Home',
      artist_primary: 'Old Name',
      karaoke_numbers: { tj: null, ky: null, joysound: '100' },
    },
  ];
  // fakeDeps.normalizeForMatch = strip whitespace + lowercase.
  const artistIdIndex = {
    joysoundNumberToArtistId: new Map([['100', 'A1']]),
    artistNameToArtistIds: new Map([
      ['oldname', new Set(['A1'])],
      ['newname', new Set(['A1'])],
    ]),
  };

  it('flags a same-artistId rename (tier stays B, artist_id_match true)', () => {
    const { results, summary } = auditCorpus(corpus, fakeDeps, artistIdIndex);
    const [row] = results;
    expect(row.tier).toBe('B'); // surfaces differ -> no artist-key overlap
    expect(row.song_artist_ids).toBe('A1');
    expect(row.candidates[0].candidate_artist_id).toBe('A1');
    expect(row.candidates[0].artist_id_match).toBe('true');
    expect(summary.artistIdIndex.present).toBe(true);
    expect(summary.bTierWithArtistIdMatch).toBe(1);
    expect(summary.songsWithArtistIdMatch).toBe(1);
  });

  it('reports no match when the artistIds differ, and false (not empty) with an index present', () => {
    const differing = {
      joysoundNumberToArtistId: new Map([['100', 'DIFFERENT']]),
      artistNameToArtistIds: new Map([['newname', new Set(['A1'])]]),
    };
    const { results, summary } = auditCorpus(corpus, fakeDeps, differing);
    const [row] = results;
    expect(row.candidates[0].candidate_artist_id).toBe('DIFFERENT');
    expect(row.candidates[0].artist_id_match).toBe('false');
    expect(row.song_artist_ids).toBe('A1');
    expect(summary.bTierWithArtistIdMatch).toBe(0);
    // Both ids resolved and differ -> the tier-B "reject fast" set.
    expect(summary.songsWithArtistIdConflict).toBe(1);
    expect(summary.artistIdConflictByTier.B).toBe(1);
  });

  it('reserves a slot (and counts the match) when a >5-candidate flood would slice off a zero-overlap artistId match', () => {
    // Regression for the sliced-signal gap: a rename-shape match has zero
    // artist-key overlap, so it sorts last and — without a reserved slot — is
    // dropped by the top-5 slice, hiding it from the CSV and the summary count.
    const affected = {
      id: 'tj-flood2',
      title_primary: 'Solo(TV OP)',
      artist_primary: 'New Name',
      karaoke_numbers: { tj: '1', ky: null, joysound: null },
    };
    // Six exact-title covers by unrelated artists, none in the index.
    const covers = Array.from({ length: 6 }, (_, i) => ({
      id: `joy-cover-${i}`,
      title_primary: 'Solo(TV OP)',
      artist_primary: `Cover ${i}`,
      karaoke_numbers: { tj: null, ky: null, joysound: `${100 + i}` },
    }));
    // The rename target: matches only after decoration strip (stripped-title),
    // different surface (zero overlap), but its joysound# resolves to A1.
    const target = {
      id: 'joysound-t',
      title_primary: 'Solo',
      artist_primary: 'Old Name',
      karaoke_numbers: { tj: null, ky: null, joysound: '999' },
    };
    const idx = {
      joysoundNumberToArtistId: new Map([['999', 'A1']]),
      artistNameToArtistIds: new Map([
        ['newname', new Set(['A1'])],
        ['oldname', new Set(['A1'])],
      ]),
    };
    const { results, summary } = auditCorpus([affected, ...covers, target], fakeDeps, idx);
    const [row] = results;
    expect(row.tier).toBe('B'); // no artist-key overlap anywhere
    expect(row.candidates).toHaveLength(5);
    const kept = row.candidates.find((c) => c.candidate_id === 'joysound-t');
    expect(kept).toBeDefined();
    expect(kept.artist_id_match).toBe('true');
    // Counted on the FULL set, so the slice cannot hide it.
    expect(summary.songsWithArtistIdMatch).toBe(1);
    expect(summary.bTierWithArtistIdMatch).toBe(1);
  });

  it('leaves the columns blank (not false) when no index is supplied', () => {
    const { results, summary } = auditCorpus(corpus, fakeDeps);
    const [row] = results;
    expect(row.song_artist_ids).toBe('');
    expect(row.candidates[0].candidate_artist_id).toBe('');
    expect(row.candidates[0].artist_id_match).toBe('');
    expect(summary.artistIdIndex.present).toBe(false);
    expect(summary.bTierWithArtistIdMatch).toBe(0);
  });

  it('serialises the artistId columns into the CSV cells', () => {
    const { results } = auditCorpus(corpus, fakeDeps, artistIdIndex);
    const rows = buildCsvRows(results);
    // data row: candidate_artist_id, song_artist_ids, artist_id_match tail.
    expect(rows[1].slice(12)).toEqual(['A1', 'A1', 'true']);
  });
});

describe('buildCsvRows + csvEscape (fields with commas/quotes)', () => {
  it('serialises a candidate row and escapes commas and quotes on write', () => {
    const results = [
      {
        tier: 'B',
        song_id: 'tj-1',
        title_primary: 'A, "B"',
        artist_primary: 'X & Y',
        tj_number: '1',
        ky_number: '',
        candidates: [
          {
            candidate_id: 'joy-1',
            candidate_joysound_number: '100',
            candidate_title: 'Comma, title',
            candidate_artist: 'Quote "artist"',
            match_kind: 'exact-title',
            artist_overlap_keys: ['x', 'y'],
          },
        ],
      },
    ];
    const rows = buildCsvRows(results);
    expect(rows[0]).toEqual([
      'tier',
      'song_id',
      'title_primary',
      'artist_primary',
      'tj_number',
      'ky_number',
      'candidate_id',
      'candidate_joysound_number',
      'candidate_title',
      'candidate_artist',
      'match_kind',
      'artist_overlap_keys',
      'candidate_artist_id',
      'song_artist_ids',
      'artist_id_match',
    ]);
    // overlap keys are space-joined in the cell.
    expect(rows[1][11]).toBe('x y');
    // Without an artistId index, the three R4-4 columns are emitted empty.
    expect(rows[1].slice(12)).toEqual(['', '', '']);
    // The serialised line must quote the comma/quote-bearing fields.
    const line = rows[1].map(csvEscape).join(',');
    expect(line).toContain('"A, ""B"""');
    expect(line).toContain('"Comma, title"');
    expect(line).toContain('"Quote ""artist"""');
  });

  it('emits one row with empty candidate columns for a zero-candidate song', () => {
    const rows = buildCsvRows([
      {
        tier: 'C',
        song_id: 'tj-9',
        title_primary: 'Gap',
        artist_primary: 'Solo',
        tj_number: '9',
        ky_number: '',
        candidates: [],
      },
    ]);
    // header + exactly one data row of 15 columns, trailing 9 empty.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      'C',
      'tj-9',
      'Gap',
      'Solo',
      '9',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
  });
});

describe('parseArgs', () => {
  it('takes a positional corpus path and optional --out', () => {
    expect(parseArgs(['corpus.json', '--out', 'dir'])).toEqual({
      corpusPath: 'corpus.json',
      outDir: 'dir',
      artistIdIndexPath: null,
      help: false,
    });
  });

  it('accepts --artist-id-index', () => {
    expect(parseArgs(['corpus.json', '--artist-id-index', 'idx.json'])).toEqual({
      corpusPath: 'corpus.json',
      outDir: null,
      artistIdIndexPath: 'idx.json',
      help: false,
    });
  });

  it('requires a corpus path', () => {
    expect(() => parseArgs([])).toThrow(/corpus JSON path is required/);
  });

  it('rejects unknown flags and extra positionals', () => {
    expect(() => parseArgs(['a.json', '--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/unexpected extra argument/);
    expect(() => parseArgs(['a.json', '--artist-id-index'])).toThrow(
      /--artist-id-index requires a file value/,
    );
  });
});
