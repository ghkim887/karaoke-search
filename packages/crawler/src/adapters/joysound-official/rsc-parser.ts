import type { JoysoundListItem } from './types.js';

/**
 * Decode a JS string literal's escape sequences (RSC chunks wrap each
 * payload in a JS string passed to `self.__next_f.push([1, "<chunk>"])`).
 * Handles `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, `\/`, and `\uXXXX`.
 * Unknown escapes drop the leading backslash.
 */
function jsStringUnescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) {
      // Trailing lone backslash — keep it literal.
      out += '\\';
      break;
    }
    i++;
    switch (n) {
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          out += n;
        }
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}

/**
 * Pull every `self.__next_f.push([1, "<chunk>"])` payload out of an HTML
 * body, unescape each chunk as a JS string literal, and return the
 * concatenated stream. Pages without any push calls return the original body
 * so unescaped JSON (e.g. a `__NEXT_DATA__` script tag) is still searchable.
 */
function decodeRscStream(body: string): string {
  const re = /self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]\)/g;
  let m: RegExpExecArray | null;
  let combined = '';
  let any = false;
  for (m = re.exec(body); m !== null; m = re.exec(body)) {
    any = true;
    combined += `${jsStringUnescape(m[1] as string)}\n`;
  }
  return any ? combined : body;
}

/**
 * Scan `text` for object literals containing `"naviGroupId":<value>` and
 * extract each surrounding balanced `{...}` block as a raw string. The
 * scanner is brace-aware and string-aware (it tracks JSON string boundaries
 * so braces inside song titles do not corrupt the cut).
 *
 * Returns each candidate exactly once in first-seen order. Callers
 * `JSON.parse` the result and apply field-shape checks.
 */
function extractObjectsWithKey(text: string, key: string): string[] {
  const out: string[] = [];
  const keyToken = `"${key}"`;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const keyAt = text.indexOf(keyToken, searchFrom);
    if (keyAt === -1) break;

    // Walk backward to find the `{` that opens the object containing this key.
    let start = -1;
    let depth = 0;
    let inStr = false;
    for (let i = keyAt - 1; i >= 0; i--) {
      const ch = text[i] as string;
      // Going backward through a string is messy; cheap approximation —
      // when we hit an unescaped `"`, toggle. The escape state is tracked
      // by peeking at the preceding char.
      if (ch === '"') {
        const prev = i > 0 ? text[i - 1] : '';
        if (prev !== '\\') inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    if (start === -1) {
      searchFrom = keyAt + keyToken.length;
      continue;
    }

    // Walk forward from `start` to find the matching `}`.
    depth = 0;
    inStr = false;
    let strEsc = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i] as string;
      if (inStr) {
        if (strEsc) {
          strEsc = false;
        } else if (ch === '\\') {
          strEsc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      searchFrom = keyAt + keyToken.length;
      continue;
    }

    out.push(text.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return out;
}

/**
 * Coerce a JSON value to a non-empty string. JOYSOUND occasionally renders
 * numeric IDs as JSON numbers; finite numbers are converted. Empty / null /
 * `$undefined` / non-string-non-number values return null.
 */
function coerceIdString(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v === '' || v === '$undefined') return null;
    return v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Coerce a JSON value to a required non-empty string. Returns null on any
 * non-string or empty / `$undefined` marker — callers treat null as "skip
 * this row" since required-field cells cannot be filled in later.
 */
function coerceRequiredString(v: unknown): string | null {
  if (typeof v !== 'string') {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  }
  if (v === '' || v === '$undefined') return null;
  return v;
}

/**
 * Parse a JOYSOUND new-release listing page's RSC payload into structured
 * `JoysoundListItem` rows. Handles both escaped chunks (Next.js streaming
 * via `self.__next_f.push([1, "..."])`) and unescaped inline JSON.
 *
 * Rules:
 *  - Only fragments carrying all four required fields (`naviGroupId`,
 *    `selSongNo`, `songName`, `artistName`) are emitted.
 *  - Optional fields rendered as `$undefined` (the React server marker)
 *    are normalized to `null`.
 *  - Numeric IDs are coerced to strings.
 *  - Rows are deduped by `naviGroupId`, preserving first-seen order.
 */
export function parseJoysoundListItems(html: string): JoysoundListItem[] {
  const stream = decodeRscStream(html);
  const candidates = extractObjectsWithKey(stream, 'naviGroupId');
  const seen = new Set<string>();
  const out: JoysoundListItem[] = [];
  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;

    const naviGroupId = coerceRequiredString(obj.naviGroupId);
    const selSongNo = coerceRequiredString(obj.selSongNo);
    const songName = coerceRequiredString(obj.songName);
    const artistName = coerceRequiredString(obj.artistName);
    if (naviGroupId === null || selSongNo === null || songName === null || artistName === null) {
      continue;
    }
    if (seen.has(naviGroupId)) continue;
    seen.add(naviGroupId);

    out.push({
      naviGroupId,
      selSongNo,
      songName,
      artistName,
      artistId: coerceIdString(obj.artistId),
      tieupInfo: coerceIdString(obj.tieupInfo),
      tieupId: coerceIdString(obj.tieupId),
    });
  }
  return out;
}

/**
 * Parse a JOYSOUND new-release listing page's pagination total. Looks for
 * `"totalPage":<N>` or `"totalPages":<N>` in the decoded RSC stream. Returns
 * `{ totalPages: null }` when no positive integer is found — the crawler
 * falls back to page 1 only in that case.
 */
export function parseJoysoundPagination(html: string): { totalPages: number | null } {
  const stream = decodeRscStream(html);
  const re = /"totalPages?"\s*:\s*(\d+)/g;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  for (m = re.exec(stream); m !== null; m = re.exec(stream)) {
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
  }
  return { totalPages: best };
}
