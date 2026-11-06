'use strict';
// Plain-Node tests for Fault Watch's and Drive Log's logic (not installed on the car).
//   node test/faultwatch_drivelog.test.js
const assert = require('assert');
const path = require('path');
const FW = require(path.join(__dirname, '..', 'apps', 'aref_faultwatch', 'faults', 'watch.js'));
const { Trips, csv, RUN_KMH } = require(path.join(__dirname, '..', 'apps', 'aref_drivelog', 'log', 'trip.js'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- Fault Watch ---------- */
const scan = (obj, at, ecus) => {
    const m = new Map();
    Object.keys(obj).forEach((a) => m.set(Number(a), obj[a]));
    (ecus || []).forEach((a) => { if (!m.has(a)) m.set(a, []); });
    return FW.scanOf(m, at);
};

test('the first scan marks stored faults as found', () => {
    const s1 = scan({ 0x43: [{ code: '801234', status: 0x08 }] }, 1000);
    const ev = FW.compare(null, s1, {});
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].kind, 'found');
    assert.strictEqual(ev[0].ecu, '43');
});

test('new, active and cleared faults between scans, with context', () => {
    const s1 = scan({ 0x43: [{ code: '801234', status: 0x08 }], 0x37: [{ code: 'A1B2C3', status: 0x08 }] }, 1000);
    const s2 = scan({ 0x43: [{ code: '801234', status: 0x09 }], 0x06: [{ code: '030405', status: 0x09 }] }, 2000, [0x37]);
    const ctx = FW.contextOf({ speed: 103, rpm: 2850, gear: 6, oil: 96, driveMode: 'SPORT' });
    const ev = FW.compare(s1, s2, ctx);
    const kinds = ev.map((e) => e.kind + ':' + e.ecu).sort();
    assert.deepStrictEqual(kinds, ['active:43', 'gone:37', 'new:06']);
    assert.strictEqual(FW.contextText(ev[0].ctx, 'us'), '64 mph, gear 6, 2850 rpm, oil 205 F, SPORT');
});

test('a unit that did not answer keeps its faults (no false "cleared")', () => {
    const s1 = scan({ 0x43: [{ code: '801234', status: 0x08 }] }, 1000);
    const s2 = scan({ 0x12: [] }, 2000);
    const ev = FW.compare(s1, s2, {});
    assert.strictEqual(ev.length, 0);
    assert.strictEqual(s2.faults['43:801234'], 0x08);
});

test('status labels, worst first', () => {
    assert.strictEqual(FW.statusLabel(0x09), 'ACTIVE');
    assert.strictEqual(FW.statusLabel(0x88), 'WARNING LAMP');
    assert.strictEqual(FW.statusLabel(0x04), 'PENDING');
    assert.strictEqual(FW.statusLabel(0x08), 'STORED');
    assert.strictEqual(FW.statusLabel(0x00), 'HISTORY');
});

/* ---------- Drive Log ---------- */
/** Feed a speed profile: [[ms, kmh, extra], ...]. */
function drive(tr, profile) { profile.forEach((p) => tr.feed(Object.assign({ speed: p[1] }, p[2] || {}), p[0])); }

test('a drive with a 0-60 run, distance, peaks, and its end in P', () => {
    const tr = new Trips();
    const P = [[0, 0, { stage: 'P' }], [1000, 0, { stage: 'D' }]];
    // a launch: 0 to 100 km/h in 4 s (25 km/h per s), samples every 100 ms
    for (let i = 1; i <= 40; i++) P.push([1000 + i * 100, i * 2.5, { rpm: 2000 + i * 120, gLong: 0.6, oil: 95 }]);
    // cruise 100 km/h for 60 s
    for (let i = 1; i <= 600; i++) P.push([5000 + i * 100, 100, { rpm: 2200, gLat: i === 300 ? -0.45 : 0.05 }]);
    // brake to 0 in 4 s, then P for 31 s
    for (let i = 1; i <= 40; i++) P.push([65000 + i * 100, 100 - i * 2.5, { gLong: -0.8 }]);
    for (let i = 1; i <= 32; i++) P.push([69000 + i * 1000, 0, { stage: 'P' }]);
    drive(tr, P);
    assert.strictEqual(tr.current, null, 'the drive ended in P');
    assert.strictEqual(tr.trips.length, 1);
    const c = tr.trips[0];
    const expect060 = RUN_KMH / 25;              // ~3.86 s
    assert.ok(Math.abs(c.best060 - expect060) < 0.15, 'best 0-60 ' + c.best060);
    assert.ok(Math.abs(c.km - (100 * 60 / 3600 + 2 * (100 * 4 / 2 / 3600))) < 0.05, 'km ' + c.km);
    assert.strictEqual(c.topKmh, 100);
    assert.strictEqual(c.maxAccelG, 0.6);
    assert.strictEqual(c.maxBrakeG, 0.8);
    assert.strictEqual(c.maxLatG, 0.45);
    assert.strictEqual(c.oilMax, 95);
});

test('lifting during a launch cancels the 0-60', () => {
    const tr = new Trips();
    const P = [[0, 0]];
    for (let i = 1; i <= 20; i++) P.push([i * 100, i * 2.5]);          // to 50 km/h
    for (let i = 1; i <= 10; i++) P.push([2000 + i * 100, 50 - i]);   // lift to 40
    for (let i = 1; i <= 40; i++) P.push([3000 + i * 100, 40 + i * 2]); // to 120
    drive(tr, P);
    assert.strictEqual(tr.current.best060, null);
});

test('a short move in the driveway is not a drive', () => {
    const tr = new Trips();
    const P = [[0, 0]];
    for (let i = 1; i <= 10; i++) P.push([i * 1000, 8]);               // ~22 m
    for (let i = 1; i <= 35; i++) P.push([10000 + i * 1000, 0, { stage: 'P' }]);
    drive(tr, P);
    assert.strictEqual(tr.trips.length, 0);
    assert.strictEqual(tr.current, null);
});

test('a drive left open when the car switched off is kept on the next start, and CSV', () => {
    const tr = new Trips();
    const P = [[0, 0]];
    for (let i = 1; i <= 120; i++) P.push([i * 1000, 60]);
    drive(tr, P);
    const saved = JSON.parse(JSON.stringify(tr.state()));
    const tr2 = new Trips(saved);
    assert.strictEqual(tr2.trips.length, 1);
    const out = csv(tr2.trips, 'us').split('\n');
    assert.ok(out[0].indexOf('top_mph') > 0);
    assert.strictEqual(out[1].split(',')[4], '37');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok', name); } catch (e) { console.log('FAIL', name, '\n', e.stack); process.exitCode = 1; }
    }
    console.log(process.exitCode ? 'some tests failed' : tests.length + ' tests passed');
})();
