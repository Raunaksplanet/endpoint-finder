/**
 * One entry point for the static analyzers.
 *
 * This is the seam between endpoint-finder's collectors (page HTML, inline
 * scripts, fetched JS, unpacked sources) and JSHound's analyzer logic. It is
 * pure: no network, no filesystem, no execution.
 */

import { normalizeSource } from './normalize.js';
import {
  cleanEndpoint,
  literalAt,
  scanLiterals,
  MAX_CANDIDATE_LENGTH,
} from './endpoints.js';
import { extractParameters } from './params.js';
import { extractGraphQLOperations } from './graphql.js';
import { extractFiles, extractEmails } from './artifacts.js';

const URL_PREFIX = /^(?:https?:\/\/|wss?:\/\/|\/\/)/;

/**
 * @param {string} text raw body
 * @param {{includeParameters?: boolean}} [options]
 * @returns {{
 *   endpoints: string[],
 *   parameters: string[],
 *   graphql: string[],
 *   files: string[],
 *   emails: string[],
 * }}
 */
export function analyzeBody(text, options = {}) {
  const source = normalizeSource(text);
  const scan = scanLiterals(source);
  const endpoints = new Set();
  const fileCandidates = [];

  for (const lit of scan.direct) {
    fileCandidates.push(lit.value);
    if (URL_PREFIX.test(lit.value)) continue;
    const value = cleanEndpoint(lit.value, literalAt(source, lit));
    if (value) endpoints.add(value);
  }

  for (const lit of scan.quoted) {
    const value = lit.value.trim();
    if (!value || value.length > MAX_CANDIDATE_LENGTH) continue;
    fileCandidates.push(value);
    if (URL_PREFIX.test(value)) continue;
    const clean = cleanEndpoint(value, literalAt(source, lit));
    if (clean) endpoints.add(clean);
  }

  const endpointList = [...endpoints].sort();
  return {
    endpoints: endpointList,
    parameters: options.includeParameters === false
      ? []
      : extractParameters(source, endpointList),
    graphql: extractGraphQLOperations(source),
    files: extractFiles(fileCandidates),
    emails: extractEmails(source),
  };
}
