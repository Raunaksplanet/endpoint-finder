/**
 * Source normalization — port of JSHound's analyzer.normalizeSource.
 *
 * JS/HTML bodies hide paths behind HTML entities and JavaScript escapes:
 *   &amp;            -> &
 *   \u002f \u002F     -> /
 *   \x2f  \x2F       -> /
 *   \/                -> /
 *
 * Keep this deliberately narrow. A full URL-unescape pass would turn "+"
 * into a space and corrupt query strings.
 */

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** Decode the HTML entities that actually occur inside JS/HTML bodies. */
export function decodeHtmlEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
    }
    return NAMED[lower] ?? whole;
  });
}

function safeFromCodePoint(code) {
  if (code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Normalize a source body before scanning.
 *
 * Order matters: HTML entities first (so `&amp;#x2f;` style nesting is not
 * half-decoded), then the JS escape forms.
 */
export function normalizeSource(content) {
  if (!content) return '';
  return decodeHtmlEntities(String(content))
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\x2[fF]/g, '/')
    .replace(/\\\//g, '/');
}
