'use strict';
// Plain-Node tests for Drive Log's Dragy calibration and Car Care's intervals (not installed on the car).
//   node test/dragy_carcare.test.js
const assert = require('assert');
const path = require('path');
const { DragyCal, READY_N } = require(path.join(__dirname, '..', 'apps', 'aref_drivelog', 'log', 'dragy.js'));
const { Trips } = require(path.join(__dirname, '..', 'apps', 'aref_drivelog', 'log', 'trip.js'));
const C = require(path.join(__dirname, '..', 'apps', 'aref_carcare', 'care', 'items.js'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the offset is the median of Dragy minus car, ready after 3 runs', () => {
    const cal = new DragyCal();
    const now = Date.now();
    const ids = [3.70, 3.75, 3.68, 4.40].map((s, i) => cal.addRun(now + i, s));
    assert.strictEqual(cal.pending(now + 10).id, ids[3], 'the newest run waits first');
    cal.setDragy(ids[0], 3.95);
    cal.setDragy(ids[1], 4.00);
    assert.strictEqual(cal.stats().ready, false);
    assert.strictEqual(cal.adjusted(3.7), null);
    cal.setDragy(ids[2], 3.93);
    cal.setDragy(ids[3], 5.40);                  // one bad pair (weak GPS): the median ignores it
    const s = cal.stats();
    assert.strictEqual(s.n, 4);
    assert.ok(s.ready && READY_N === 3);
    assert.strictEqual(s.offset, 0.25);
    assert.strictEqual(cal.adjusted(3.80), 4.05);
    assert.strictEqual(cal.guess(3.80), 4.05);
    assert.strictEqual(cal.pending(now + 10), null);
});

test('skipped and week-old runs no longer ask for a Dragy time', () => {
    const cal = new DragyCal();
    const id = cal.addRun(1000, 4.1);
    cal.skip(id);
    assert.strictEqual(cal.pending(2000), null);
    cal.addRun(2000, 4.0);
    assert.strictEqual(cal.pending(2000 + 8 * 86400000), null);
});

test('Trips reports each 0-60 run for the calibration', () => {
    const tr = new Trips();
    tr.feed({ speed: 0 }, 0);
    for (let i = 1; i <= 50; i++) tr.feed({ speed: i * 2.5 }, i * 100);
    assert.strictEqual(tr.newRuns.length, 1);
    assert.ok(Math.abs(tr.newRuns[0].s - 3.86) < 0.1, String(tr.newRuns[0].s));
});

test('oil by miles or a year, whichever first', () => {
    const oil = C.ITEMS.find((x) => x.key === 'oil');
    const now = Date.UTC(2026, 10, 6);
    const rec = { km: 100000, at: now - 30 * 86400000 };
    const r = C.status(oil, rec, 100000 + 1200 * C.MI, now, 3000);
    assert.ok(Math.abs(r.leftKm / C.MI - 1800) < 1);
    assert.ok(!r.due && !r.soon);
    assert.strictEqual(C.leftText(r, 'us').split('; ')[0], '1,800 mi left');
    const over = C.status(oil, rec, 100000 + 3100 * C.MI, now, 3000);
    assert.ok(over.due);
    assert.strictEqual(C.leftText(over, 'us').split('; ')[0], '100 mi over');
    const old = C.status(oil, { km: 100000, at: now - 400 * 86400000 }, 100000 + 500 * C.MI, now, 3000);
    assert.ok(old.due, 'a year without a change is due even at low miles');
});

test('time-only items and items never recorded', () => {
    const brake = C.ITEMS.find((x) => x.key === 'brake');
    const now = Date.UTC(2026, 10, 6);
    const r = C.status(brake, { km: 0, at: now - 23 * 30.44 * 86400000 }, null, now, 24);
    assert.ok(r.soon && !r.due);
    assert.strictEqual(r.leftKm, null);
    assert.strictEqual(C.status(brake, undefined, 0, now, 24).known, false);
    assert.strictEqual(C.commas(1234567), '1,234,567');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok', name); } catch (e) { console.log('FAIL', name, '\n', e.stack); process.exitCode = 1; }
    }
    console.log(process.exitCode ? 'some tests failed' : tests.length + ' tests passed');
})();
