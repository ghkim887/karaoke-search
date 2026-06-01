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
  artistName: string | null;
  artistId: string | null;
  lyricist: string | null;
  composer: string | null;
  relDate: string | null;
  newFlg: string | null;
  lyricIntro: string | null;
  /** Flattened from `genreList[*].name`. */
  genreNames: string[];
  /** Flattened from `tieupList[*].name`. */
  tieupNames: string[];
  /** Flattened from `aplList[*].selectionServicePublishDate`. */
  aplServicePublishDates: string[];
}
