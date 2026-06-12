/**
 * One song row scraped from the JOYSOUND new-release listing page
 * `https://www.joysound.com/web/karaoke/contents/new?page=N`.
 *
 * Fields mirror the public-site React/RSC payload's `naviGroup` shape:
 * required `naviGroupId` + `selSongNo` + `songName` + `artistName`, plus
 * optional `artistId` / `tieupInfo` / `tieupId` (rendered as `$undefined` in
 * the RSC text when absent — the parser normalizes those to `null`).
 */
export interface JoysoundListItem {
  naviGroupId: string;
  selSongNo: string;
  songName: string;
  artistName: string;
  artistId: string | null;
  tieupInfo: string | null;
  tieupId: string | null;
}

/**
 * One song's detail response from
 * `https://www.joysound.com/apis/v1/ise/fetchContentsDetail?kind=naviGroupId&id=<naviGroupId>`.
 *
 * Only fields the classifier or normalizer reads are typed; the API returns
 * additional fields that are intentionally dropped during parsing to keep the
 * downstream surface area small.
 */
export interface JoysoundDetail {
  naviGroupId: string;
  songId: string | null;
  selSongNo: string;
  songName: string;
  songNameRuby: string | null;
  /**
   * Foreign-language rendering of the song title, surfaced by the detail API
   * ONLY for non-Japanese catalog entries (EMPTY for genuine Japanese songs).
   * An authoritative foreign-language signal — see `foreignNameSignal` in
   * `classifier.ts`. `undefined` when absent/empty.
   */
  songNameForeign?: string;
  /**
   * Romanized search rendering of the song title (top-level
   * `songNameForeignSearch`), surfaced ONLY for non-Japanese catalog entries.
   * For Chinese entries this is dotted pinyin (e.g. `wu.lai.`); the
   * `foreignNameSignal` gate treats a dotted-pinyin value as a corroborating
   * CHINESE tell. `undefined` when absent/empty.
   */
  songNameForeignSearch?: string;
  artistName: string | null;
  /**
   * Foreign-language rendering of the artist name (from `artistInfo`), surfaced
   * ONLY for non-Japanese catalog entries (EMPTY for genuine Japanese songs).
   * Authoritative foreign-language signal — see `foreignNameSignal`. `undefined`
   * when absent/empty.
   */
  artistNameForeign?: string;
  /**
   * Romanized search rendering of the artist name (from `artistInfo`, top-level
   * honored as a fallback), surfaced ONLY for non-Japanese catalog entries. For
   * Chinese entries this is dotted pinyin (e.g. `zhang.xue.you.`); a
   * dotted-pinyin value is a corroborating CHINESE tell in `foreignNameSignal`.
   * `undefined` when absent/empty.
   */
  artistNameForeignSearch?: string;
  artistId: string | null;
  lyricist: string | null;
  composer: string | null;
  relDate: string | null;
  newFlg: string | null;
  lyricIntro: string | null;
  /** Flattened from `genreList[*].genreName`. */
  genreNames: string[];
  /** Flattened from `tieupList[*].tieupName`. */
  tieupNames: string[];
  /** Flattened from `aplList[*].selectionList[*].ServicePublishDate`. */
  aplServicePublishDates: string[];
}
