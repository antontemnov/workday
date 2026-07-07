/**
 * Unit tests for the pure search core (parse / build JQL / rank). No network,
 * no disk — see src/push/issue-search.ts.
 *
 * Run: npx tsx tests/unit/issue-search.test.ts
 */
import assert from 'node:assert/strict';
import {
  parseSearchQuery,
  buildKeyJql,
  buildWordJql,
  rankCandidates,
  projectKeyOf,
  type SearchCandidate,
} from '../../src/push/issue-search.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log('Issue search — parse / build JQL / rank');

// ─── projectKeyOf ──────────────────────────────────────────────────────────

test('projectKeyOf splits on the last dash', () => {
  assert.equal(projectKeyOf('ATL-16'), 'ATL');
  assert.equal(projectKeyOf('ATL-1650'), 'ATL');
  assert.equal(projectKeyOf('NODASH'), 'NODASH');
});

// ─── parseSearchQuery ────────────────────────────────────────────────────────

test('parse: explicit key + trailing words', () => {
  const p = parseSearchQuery('ATL-16 Retrospective', ['ATL']);
  assert.deepEqual(p.candidateKeys, ['ATL-16']);
  assert.deepEqual(p.searchWords, ['retrospective']);
  assert.deepEqual(p.numbers, []);
  assert.deepEqual(p.projectHints, []); // "ATL" was consumed by the explicit key
});

test('parse: bare number + words → number × allowed projects', () => {
  const p = parseSearchQuery('7757 reinstatement fix', ['ATL']);
  assert.deepEqual(p.candidateKeys, ['ATL-7757']);
  assert.deepEqual(p.numbers, ['7757']);
  assert.deepEqual(p.searchWords, ['reinstatement', 'fix']);
});

test('parse: project hint + number + 1-char word', () => {
  const p = parseSearchQuery('ATL 7757 r', ['ATL']);
  assert.deepEqual(p.projectHints, ['ATL']);
  assert.deepEqual(p.candidateKeys, ['ATL-7757']); // hint × number
  assert.deepEqual(p.numbers, ['7757']);
  assert.deepEqual(p.words, ['r']);
  assert.deepEqual(p.searchWords, []); // too short for a summary ~ clause
});

test('parse: partial number + partial word', () => {
  const p = parseSearchQuery('reinsta 775', ['ATL']);
  assert.deepEqual(p.candidateKeys, ['ATL-775']);
  assert.deepEqual(p.numbers, ['775']);
  assert.deepEqual(p.searchWords, ['reinsta']);
});

test('parse: bare number with multiple allowed projects expands per project', () => {
  const p = parseSearchQuery('16', ['ATL', 'CNF']);
  assert.deepEqual([...p.candidateKeys].sort(), ['ATL-16', 'CNF-16']);
});

test('parse: bare number with no allow-list yields no candidate keys', () => {
  const p = parseSearchQuery('16', []);
  assert.deepEqual(p.candidateKeys, []); // rely on the picker instead
  assert.deepEqual(p.numbers, ['16']);
});

test('parse: explicit foreign key kept (JQL scope hides it later)', () => {
  const p = parseSearchQuery('APP-12', ['ATL']);
  assert.deepEqual(p.candidateKeys, ['APP-12']);
});

// ─── buildKeyJql / buildWordJql (split — keys never crowded out by words) ────

test('build: key JQL is scoped and separate from the word search', () => {
  const p = parseSearchQuery('ATL-16 Retrospective', ['ATL']);
  assert.equal(buildKeyJql(p, ['ATL']), 'project in ("ATL") AND key in ("ATL-16") ORDER BY updated DESC');
  assert.equal(buildWordJql(p, ['ATL'], 'and'), 'project in ("ATL") AND summary ~ "retrospective*" ORDER BY updated DESC');
});

test('build: multi-word AND vs OR', () => {
  const p = parseSearchQuery('reinstatement fix', ['ATL']);
  assert.equal(
    buildWordJql(p, ['ATL'], 'and'),
    'project in ("ATL") AND (summary ~ "reinstatement*" AND summary ~ "fix*") ORDER BY updated DESC',
  );
  assert.equal(
    buildWordJql(p, ['ATL'], 'or'),
    'project in ("ATL") AND (summary ~ "reinstatement*" OR summary ~ "fix*") ORDER BY updated DESC',
  );
});

test('build: no scope when allow-list empty', () => {
  const p = parseSearchQuery('planning', []);
  assert.equal(buildWordJql(p, [], 'and'), 'summary ~ "planning*" ORDER BY updated DESC');
});

test('build: key-only query has no word JQL', () => {
  const p = parseSearchQuery('ATL-16', ['ATL']);
  assert.equal(buildKeyJql(p, ['ATL']), 'project in ("ATL") AND key in ("ATL-16") ORDER BY updated DESC');
  assert.equal(buildWordJql(p, ['ATL'], 'and'), null);
});

test('build: nothing searchable → both null', () => {
  const p = parseSearchQuery('r', ['ATL']); // 1-char word, no key, no number
  assert.equal(buildKeyJql(p, ['ATL']), null);
  assert.equal(buildWordJql(p, ['ATL'], 'and'), null);
});

// ─── rankCandidates ──────────────────────────────────────────────────────────

function cand(key: string, summary: string, over: Partial<SearchCandidate> = {}): SearchCandidate {
  return { key, summary, projectKey: projectKeyOf(key), ...over };
}

test('rank: exact key beats a numeric-prefix sibling', () => {
  const p = parseSearchQuery('ATL-16 retrospective', ['ATL']);
  const ranked = rankCandidates(
    [cand('ATL-1650', 'Retro board cleanup', { rank: 0 }), cand('ATL-16', 'Retrospective', { rank: 1 })],
    p, ['ATL'], 10,
  );
  assert.deepEqual(ranked.map(h => h.key), ['ATL-16', 'ATL-1650']);
});

test('rank: exact number match beats a longer prefix match', () => {
  const p = parseSearchQuery('775', ['ATL']);
  const ranked = rankCandidates(
    [cand('ATL-7757', 'Payments splitting', { rank: 0 }), cand('ATL-775', 'Access token refresh', { rank: 1 })],
    p, ['ATL'], 10,
  );
  assert.equal(ranked[0].key, 'ATL-775');
});

test('rank: candidates outside the allow-list are dropped', () => {
  const p = parseSearchQuery('retrospective', ['ATL']);
  const ranked = rankCandidates(
    [cand('ATL-16', 'Retrospective'), cand('APP-23719', 'Retrospective')],
    p, ['ATL'], 10,
  );
  assert.deepEqual(ranked.map(h => h.key), ['ATL-16']);
});

test('rank: exact summary word beats an unrelated recent issue', () => {
  const p = parseSearchQuery('planning', ['ATL']);
  const ranked = rankCandidates(
    [cand('ATL-7543', 'QA Plans MD files', { rank: 0 }), cand('ATL-14', 'Planning', { rank: 5 })],
    p, ['ATL'], 10,
  );
  assert.equal(ranked[0].key, 'ATL-14'); // "plans" is not a prefix of "planning"
});

test('rank: empty allow-list keeps everything', () => {
  const p = parseSearchQuery('retrospective', []);
  const ranked = rankCandidates(
    [cand('ATL-16', 'Retrospective'), cand('APP-23719', 'Retrospective')],
    p, [], 10,
  );
  assert.equal(ranked.length, 2);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
