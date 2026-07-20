/**
 * Reviewed TJ song-level overrides from the 2026-06 FP/FN audit.
 *
 * These lists are intentionally keyed by TJ number, not artist. They encode
 * Gyunho's policy decision that K-pop/Korean-artist Japanese releases may be
 * admitted only at the specific song/TJ-number level, while reviewed generic
 * non-scope rows should stay out even if a weak artist/rescue signal appears.
 *
 * Provenance lives in the entries themselves: each entry carries the
 * title/artist as recorded at audit time, the decision month, and the audit
 * action slug in `note`. The original audit artifact was
 * `.tmp_review/tj-db-audit/review-queues/tj-fp-fn-action-plan.tsv` (plus the
 * `*-proposed-verdicts.tsv` queue files) — an UNTRACKED temp directory; the
 * name is kept here for history only, the TSVs are no longer needed to
 * interpret or maintain this file.
 *
 * Maintenance policy (mirrors `koreanArtistDropList.ts`):
 *   - **Add an entry** only from a hand-audited, song-level decision. Record
 *     the catalog title/artist verbatim and set `decidedOn` to the decision
 *     month (`YYYY-MM`, UTC).
 *   - **Never** widen an entry to an artist-level admit — that is what the
 *     drop list / artist-tag steps are for.
 *
 * Counts: allow=113, drop=21 (asserted by
 * `test/adapters/tj-media-direct/reviewedSongOverrides.test.ts`).
 */

/** Single reviewed-override entry — one hand-audited TJ catalog row. */
export interface ReviewedSongOverrideEntry {
  /** TJ number, leading-zero-normalized (the same key shape `normalizeTjNumberKey` produces). */
  tj: string;
  /** Catalog title as recorded in the 2026-06 audit artifact. */
  title: string;
  /** Catalog artist as recorded in the 2026-06 audit artifact. */
  artist: string;
  /** Decision month (`YYYY-MM`, UTC) — when the reviewer verdict was recorded. */
  decidedOn: string;
  /**
   * Optional display-rendering override for an *admitted* row (allow-list only).
   * When present, the TJ-direct parser stamps `artist_primary` / `artist_ko`
   * from this instead of the raw `indexSong`.
   *
   * Needed when the catalog artist string carries a Hangul gloss (e.g.
   * `IVE(아이브)`) that would trip the product-corpus leak gate
   * (`test/product-corpus-regression.test.ts`) — a genuine JP release must not
   * read as Korean-script leakage. This is a per-song rendering, NOT a broad
   * paren-splitting rule: Latin-only catalog rows (e.g. BOYNEXTDOOR tj-52990)
   * already render clean and carry no `render`.
   */
  render?: { artist_primary: string; artist_ko: string | null };
  /** Audit action slug (+ short rationale for verdict-queue edge cases). */
  note?: string;
}

export const REVIEWED_TJ_SONG_ALLOW_LIST: readonly ReviewedSongOverrideEntry[] = [
  {
    tj: '26223',
    title: 'Sky',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26252',
    title: 'miss you',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26375',
    title: 'Step by Step',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26457',
    title: 'Choosey Lover',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26544',
    title: '明日は来るから(ワンピース 17th ED)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26583',
    title: 'My Destiny',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26685',
    title: 'LAST ANGEL',
    artist: '倖田來未(Feat.東方神起)',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26691',
    title: 'Forever Love',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26709',
    title: 'Together(シナモン 主題歌)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26762',
    title: 'Beautiful you',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26792',
    title: 'どうして君を好きに なってしまったんだろう？',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26822',
    title: '呪文-MIROTIC-',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26828',
    title: 'Number 1',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26830',
    title: 'Rainy Night',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26871',
    title: '忘れないで',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26872',
    title: 'Bolero',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26874',
    title: 'Kiss The Baby Sky',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26893',
    title: 'Survivor',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26894',
    title: 'Take Your Hands',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26909',
    title: 'Share The World',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26922',
    title: 'ウィーアー!(ワンピース OP)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '26934',
    title: 'My Heaven',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26945',
    title: 'Stand by U',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26949',
    title: 'ガラガラGO!!',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26951',
    title: 'Emotion',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '26971',
    title: 'Bringing You Love',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27013',
    title: 'Fall in Love',
    artist: '青山テルマ×SOL From Big Bang',
    decidedOn: '2026-06',
    note: 'collab_keep — Lead artist is Japanese Aoyama Thelma; web lyric/source evidence identifies Fall in Love as 青山テルマ×SOL from BIGBANG. Korean collaborator should not trigger drop.',
  },
  {
    tj: '27025',
    title: 'With All My Heart  ~君が踊る, 夏~',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27033',
    title: "Rain is Fallin'",
    artist: 'w-inds.×G-DRAGON(BIG BANG)',
    decidedOn: '2026-06',
    note: 'collab_keep — Lead act w-inds. is Japanese with G-DRAGON collaboration; treat known-Korean-act hit as collaborator-only edge, not false positive.',
  },
  {
    tj: '27036',
    title: '声をきかせて',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27056',
    title: 'Flower Rock',
    artist: 'FT Island',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27069',
    title: 'Tell Me Goodbye',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27088',
    title: 'GENIE',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27089',
    title: 'Beautiful Hangover',
    artist: 'Big Bang',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27117',
    title: 'ミスター',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27131',
    title: 'Gee',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27133',
    title: 'ジャンピン',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27143',
    title: 'Break Out!',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27149',
    title: 'RUN DEVIL RUN',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27150',
    title: 'Why? (Keep Your Head Down)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27165',
    title: '時ヲ止メテ',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27172',
    title: 'ジェットコースターラブ',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27176',
    title: 'Mr.Taxi',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27197',
    title: '美人(BONAMANA)',
    artist: 'SUPER JUNIOR',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27199',
    title: 'GO GO サマー!',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27200',
    title: 'Replay -君は僕のeverything-',
    artist: 'SHINee',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27204',
    title: 'HOOT',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27209',
    title: 'Superstar',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27222',
    title: 'The Great Escape',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27241',
    title: 'ウィンターマジック',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27254',
    title: 'Winter Rose',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27280',
    title: 'The Boys',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27297',
    title: 'ガールズパワー',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27333',
    title: 'Paparazzi',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27355',
    title: 'Oh!(Japanese Ver.)',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '27364',
    title: 'エレクトリックボーイ',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27373',
    title: 'Flower Power',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27378',
    title: '1000年, ずっとそばにいて...',
    artist: 'SHINee',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27414',
    title: 'Catch Me -If You Wanna-',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27454',
    title: 'サンキューサマーラブ',
    artist: 'KARA',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27612',
    title: 'My Oh My',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27628',
    title: 'Sweat',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27662',
    title: 'Time Works Wonders',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27707',
    title: 'サクラミチ(花嫁のれん OST)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '27739',
    title: 'Begin(ごめん、愛してる ED)',
    artist: '東方神起',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28593',
    title: 'GALAXY SUPERNOVA',
    artist: '少女時代',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28752',
    title: 'Spring Day(春の日)',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28779',
    title: 'DNA(Japanese Ver.)',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '28799',
    title: 'MIC DROP(Japanese Ver.)',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '28831',
    title: "Don't Leave Me(ドラマ'シグナル 長期未解決事件捜査班' OST)",
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '28850',
    title: 'Horololo',
    artist: 'EXO-CBX',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28851',
    title: '血、汗、涙',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28916',
    title: 'FAKE LOVE(Japanese Ver.)',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '28965',
    title: '好きと言わせたい',
    artist: 'IZ*ONE',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '28980',
    title: 'SAPPY',
    artist: 'Red Velvet',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '44601',
    title: 'Better Half',
    artist: '정한(Feat.Omoinotake)',
    decidedOn: '2026-06',
    note: 'metadata_fix_keep_song_level_kpop_japanese_release — Policy resolved by Gyunho: keep only this record-level Japanese-release/collab row; do not admit JEONGHAN/K-pop catalog from artist cache alone. Metadata fix recommended: normalize artist lead to Omoinotake feat. JEONGHAN while preserving TJ number/title.',
  },
  {
    tj: '52521',
    title: '開幕宣言',
    artist: 'Novelbright',
    decidedOn: '2026-06',
    note: 'add_tj_number_to_existing_same_song',
  },
  {
    tj: '52522',
    title: '踊',
    artist: 'Ado',
    decidedOn: '2026-06',
    note: 'add_tj_number_to_existing_same_song',
  },
  {
    tj: '52524',
    title: '今更だって僕は言うかな',
    artist: 'Saucy Dog',
    decidedOn: '2026-06',
    note: 'add_tj_number_to_existing_same_song',
  },
  {
    tj: '52525',
    title: 'カリスマックス',
    artist: 'Snow Man',
    decidedOn: '2026-06',
    note: 'add_missing_japanese_artist_tj_song',
  },
  {
    tj: '52714',
    title: 'Hands Up',
    artist: 'NCT WISH',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '52814',
    title: 'ジュエリー',
    artist: 'LE SSERAFIM(Prod.imase)',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '52887',
    title: "消費期限(ドラマ '未来の私にブッかまされる!?' OST)",
    artist: 'SEVENTEEN',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '52910',
    title: 'Hollow',
    artist: 'Stray Kids',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '52911',
    title: 'DIFFERENT',
    artist: 'LE SSERAFIM',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '52913',
    title: "Kawaii(Netflixシリーズ 'My Melody & Kuromi' OST)",
    artist: 'LE SSERAFIM(Prod.Gen Hoshino)',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '52914',
    title: 'かくれんぼ',
    artist: 'PLAVE',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '52917',
    title: "DARE ME(ドラマ 'ダメマネ! ―ダメなタレント、マネジメントします ―' OP)",
    artist: 'IVE',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '52925',
    title: "Step by Step(フジテレビ 'めざましどようび' テーマソング)",
    artist: 'TOMORROW X TOGETHER',
    decidedOn: '2026-06',
    note: 'keep_song_level_kpop_japanese_release — Policy resolved by Gyunho: keep this specific Japanese/tie-up release by TXT, but do not admit the broader TXT/K-pop catalog from artist identity alone.',
  },
  {
    tj: '52930',
    title: "Shine On Me(ドラマ '海老だって鯛が釣りたい' OST)",
    artist: 'ENHYPEN',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '52990',
    title: 'Count To Love',
    artist: 'BOYNEXTDOOR',
    decidedOn: '2026-07',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row — BOYNEXTDOOR 2nd JP maxi single "BOYLIFE" lead track (released 2025-08-18, #1 Billboard Japan Hot 100). BOYNEXTDOOR is on koreanArtistDropList; admit this exact JP release at the TJ-number level only, not the artist catalog. proEnrichment nationalcode JPN.',
  },
  {
    tj: '68013',
    title: 'Shake',
    artist: 'EXO-CBX',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68038',
    title: 'Let Go',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68041',
    title: 'Buenos Aires',
    artist: 'IZ*ONE',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68048',
    title: 'Lights',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68102',
    title: 'Boy With Luv(Japanese Ver.)',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '68227',
    title: "舞い落ちる花びら (Fallin' Flower)",
    artist: 'SEVENTEEN',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '68268',
    title: 'Stay Gold',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68289',
    title: 'Your eyes tell',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68306',
    title: 'Beware',
    artist: 'IZ*ONE',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68389',
    title: "Film out(映画'シグナル 長期未解決事件捜査班' OST)",
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '68401',
    title: 'ひとりじゃない',
    artist: 'SEVENTEEN',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68457',
    title: "Forget Me Not(アニメ 'RE-MAIN' OST)",
    artist: 'ENHYPEN',
    decidedOn: '2026-06',
    note: 'add_song_level_japanese_tieup_or_japanese_version_row',
  },
  {
    tj: '68531',
    title: 'Ito',
    artist: 'TOMORROW X TOGETHER',
    decidedOn: '2026-06',
    note: 'keep_song_level_kpop_japanese_release — Policy resolved by Gyunho: keep this specific Japanese drama/tie-up release by TXT, but do not admit the broader TXT/K-pop catalog from artist identity alone.',
  },
  {
    tj: '68547',
    title: 'Crystal Snow',
    artist: '防弾少年団',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68554',
    title: 'あいのちから',
    artist: 'SEVENTEEN',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68595',
    title: 'WILDSIDE',
    artist: 'Red Velvet',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68629',
    title: 'Your Eyes',
    artist: 'Stray Kids',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68630',
    title: '永遠に光れ (Everlasting Shine)',
    artist: 'TOMORROW X TOGETHER',
    decidedOn: '2026-06',
    note: 'keep_song_level_kpop_anime_release — Policy resolved by Gyunho: keep this specific Japanese/anime release by TXT, but do not admit the broader TXT/K-pop catalog from artist identity alone.',
  },
  {
    tj: '68804',
    title: "Here I Stand(映画 'ブラッククローバー 魔法帝の剣' OST)",
    artist: 'TREASURE',
    decidedOn: '2026-06',
    note: 'keep_song_level_kpop_anime_release — Policy resolved by Gyunho: keep this specific Japanese/anime movie theme by TREASURE, but do not admit the broader TREASURE/K-pop catalog from artist identity alone.',
  },
  {
    tj: '68856',
    title: '今 -明日 世界が終わっても-',
    artist: 'SEVENTEEN',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68960',
    title: 'Paper Cuts',
    artist: 'EXO-CBX',
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
  },
  {
    tj: '68976',
    title: 'Will',
    artist: 'IVE(아이브)',
    decidedOn: '2026-07',
    render: { artist_primary: 'IVE', artist_ko: '아이브' },
    // TJ 68976 "Will" = IVE Japanese-language original (Pokémon Horizons OP,
    // 2024-04-12; JP EP "Alive", Starship/Ariola Japan) — genuine JP-market
    // release, JPN tag correct. ALLOW. Re-confirmed in the 2026-07-11
    // weekly-crawl leak-gate round: the catalog artist "IVE(아이브)" carries a
    // Hangul gloss, so the crawl-rendered artist_primary tripped
    // product-corpus-regression's TJ-direct Hangul/no-Japanese guard even
    // though the row is allowed. `render` stamps artist_primary="IVE" /
    // artist_ko="아이브" so the admitted row is script-clean at the next crawl
    // (precedent tj-52990 BOYNEXTDOOR needed no render — TJ raw was Latin-only).
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row — IVE JP original "Will" (Pokémon Horizons OP, JP EP "Alive", Starship/Ariola Japan). proEnrichment nationalcode JPN. `render` strips the Hangul gloss from "IVE(아이브)" so the allow survives the leak gate.',
  },
];

export const REVIEWED_TJ_SONG_DROP_LIST: readonly ReviewedSongOverrideEntry[] = [
  {
    tj: '7055',
    title: 'Besame Mucho',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '7069',
    title: 'Do Re Mi(Sound Of Music OST)',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '20932',
    title: 'Voices That Care',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '23113',
    title: 'This Is Me(The Greatest Showman OST)',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '23114',
    title: 'The Greatest Show(The Greatest Showman OST)',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '53553',
    title: 'IMJMWDP',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '54924',
    title: '119 REMIX',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '67370',
    title: 'Handog Ng Pilipino Sa Mundo',
    artist: 'Various Artists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '97686',
    title: 'Night Vibe(Remake)',
    artist: 'VariousArtists',
    decidedOn: '2026-06',
    note: 'drop_generic_non_scope_row',
  },
  {
    tj: '70438',
    title: '프리큐큐',
    artist: 'CUTIE STREET',
    decidedOn: '2026-07',
    // TJ 70438 "프리큐큐" = Korean-language ver. of CUTIE STREET's JP single
    // ぷりきゅきゅ (released 2026-06-06 for KR market: Music Bank, KR charts).
    // Group is Japanese but this KOR-tagged Korean-language row is TJ's Korean
    // catalog, not J-pop. DROP. Per-song only: CUTIE STREET (ASOBISYSTEM /
    // KAWAII LAB.) is a Japanese act whose artist tag would admit it at
    // jpn-admit-artist (step 5), so this hard-drop (step 0, keyed by exact TJ
    // number) is the seam — the artist stays admittable for their Japanese
    // rows, so it MUST NOT go on koreanArtistDropList.
    note: 'drop_per_song_korean_language_row — KOR-language ver. of CUTIE STREET (JP group) single ぷりきゅきゅ, 2026-06-06 KR release; TJ nationalcode KOR. Korean-catalog row, not J-pop. Artist stays admittable — do NOT add to koreanArtistDropList.',
  },
  // ---------------------------------------------------------------------------
  // 2026-07-20 K-pop / Western-pop leak triage (joyless-576 → 44-song parallel
  // web review → DROP 12/KEEP 32). These are per-SONG drops keyed by exact TJ
  // number. Two classes, both requiring the exact-TJ seam rather than an artist
  // drop-list entry (which would over-reject a legitimate Japanese homonym):
  //   - Western pop mis-shelved on TJ whose credited artist is either not a
  //     drop-list signal (Mary McGregor) or COLLIDES with a Japanese act of the
  //     same name (US "MAX" = Max Schneider vs JP girl-group MAX; "LiSA/LISA" =
  //     BLACKPINK Lisa vs JP anison singer LiSA). Adding the name to
  //     koreanArtistDropList would drop the Japanese homonym's real J-pop rows,
  //     so we drop only these specific TJ numbers.
  //   - Korean-language catalog rows by a Japanese act (CUTIE STREET), same
  //     class as tj-70438 above — artist stays admittable for their JP rows.
  // Sibling rows deliberately KEPT (proof the drop is song-level, not artist):
  // tj 26278 SAYONARA (Mary McGregor, 銀河鉄道999 ED — JP tie-up) and CUTIE
  // STREET's JP original tj 52410 ("かわいいだけじゃだめですか?").
  {
    tj: '21873',
    title: 'This Girl Has Turned Into A Woman',
    artist: 'Mary McGregor',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — 1976 US pop (album "Torn Between Two Lovers"), no JP release/tie-up. Song-level only: the same artist\'s tj 26278 "SAYONARA(銀河鉄道999劇場版 ED)" is a JP anime tie-up and stays. Do NOT add Mary McGregor to any artist drop list.',
  },
  {
    tj: '7653',
    title: 'Torn between two lovers',
    artist: 'Mary McGregor',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — Mary MacGregor 1976 US pop (Billboard #1), no JP release/tie-up. Song-level only (see tj 26278 SAYONARA KEEP).',
  },
  {
    tj: '23450',
    title: 'Acid Dreams',
    artist: 'MAX,Felly',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — US pop singer MAX (Max Schneider) 2019 release feat. Felly. Homonym collision with JP girl-group MAX — drop this TJ only, do NOT drop-list "MAX".',
  },
  {
    tj: '23502',
    title: 'Checklist',
    artist: 'MAX(Feat.Chromeo)',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — US pop singer MAX 2019-11-01 single feat. Chromeo (Arista). Homonym collision with JP MAX — TJ-number drop only.',
  },
  {
    tj: '79222',
    title: 'Lights Down Low',
    artist: 'MAX(Feat.Gnash)',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — US singer Max Schneider 2016 single feat. gnash. Homonym collision with JP MAX — TJ-number drop only.',
  },
  {
    tj: '79627',
    title: 'Rockstar',
    artist: 'LiSA',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — BLACKPINK Lisa 2024-06-27 English global single ROCKSTAR, mis-tagged as "LiSA". Homonym collision with JP anison singer LiSA — drop this TJ only, do NOT drop-list "LiSA".',
  },
  {
    tj: '79697',
    title: 'New Woman',
    artist: 'LISA(Feat.ROSALIA)',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — BLACKPINK Lisa feat. Rosalía 2024-08-15 English single (RCA), not a JP release. Homonym collision with JP LiSA — TJ-number drop only.',
  },
  {
    tj: '79756',
    title: 'Moonlit Floor',
    artist: 'LiSA',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — BLACKPINK Lisa 2024-10-03 English single "Moonlit Floor (Kiss Me)". Homonym collision with JP LiSA — TJ-number drop only.',
  },
  {
    tj: '79914',
    title: 'Born Again',
    artist: 'LISA(Feat.Doja Cat,RAYE)',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — BLACKPINK Lisa feat. Doja Cat/RAYE 2025-02-06 English single (RCA), no JP release. Homonym collision with JP LiSA — TJ-number drop only.',
  },
  {
    tj: '79973',
    title: 'FXCK UP THE WORLD',
    artist: 'LISA(Feat.Future)',
    decidedOn: '2026-07',
    note: 'drop_per_song_western_pop_leak — BLACKPINK Lisa feat. Future 2025-02-28 English single (Alter Ego), no JP release. Homonym collision with JP LiSA — TJ-number drop only.',
  },
  {
    tj: '52093',
    title: '귀엽기만 하면 안 되나요?',
    artist: 'CUTIE STREET',
    decidedOn: '2026-07',
    note: 'drop_per_song_korean_language_row — KOR-language ver. of CUTIE STREET (JP group) "かわいいだけじゃだめですか?"; Korean-catalog row (tj 52093 / ky 51322, no JOYSOUND). Same class as tj-70438. JP original tj 52410 (ky 57750 / joy 630523) and the JOYSOUND-hosted "(Korean ver.)" joy 648842 both stay in scope. Artist stays admittable — do NOT add CUTIE STREET to koreanArtistDropList. KY-side claim ky 51322 is dropped via reviewedKySongOverrides.',
  },
];

// Store normalized keys so lookups (which probe with `normalizeTjNumberKey`)
// always match, even for a future leading-zero/whitespace entry.
const REVIEWED_TJ_SONG_ALLOW = new Set<string>(
  REVIEWED_TJ_SONG_ALLOW_LIST.map((entry) => normalizeTjNumberKey(entry.tj)),
);
const REVIEWED_TJ_SONG_DROP = new Set<string>(
  REVIEWED_TJ_SONG_DROP_LIST.map((entry) => normalizeTjNumberKey(entry.tj)),
);

// Only allow-list entries that opt into a `render` override are materialized
// here (keyed the same normalized shape lookups probe with). The parser
// consults this when building an admitted record so a Hangul-glossed catalog
// artist can be stamped as its script-clean display form.
const REVIEWED_TJ_SONG_RENDER = new Map<
  string,
  { artist_primary: string; artist_ko: string | null }
>(
  REVIEWED_TJ_SONG_ALLOW_LIST.flatMap((entry) =>
    entry.render ? [[normalizeTjNumberKey(entry.tj), entry.render] as const] : [],
  ),
);

export function isReviewedTjSongAllow(tj: string): boolean {
  return REVIEWED_TJ_SONG_ALLOW.has(normalizeTjNumberKey(tj));
}

export function isReviewedTjSongDrop(tj: string): boolean {
  return REVIEWED_TJ_SONG_DROP.has(normalizeTjNumberKey(tj));
}

/**
 * Per-song display-rendering override for an admitted TJ row, or `undefined`
 * when the row has no override (the common case — the parser then keeps the raw
 * `indexSong`). See {@link ReviewedSongOverrideEntry.render}.
 */
export function reviewedTjSongRender(
  tj: string,
): { artist_primary: string; artist_ko: string | null } | undefined {
  return REVIEWED_TJ_SONG_RENDER.get(normalizeTjNumberKey(tj));
}

function normalizeTjNumberKey(tj: string): string {
  const trimmed = tj.trim();
  if (trimmed === '') return '';
  return trimmed.replace(/^0+/, '') || '0';
}
