// Several mode's "Select all" / "Clear" (src/pick.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPicked, toggleAll } from '../src/pick.ts';

test('Select all ticks every row the search shows, and keeps what was ticked before', () => {
  assert.deepEqual(toggleAll(['other'], ['a', 'b', 'c']), ['other', 'a', 'b', 'c']);
});

test('Select all adds only the rows not yet ticked', () => {
  assert.deepEqual(toggleAll(['b'], ['a', 'b', 'c']), ['b', 'a', 'c']);
  assert.equal(allPicked(['b'], ['a', 'b', 'c']), false);
});

test('Clear, once all shown rows are ticked, unticks just those rows', () => {
  assert.equal(allPicked(['other', 'a', 'b'], ['a', 'b']), true);
  assert.deepEqual(toggleAll(['other', 'a', 'b'], ['a', 'b']), ['other']);
});

test('An empty search result is never "all picked"', () => {
  assert.equal(allPicked(['a'], []), false);
  assert.deepEqual(toggleAll(['a'], []), ['a']);
});
