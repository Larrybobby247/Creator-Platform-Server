import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCommission } from '../src/utils/money.js';

test('commission is integer and net+commission == gross', () => {
  const r = splitCommission(150, 2000);
  assert.deepEqual(r, { gross: 150, commission: 30, net: 120 });
  const odd = splitCommission(7, 1500);
  assert.equal(odd.commission + odd.net, 7);
  assert.ok(Number.isInteger(odd.commission));
});
test('rejects floats and bad bps', () => {
  assert.throws(() => splitCommission(1.5, 100));
  assert.throws(() => splitCommission(10, 10001));
});
