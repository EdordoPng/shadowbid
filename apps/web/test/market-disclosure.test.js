import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMarketDisclosure } from '../src/ui/market-disclosure.js';

test('fewer rows than the compact limit never offers a disclosure control', () => {
  const result = computeMarketDisclosure({ rowCount: 3, limit: 6, expanded: false });
  assert.equal(result.hasHidden, false);
  assert.equal(result.visibleCount, 3);
  assert.equal(result.buttonLabel, '');
});

test('more rows than the compact limit reports the exact hidden count', () => {
  const result = computeMarketDisclosure({ rowCount: 10, limit: 6, expanded: false });
  assert.equal(result.hasHidden, true);
  assert.equal(result.visibleCount, 6);
  assert.equal(result.hiddenCount, 4);
  assert.equal(result.buttonLabel, 'Show 4 more requests ↓');
});

test('a single hidden Request uses singular copy', () => {
  const result = computeMarketDisclosure({ rowCount: 7, limit: 6, expanded: false });
  assert.equal(result.buttonLabel, 'Show 1 more request ↓');
});

test('expanding reveals every Request and offers the collapse control', () => {
  const result = computeMarketDisclosure({ rowCount: 10, limit: 6, expanded: true });
  assert.equal(result.visibleCount, 10);
  assert.equal(result.hiddenCount, 0);
  assert.equal(result.hasHidden, true);
  assert.equal(result.buttonLabel, 'Show fewer requests ↑');
});

test('collapsing restores the compact max-6 row count', () => {
  const expanded = computeMarketDisclosure({ rowCount: 10, limit: 6, expanded: true });
  const collapsed = computeMarketDisclosure({ rowCount: 10, limit: 6, expanded: false });
  assert.equal(expanded.visibleCount, 10);
  assert.equal(collapsed.visibleCount, 6);
});

test('a new filtered result set recomputes disclosure state from scratch', () => {
  const smallerResult = computeMarketDisclosure({ rowCount: 2, limit: 6, expanded: false });
  assert.equal(smallerResult.hasHidden, false);
  const largerResult = computeMarketDisclosure({ rowCount: 20, limit: 4, expanded: false });
  assert.equal(largerResult.hiddenCount, 16);
});
