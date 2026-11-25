/**
 * File and email artifacts — port of JSHound's filePattern / emailPattern.
 * Absolute URLs stay in the URL category; only non-URL candidates become
 * files, so the same value is never reported twice.
 */

const FILE_PATTERN = /^(?:https?:\/\/[^\s"'<>\\]+|(?:\/|\.\/|\.\.\/)?[a-z0-9_@%+~.-]+(?:\/[a-z0-9_@%+~.()\-]+)*)\.(?:7z|apk|asp|aspx|bak|backup|bin|bz2|cfg|conf|config|crt|csv|db|docx?|env|gz|html?|ini|jar|js|json|jsx|key|log|mjs|old|orig|p12|pdf|pem|pfx|php|properties|rar|sql|tar|tgz|toml|ts|tsx|txt|war|wasm|xlsx?|xml|ya?ml|zip)(?:[?#][^\s"'<>\\]*)?$/i;

const EMAIL_PATTERN = /[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

const URL_PREFIX = /^(?:https?:\/\/|wss?:\/\/|\/\/)/;

const PLACEHOLDER_DOMAINS = new Set([
  'example.com', 'test.com', 'domain.com', 'placeholder.com', 'email.com',
]);

/**
 * Keep only non-URL candidates that end in a known file extension.
 * @param {Array<string|{value:string}>} candidates
 * @returns {string[]} sorted, deduped
 */
export function extractFiles(candidates) {
  const files = new Set();
  for (const candidate of candidates || []) {
    const value = typeof candidate === 'string' ? candidate : candidate?.value;
    if (!value) continue;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed.length > 2048) continue;
    if (URL_PREFIX.test(trimmed)) continue;
    if (FILE_PATTERN.test(trimmed)) files.add(trimmed);
  }
  return [...files].sort();
}

/** @returns {string[]} sorted, deduped email addresses */
export function extractEmails(source) {
  if (!source) return [];
  const emails = new Set();
  for (const match of source.matchAll(EMAIL_PATTERN)) {
    if (validEmail(source, match.index, match[0])) emails.add(match[0]);
  }
  return [...emails].sort();
}

function validEmail(content, start, value) {
  const parts = value.split('@');
  const domain = parts[parts.length - 1].toLowerCase();
  if (PLACEHOLDER_DOMAINS.has(domain) || domain.includes('w3.org')) return false;

  // user:pass@host and database URIs are credentials, not addresses.
  if (start > 0 && content[start - 1] === ':') return false;
  const prefix = content.slice(Math.max(0, start - 12), start).toLowerCase();
  return !prefix.includes('://') &&
    !prefix.includes('mongodb') &&
    !prefix.includes('postgres') &&
    !prefix.includes('mysql');
}
