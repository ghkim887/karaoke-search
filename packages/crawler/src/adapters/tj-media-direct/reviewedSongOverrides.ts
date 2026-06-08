/**
 * Reviewed TJ song-level overrides from the 2026-06 FP/FN audit.
 *
 * These lists are intentionally keyed by TJ number, not artist. They encode
 * Gyunho's policy decision that K-pop/Korean-artist Japanese releases may be
 * admitted only at the specific song/TJ-number level, while reviewed generic
 * non-scope rows should stay out even if a weak artist/rescue signal appears.
 *
 * Source artifact: .tmp_review/tj-db-audit/review-queues/tj-fp-fn-action-plan.tsv
 * Counts: allow=105, drop=9.
 */

const REVIEWED_TJ_SONG_ALLOW_NUMBERS = [
  '26223',
  '26252',
  '26375',
  '26457',
  '26544',
  '26583',
  '26685',
  '26691',
  '26709',
  '26762',
  '26792',
  '26822',
  '26828',
  '26830',
  '26871',
  '26872',
  '26874',
  '26893',
  '26894',
  '26909',
  '26922',
  '26934',
  '26945',
  '26949',
  '26951',
  '26971',
  '27025',
  '27036',
  '27056',
  '27069',
  '27088',
  '27089',
  '27117',
  '27131',
  '27133',
  '27143',
  '27149',
  '27150',
  '27165',
  '27172',
  '27176',
  '27197',
  '27199',
  '27200',
  '27204',
  '27209',
  '27222',
  '27241',
  '27254',
  '27280',
  '27297',
  '27333',
  '27355',
  '27364',
  '27373',
  '27378',
  '27414',
  '27454',
  '27612',
  '27628',
  '27662',
  '27707',
  '27739',
  '28593',
  '28752',
  '28779',
  '28799',
  '28831',
  '28850',
  '28851',
  '28916',
  '28965',
  '28980',
  '52521',
  '52522',
  '52524',
  '52525',
  '52714',
  '52814',
  '52887',
  '52910',
  '52911',
  '52913',
  '52914',
  '52917',
  '52930',
  '68013',
  '68038',
  '68041',
  '68048',
  '68102',
  '68227',
  '68268',
  '68289',
  '68306',
  '68389',
  '68401',
  '68457',
  '68547',
  '68554',
  '68595',
  '68629',
  '68856',
  '68960',
  '68976',
] as const;

const REVIEWED_TJ_SONG_DROP_NUMBERS = [
  '7055',
  '7069',
  '20932',
  '23113',
  '23114',
  '53553',
  '54924',
  '67370',
  '97686',
] as const;

const REVIEWED_TJ_SONG_ALLOW = new Set<string>(REVIEWED_TJ_SONG_ALLOW_NUMBERS);
const REVIEWED_TJ_SONG_DROP = new Set<string>(REVIEWED_TJ_SONG_DROP_NUMBERS);

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
