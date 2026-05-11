/**
 * Shared CSV helpers for scripts/*.mjs.
 *
 * Exports:
 *   parseCsv(text)
 *     RFC-4180-compliant parser. Handles: BOM, CRLF/LF, quoted fields
 *     with commas, escaped quotes (""). Returns { headers, rows }.
 *
 *   csvEscape(value)
 *     Quotes a field value when it contains commas, double-quotes, or
 *     newlines. Safe for UTF-8 BOM CSV files.
 */

/**
 * Parse a CSV string into an array of row objects keyed by the header row.
 * @param {string} raw - raw file content (may start with BOM)
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
export function parseCsv(raw) {
  // Strip UTF-8 BOM if present
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;

  // Tokenize fields respecting RFC-4180 quoting rules
  function tokenizeRow(line, pos) {
    const fields = [];
    let i = pos;
    const len = text.length;

    while (i <= len) {
      if (i === len || text[i] === '\n' || (text[i] === '\r' && text[i + 1] === '\n')) {
        // End of row
        const advance = i < len && text[i] === '\r' ? 2 : i < len ? 1 : 0;
        fields.push('');
        return { fields, nextPos: i + advance };
      }
      if (text[i] === '"') {
        // Quoted field
        let val = '';
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              val += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            val += text[i++];
          }
        }
        fields.push(val);
        // skip comma separator if present
        if (i < len && text[i] === ',') i++;
      } else {
        // Unquoted field: read until comma or end-of-line
        let val = '';
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          val += text[i++];
        }
        fields.push(val);
        if (i < len && text[i] === ',') i++;
      }
    }
    return { fields, nextPos: len };
  }

  const lines = [];
  let pos = 0;
  while (pos < text.length) {
    // Skip blank lines
    if (text[pos] === '\n') {
      pos++;
      continue;
    }
    if (text[pos] === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      continue;
    }
    const { fields, nextPos } = tokenizeRow(text, pos);
    // Drop trailing empty field from CRLF/LF terminator artifact
    const trimmed = fields[fields.length - 1] === '' ? fields.slice(0, -1) : fields;
    if (trimmed.length > 0) lines.push(trimmed);
    pos = nextPos;
  }

  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0];
  const rows = lines.slice(1).map((fields) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = fields[i] ?? '';
    }
    return obj;
  });
  return { headers, rows };
}

/**
 * Escape a single CSV field value. Wraps in double-quotes when the value
 * contains a comma, double-quote, or newline; escapes embedded quotes as "".
 * @param {string|null|undefined} field
 * @returns {string}
 */
export function csvEscape(field) {
  const s = String(field ?? '');
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
