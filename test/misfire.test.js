'use strict';
// Misfire Watch's log (apps/aref_misfire/misfire/track.js): node test/misfire.test.js
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'apps', 'aref_misfire', 'misfire', 'track.js'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ctx = (rpm) => ({ rpm: rpm, speed: 60, gear: 3, coolant: 90, mode: 'SPORT' });

test('each rise of the drive counter is one event, per cylinder, with its conditions', () => {
    const t = new T.Tracker();
    assert.deepStrictEqual(t.feed([0, 0, 0, 0, 0, 0], 1000, ctx(800)), []);
    assert.deepStrictEqual(t.feed([0, 0, 0, 0, 0, 0], 5000, ctx(2000)), []);
    const ev = t.feed([0, 0, 2, 0, 0, 1], 9000, ctx(4500));
    assert.strictEqual(ev.length, 2);
    assert.deepStrictEqual(ev.map((e) => [e.cyl, e.n, e.ctx.rpm, e.early]), [[3, 2, 4500, false], [6, 1, 4500, false]]);
    t.feed([0, 0, 5, 0, 0, 1], 13000, ctx(5200));
    assert.strictEqual(t.driveTotal(), 6);
    assert.deepStrictEqual(t.state.drive.counts, [0, 0, 5, 0, 0, 1]);
    assert.strictEqual(t.worst(), 3);
});

test('a count lower than the last one is a new drive; misfires before its first reading are marked early', () => {
    const t = new T.Tracker();
    t.feed([0, 0, 4, 0, 0, 0], 1000, ctx(3000));          // a drive's first reading with 4 already counted
    assert.strictEqual(t.state.events[0].early, true);
    t.feed([0, 0, 6, 0, 0, 0], 5000, ctx(3000));
    const ev = t.feed([1, 0, 0, 0, 0, 0], 99999, ctx(700)); // next engine start: counter back near 0
    assert.strictEqual(t.state.drives.length, 1);
    assert.strictEqual(t.state.drive.id, 2);
    assert.deepStrictEqual(t.state.drives[0].counts, [0, 0, 6, 0, 0, 0]);
    assert.deepStrictEqual(ev.map((e) => [e.cyl, e.n, e.early]), [[1, 1, true]]);
    assert.deepStrictEqual(t.state.totals, [1, 0, 6]);
});

test('a long gap with all counters at 0 starts a new drive; a value the unit lacks is skipped', () => {
    const t = new T.Tracker();
    t.feed([0, 0, 0, 0, 0, 0], 0, ctx(800));
    t.feed([0, 0, 0, 0, 0, 0], 30 * 60000, ctx(800));
    assert.strictEqual(t.state.drives.length, 1);
    const ev = t.feed([null, 0, 0, 0, 2, 0], 30 * 60000 + 4000, ctx(900));
    assert.deepStrictEqual(ev.map((e) => e.cyl), [5]);
});

test('the log survives a restart (state as JSON) and keeps counting from the last reading', () => {
    const a = new T.Tracker();
    a.feed([0, 1, 0, 0, 0, 0], 1000, ctx(800), [0, 3, 0, 0, 0, 0]);
    const b = new T.Tracker(JSON.parse(JSON.stringify(a.state)));
    const ev = b.feed([0, 3, 0, 0, 0, 0], 5000, ctx(800));
    assert.deepStrictEqual(ev.map((e) => [e.cyl, e.n]), [[2, 2]]);
    assert.deepStrictEqual(b.state.avg10, [0, 3, 0, 0, 0, 0]);
    assert.strictEqual(b.state.drive.id, 1);
});

test('CSV export and severity', () => {
    const t = new T.Tracker();
    t.feed([0, 0, 0, 0, 0, 0], 0, ctx(800));
    t.feed([0, 2, 0, 0, 0, 0], 1000, { rpm: 4321.4, speed: 80, gear: 4, torque: 410, mode: 'SPORT, PLUS' });
    const lines = T.csv(t.state.events).trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1], '1970-01-01T00:00:01.000Z,1,2,2,no,4321,80,,,4,410,SPORT  PLUS');
    assert.strictEqual(T.severity(0), 'ok');
    assert.strictEqual(T.severity(3, 10), 'few');
    assert.strictEqual(T.severity(12, 10), 'many');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exit(1); }
    }
    console.log(tests.length + ' tests passed');
})();
