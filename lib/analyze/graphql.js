/**
 * GraphQL operation extraction — port of JSHound's graphqlOperation pass.
 * A name only counts when a selection set follows, so prose like
 * "query parameters" does not become an operation.
 */

const GRAPHQL_OPERATION = /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)\s*(?:\([^)]{0,1000}\)\s*)?(?:@[A-Za-z_][^{]{0,1000})?\{/gm;

/** @returns {string[]} sorted "query Name" / "mutation Name" strings */
export function extractGraphQLOperations(source) {
  if (!source) return [];
  if (!source.includes('query') && !source.includes('mutation') && !source.includes('subscription')) {
    return [];
  }
  const operations = new Set();
  for (const match of source.matchAll(GRAPHQL_OPERATION)) {
    operations.add(`${match[1]} ${match[2]}`);
  }
  return [...operations].sort();
}
