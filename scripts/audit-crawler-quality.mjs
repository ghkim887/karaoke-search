#!/usr/bin/env node
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const RE_KANA = /[\u3040-\u30ff]/;
const RE_HANGUL = /[\uac00-\ud7af]/;
const RE_HAN = /[\u3400-\u9fff]/;
const BLOG_HOST = 'j-pop-playlist.tistory.com';

function textOf(song) {
  return [song.title_primary, song.title_ko, song.artist_primary, song.artist_ko]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function sourceOf(song) {
  return typeof song.id === 'string' ? song.id.split('-')[0] : '(missing)';
}

function addCount(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function hasBlogOrigin(song) {
  return (
    (typeof song.id === 'string' && song.id.startsWith('blog-')) ||
    (typeof song.source_url === 'string' && song.source_url.includes(BLOG_HOST))
  );
}

function hasTjNumber(song) {
  return typeof song.karaoke_numbers?.tj === 'string' && song.karaoke_numbers.tj !== '';
}

function sample(records, limit = 20) {
  return records.slice(0, limit).map((song) => ({
    id: song.id,
    source_url: song.source_url,
    title_primary: song.title_primary,
    artist_primary: song.artist_primary,
    tj: song.karaoke_numbers?.tj ?? null,
  }));
}

async function main() {
  const songsPath = process.argv[2] ?? 'apps/web/public/data/songs.json';
  const outPath = process.argv[3] ?? '';

  const songs = loadCorpus(songsPath);
  if (!Array.isArray(songs)) {
    throw new Error(`${songsPath} must contain a JSON array`);
  }

  const source = {};
  const rescueWhitelistCandidateSource = {};
  const rescueWhitelistCandidates = [];
  const suspicious = {
    hangulNoKana: [],
    hanNoKanaNoHangul: [],
    tjGenericArtistHangulTitleNoKana: [],
    nonBlogOriginWithTj: [],
  };

  for (const song of songs) {
    const sourceKey = sourceOf(song);
    const text = textOf(song);
    addCount(source, sourceKey);

    if (hasTjNumber(song)) {
      addCount(rescueWhitelistCandidateSource, sourceKey);
      if (hasBlogOrigin(song)) rescueWhitelistCandidates.push(song);
      else suspicious.nonBlogOriginWithTj.push(song);
    }

    if (RE_HANGUL.test(text) && !RE_KANA.test(text)) suspicious.hangulNoKana.push(song);
    if (RE_HAN.test(text) && !RE_KANA.test(text) && !RE_HANGUL.test(text)) {
      suspicious.hanNoKanaNoHangul.push(song);
    }
    if (
      typeof song.id === 'string' &&
      song.id.startsWith('tj-') &&
      RE_HANGUL.test(song.title_primary ?? '') &&
      !RE_KANA.test(text) &&
      /^(Various Artists|Various|Unknown)$/i.test(song.artist_primary ?? '')
    ) {
      suspicious.tjGenericArtistHangulTitleNoKana.push(song);
    }
  }

  const report = {
    songsPath,
    total: songs.length,
    source,
    scriptSignals: {
      kanaAny: songs.filter((song) => RE_KANA.test(textOf(song))).length,
      hangulNoKana: suspicious.hangulNoKana.length,
      hanNoKanaNoHangul: suspicious.hanNoKanaNoHangul.length,
    },
    rescueWhitelistCandidateSource,
    rescueWhitelistBlogOriginCount: rescueWhitelistCandidates.length,
    rescueWhitelistNonBlogOriginCount: suspicious.nonBlogOriginWithTj.length,
    suspiciousCounts: {
      hangulNoKana: suspicious.hangulNoKana.length,
      hanNoKanaNoHangul: suspicious.hanNoKanaNoHangul.length,
      tjGenericArtistHangulTitleNoKana: suspicious.tjGenericArtistHangulTitleNoKana.length,
      nonBlogOriginWithTj: suspicious.nonBlogOriginWithTj.length,
    },
    samples: {
      hanNoKanaNoHangul: sample(suspicious.hanNoKanaNoHangul),
      tjGenericArtistHangulTitleNoKana: sample(suspicious.tjGenericArtistHangulTitleNoKana),
      nonBlogOriginWithTj: sample(suspicious.nonBlogOriginWithTj),
    },
  };

  const json = JSON.stringify(report, null, 2);
  if (outPath) writeTextAtomic(outPath, `${json}\n`);
  console.log(json);
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
