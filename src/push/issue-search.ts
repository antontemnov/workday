/**
 * Pure search core — no network. Turns a messy human query ("ATL 7757 r",
 * "reinsta 775", "ATL-16 Retrospective") into (a) a JQL expression for the
 * enhanced /search/jql endpoint and (b) a deterministic re-ranking of the
 * candidates that come back (from JQL and the picker). See the design doc
 * personal/workday/plans/jira-search-relevance.md.
 */
import type { JiraSearchHit } from '../core/types.js';
import { SEARCH_MIN_WORD_LENGTH } from '../core/constants.js';

export interface ParsedQuery {
  readonly raw: string;
  // Exact keys to try via `key in (...)` — explicit "PROJ-NUM" tokens plus
  // projectHint×number and (when no hint) number×allowedProject combinations.
  readonly candidateKeys: readonly string[];
  readonly numbers: readonly string[];      // digit tokens (full or partial issue numbers)
  readonly words: readonly string[];         // lowercased non-key words (all, incl. short)
  readonly searchWords: readonly string[];   // words usable in `summary ~` (len >= min, sanitized)
  readonly projectHints: readonly string[];  // allowed project keys named in the query (uppercase)
}

export interface SearchCandidate {
  readonly key: string;
  readonly summary: string;
  readonly projectKey: string;
  readonly fromHistory?: boolean;  // surfaced by the picker's history section (recency)
  readonly rank?: number;          // position in the source's own order (lower = earlier)
}

const KEY_RE = /([A-Za-z][A-Za-z0-9]+)-(\d+)/g;
const MAX_CANDIDATE_KEYS = 50;

/** Project key of an issue key: everything before the last dash ("ATL-16" → "ATL"). */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf('-');
  return dash > 0 ? issueKey.slice(0, dash) : issueKey;
}

/** Tokenize + classify a raw query against the allowed project keys. */
export function parseSearchQuery(query: string, allowedKeys: readonly string[]): ParsedQuery {
  const raw = query.trim();
  const upperAllowed = allowedKeys.map(k => k.toUpperCase());
  const allowedSet = new Set(upperAllowed);

  // 1) Explicit PROJ-NUM keys, then strip them so their pieces aren't re-tokenized.
  const explicitKeys: string[] = [];
  for (const m of raw.matchAll(KEY_RE)) {
    explicitKeys.push(`${m[1].toUpperCase()}-${m[2]}`);
  }
  const remainder = raw.replace(KEY_RE, ' ');

  // 2) Classify the leftover tokens.
  const numbers: string[] = [];
  const projectHints: string[] = [];
  const words: string[] = [];
  for (const tok of remainder.split(/[\s\-]+/).map(t => t.trim()).filter(Boolean)) {
    if (/^\d+$/.test(tok)) numbers.push(tok);
    else if (allowedSet.has(tok.toUpperCase())) projectHints.push(tok.toUpperCase());
    else words.push(tok.toLowerCase());
  }

  // 3) Exact-key candidates.
  const keySet = new Set<string>(explicitKeys);
  for (const p of projectHints) for (const n of numbers) keySet.add(`${p}-${n}`);
  if (projectHints.length === 0) {
    for (const n of numbers) for (const k of upperAllowed) keySet.add(`${k}-${n}`);
  }
  const candidateKeys = [...keySet].slice(0, MAX_CANDIDATE_KEYS);

  // 4) Words usable in a `summary ~` clause (sanitized, long enough).
  const searchWords = words
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(w => w.length >= SEARCH_MIN_WORD_LENGTH);

  return {
    raw,
    candidateKeys,
    numbers,
    words,
    searchWords,
    projectHints: [...new Set(projectHints)],
  };
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function scopePrefix(allowedKeys: readonly string[]): string {
  return allowedKeys.length > 0
    ? `project in (${allowedKeys.map(jqlString).join(', ')}) AND `
    : '';
}

/**
 * Exact-key lookup JQL, or null when the query yielded no candidate keys. Run
 * separately from the word search so a matched key is never crowded out of the
 * result window by a flood of `summary ~` hits ordered by recency.
 */
export function buildKeyJql(parsed: ParsedQuery, allowedKeys: readonly string[]): string | null {
  if (parsed.candidateKeys.length === 0) return null;
  return `${scopePrefix(allowedKeys)}key in (${parsed.candidateKeys.map(jqlString).join(', ')}) ORDER BY updated DESC`;
}

/**
 * Summary-prefix JQL, or null when there are no usable words. wordMode picks
 * how multiple prefixes combine: 'and' (precision) first, 'or' (recall) as a
 * fallback when AND returns nothing.
 */
export function buildWordJql(
  parsed: ParsedQuery,
  allowedKeys: readonly string[],
  wordMode: 'and' | 'or',
): string | null {
  if (parsed.searchWords.length === 0) return null;
  const joiner = wordMode === 'and' ? ' AND ' : ' OR ';
  const words = parsed.searchWords.map(w => `summary ~ ${jqlString(w + '*')}`).join(joiner);
  const clause = parsed.searchWords.length > 1 ? `(${words})` : words;
  return `${scopePrefix(allowedKeys)}${clause} ORDER BY updated DESC`;
}

/** Does any word in the text start with the prefix? */
function anyWordStartsWith(text: string, prefix: string): boolean {
  if (!prefix) return false;
  for (const tok of text.split(/[^\p{L}\p{N}]+/u)) {
    if (tok.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Score and order candidates against the parsed query, hard-dropping anything
 * outside the allow-list. Deterministic — exact key, then number-prefix, then
 * summary word/phrase match, then project priority and recency.
 */
export function rankCandidates(
  candidates: readonly SearchCandidate[],
  parsed: ParsedQuery,
  allowedKeys: readonly string[],
  cap: number,
): JiraSearchHit[] {
  const priority = new Map(allowedKeys.map((k, i) => [k.toUpperCase(), i]));
  const exactKeys = new Set(parsed.candidateKeys.map(k => k.toUpperCase()));
  const phrase = parsed.words.join(' ');

  const scored = candidates
    .filter(c => priority.size === 0 || priority.has(c.projectKey.toUpperCase()))
    .map(c => ({ c, score: scoreCandidate(c, parsed, exactKeys, phrase, priority) }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = a.c.rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.c.rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.c.key.localeCompare(b.c.key);
  });

  return scored.slice(0, cap).map(({ c }) => ({ key: c.key, summary: c.summary }));
}

function scoreCandidate(
  c: SearchCandidate,
  parsed: ParsedQuery,
  exactKeys: ReadonlySet<string>,
  phrase: string,
  priority: ReadonlyMap<string, number>,
): number {
  let s = 0;
  const keyUpper = c.key.toUpperCase();
  const summaryLower = c.summary.toLowerCase();

  // Exact key we explicitly resolved via `key in`.
  if (exactKeys.has(keyUpper)) s += 1000;

  // Query number is a prefix of the issue number.
  const numPart = keyUpper.slice(keyUpper.lastIndexOf('-') + 1);
  for (const n of parsed.numbers) {
    if (numPart === n) s += 500;
    else if (numPart.startsWith(n)) s += 300 + Math.min(150, n.length * 30);
  }

  // Summary word/phrase match.
  if (parsed.words.length > 0) {
    if (parsed.words.every(w => anyWordStartsWith(summaryLower, w))) s += 300;
    if (phrase && summaryLower.includes(phrase)) s += 150;
    if (summaryLower.startsWith(parsed.words[0])) s += 100;
  }

  // Project hint match + configured priority (earlier in the allow-list = higher).
  if (parsed.projectHints.includes(c.projectKey.toUpperCase())) s += 200;
  const pr = priority.get(c.projectKey.toUpperCase());
  if (pr !== undefined) s += Math.max(0, 50 - pr * 10);

  // Recency tie-breakers.
  if (c.fromHistory) s += 40;
  if (c.rank !== undefined) s += Math.max(0, 20 - c.rank);

  return s;
}
