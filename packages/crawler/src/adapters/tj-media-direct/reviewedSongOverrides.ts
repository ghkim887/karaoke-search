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
 * Counts: allow=112, drop=9 (asserted by
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
    decidedOn: '2026-06',
    note: 'add_song_level_kpop_or_korean_artist_official_jpn_row',
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
];

const REVIEWED_TJ_SONG_ALLOW = new Set<string>(
  REVIEWED_TJ_SONG_ALLOW_LIST.map((entry) => entry.tj),
);
const REVIEWED_TJ_SONG_DROP = new Set<string>(REVIEWED_TJ_SONG_DROP_LIST.map((entry) => entry.tj));

export function isReviewedTjSongAllow(tj: string): boolean {
  return REVIEWED_TJ_SONG_ALLOW.has(normalizeTjNumberKey(tj));
}

export function isReviewedTjSongDrop(tj: string): boolean {
  return REVIEWED_TJ_SONG_DROP.has(normalizeTjNumberKey(tj));
}

function normalizeTjNumberKey(tj: string): string {
  const trimmed = tj.trim();
  if (trimmed === '') return '';
  return trimmed.replace(/^0+/, '') || '0';
}
