/**
 * Parameter extraction — port of JSHound's parameter pass, with two fixes:
 *   - ES6 shorthand object keys are captured ({ name, email }).
 *   - URL/route parameters are read from the classified endpoints, not from
 *     every string that merely looks like a path.
 */

const QUERY_PARAMETER = /(?:[?&]|&amp;)([A-Za-z_][A-Za-z0-9_.\-]{0,127})=/g;
const PARAMETER_METHOD = /\b(?:URLSearchParams|FormData)?\s*\.?\s*(?:append|set|get|has|delete)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_.\-]{0,127})["']/gi;
const HTML_NAME = /<(?:input|select|textarea|button)\b[^>]*?\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gis;
const REQUEST_BODY = /(?:JSON\.stringify\s*\(|axios\.(?:post|put|patch)\s*\([^,]+,\s*)\{([^{}]{1,1000}[^{}]{0,1000}[^{}]{0,1000}[^{}]{0,1000}[^{}]{0,96})\}/gis;
const OBJECT_KEY = /(?:^|,)\s*(?:["']([A-Za-z_][A-Za-z0-9_.\-]{0,127})["']|([A-Za-z_][A-Za-z0-9_.\-]{0,127}))\s*:/g;
const SHORTHAND_KEY = /^([A-Za-z_][A-Za-z0-9_.\-]{0,127})$/;
const GRAPHQL_VARIABLE = /\$([_A-Za-z][_0-9A-Za-z]*)\s*:/g;

/** Add `:id` and `{id}` route parameters from one endpoint. */
export function collectRouteParameters(value, parameters) {
  const pathname = value.split('?')[0].split('#')[0];
  for (let segment of pathname.split('/')) {
    segment = segment.trim();
    if (segment.startsWith(':')) segment = segment.slice(1);
    else if (segment.startsWith('{') && segment.endsWith('}')) segment = segment.slice(1, -1);
    else continue;
    if (segment) parameters.add(segment);
  }
}

/** Add query-string keys from an absolute, protocol-relative or relative URL. */
export function collectURLParameters(value, parameters) {
  let parsedValue = value;
  if (value.startsWith('//')) {
    parsedValue = `https:${value}`;
  } else if (/^(\/|\.\/|\.\.\/)/.test(value)) {
    parsedValue = `https://jshound.invalid/${value.replace(/^[./]+/, '')}`;
  }
  try {
    const url = new URL(parsedValue, 'https://jshound.invalid/');
    for (const key of url.searchParams.keys()) {
      if (key) parameters.add(key);
    }
  } catch {
    /* not a URL — ignore */
  }
}

/** Keys of an object literal, including ES6 shorthand properties. */
export function extractObjectKeys(body) {
  const keys = new Set();
  for (const match of body.matchAll(OBJECT_KEY)) {
    keys.add(match[1] || match[2]);
  }
  // The requestBody pattern excludes nested braces, so a top-level comma split
  // is safe here. A part with no ':' and a plain identifier is shorthand.
  for (const part of body.split(',')) {
    const value = part.trim();
    if (!value || value.includes(':') || value.startsWith('...')) continue;
    const match = value.match(SHORTHAND_KEY);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * Extract parameter names from a source body.
 * @param {string} source
 * @param {string[]} endpoints classified endpoints, for route/query params
 * @returns {string[]} sorted, deduped names
 */
export function extractParameters(source, endpoints = []) {
  const parameters = new Set();
  source = String(source || '');

  for (const match of source.matchAll(QUERY_PARAMETER)) parameters.add(match[1]);

  if (source.includes('URLSearchParams') || source.includes('FormData') ||
      source.includes('.append(') || source.includes('.set(')) {
    for (const match of source.matchAll(PARAMETER_METHOD)) parameters.add(match[1]);
  }

  if (/<input|<select|<textarea/i.test(source)) {
    for (const match of source.matchAll(HTML_NAME)) {
      const name = match[1] || match[2] || match[3];
      if (name) parameters.add(name);
    }
  }

  if (source.includes('JSON.stringify') || /axios\.(post|put|patch)/.test(source)) {
    for (const match of source.matchAll(REQUEST_BODY)) {
      for (const key of extractObjectKeys(match[1])) parameters.add(key);
    }
  }

  if (source.includes('query') || source.includes('mutation') || source.includes('subscription')) {
    for (const match of source.matchAll(GRAPHQL_VARIABLE)) parameters.add(match[1]);
  }

  for (const endpoint of endpoints) {
    collectURLParameters(endpoint, parameters);
    collectRouteParameters(endpoint, parameters);
  }

  return [...parameters].sort();
}
