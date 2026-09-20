/**
 * Query tokenization for memory search.
 *
 * Both semantic and procedural search used to LIKE the *entire* query string
 * against name/key/description/value. That works for a hand-typed lookup
 * ("recall_procedure('eth')") and silently fails for everything the retriever
 * passes it, because the retriever's query is the whole injected turn input —
 * a multi-line block like "DECISION REQUIRED. These positions have reached the
 * exit levels YOU set: ...". No stored row ever contains that as a substring,
 * so retrieval returned zero rows on exactly the turns that carry input, which
 * are the turns where the agent most needs its memory. Measured against the
 * live store: 0/55 procedures and 0/16 facts matched on a forced-decision turn.
 *
 * Splitting the query into terms and scoring a row by how many distinct terms
 * it matches turns that silent empty into a ranked result.
 */

/**
 * Words carrying no retrieval signal. Deliberately short: a term that is
 * merely common in this domain ("price", "sell", "position") is still a real
 * signal for ranking, so only genuinely contentless words belong here.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "all",
  "any", "can", "had", "has", "have", "her", "his", "its", "our", "out",
  "own", "that", "them", "then", "they", "this", "was", "were", "what",
  "when", "which", "who", "will", "with", "would", "there", "their", "from",
  "into", "than", "that's", "these", "those", "been", "being", "does", "did",
  "doing", "each", "how", "now", "one", "only", "other", "over", "same",
  "some", "such", "very", "just", "more", "most", "here", "because", "again",
]);

/** Terms shorter than this carry too little signal to rank on. */
const MIN_TERM_LENGTH = 3;

/**
 * Cap on terms per query. A long injected prompt would otherwise build a
 * SQL expression with one LIKE pair per term; the cap keeps the statement
 * bounded while keeping the first, most topical part of the input.
 */
const MAX_TERMS = 12;

/**
 * Split a query into distinct lowercase search terms.
 *
 * Returns an empty array when the query carries no usable term, which callers
 * treat as "no search" rather than "match everything".
 */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** Escape LIKE wildcards so a literal '%' or '_' in a term stays literal. */
export function escapeLike(term: string): string {
  return term.replace(/[%_]/g, (ch) => `\\${ch}`);
}

/**
 * Build the scoring fragment for a term list: one CASE per term, summed, so a
 * row's score is the number of distinct terms it matches across the given
 * columns. Returns the SQL and the bound parameters in order.
 */
export function buildTermScore(
  terms: string[],
  columns: string[],
): { sql: string; params: string[] } {
  const params: string[] = [];
  const cases = terms.map((term) => {
    const pattern = `%${escapeLike(term)}%`;
    const tests = columns.map((col) => {
      params.push(pattern);
      return `${col} LIKE ? ESCAPE '\\'`;
    });
    return `(CASE WHEN ${tests.join(" OR ")} THEN 1 ELSE 0 END)`;
  });
  return { sql: cases.join(" + "), params };
}
