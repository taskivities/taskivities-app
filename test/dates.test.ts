// When a task was entered, in the person's time zone (shared/dates.ts stampIn, used by the MCP tools).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampIn } from '../shared/dates.ts';

test('stampIn gives the local day and 24-hour time', () => {
  assert.equal(stampIn('2026-11-27T19:40:12.000Z', 'Europe/London'), '2026-11-27 19:40');
  assert.equal(stampIn('2026-11-27T19:40:12.000Z', 'Asia/Kolkata'), '2026-11-28 01:10');
  assert.equal(stampIn('2026-11-27T00:05:00.000Z', 'America/New_York'), '2026-11-26 19:05');
});

test('stampIn shows midnight as 00, not 24', () => {
  assert.equal(stampIn('2026-11-27T00:00:00.000Z', 'UTC'), '2026-11-27 00:00');
});

test('summer time is applied', () => {
  assert.equal(stampIn('2026-07-01T08:30:00.000Z', 'Europe/London'), '2026-07-01 09:30');
});
