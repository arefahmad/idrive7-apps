'use strict';
// Tire Setup's decoder and its DSC guard (apps/aref_tires/tires/decode.js): node test/tires.test.js
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'apps', 'aref_tires', 'tires', 'decode.js'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('every action leaves the DSC member at SIGNAL_UNGUELTIG (no request)', () => {
    Object.keys(T.ACTIONS).forEach((a) => {
        const s = T.build(a, 3);
        assert.strictEqual(s.operationModeTractionDSC, 'SIGNAL_UNGUELTIG', a);
        assert.ok(T.check(s));
    });
});

test('check() refuses any DSC request, an unknown member or a missing one', () => {
    ['DSC_AUSSCHALTEN', 'DSC_EINSCHALTEN', 'TRAKTIONSMODUS_EINSCHALTEN', 1, 0, undefined].forEach((v) => {
        assert.throws(() => T.check(Object.assign({}, T.NO_ACTION, { operationModeTractionDSC: v })), /DSC/);
    });
    assert.throws(() => T.check(Object.assign({}, T.NO_ACTION, { extra: 1 })), /unknown/);
    const m = Object.assign({}, T.NO_ACTION); delete m.operationIDRSelection;
    assert.throws(() => T.check(m), /missing/);
});

test('NO_ACTION is frozen, so no write can change the template', () => {
    assert.throws(() => { 'use strict'; T.NO_ACTION.operationModeTractionDSC = 'DSC_AUSSCHALTEN'; });
    assert.strictEqual(T.NO_ACTION.operationModeTractionDSC, 'SIGNAL_UNGUELTIG');
});

test('only the members an action names change', () => {
    const s = T.build('reset');
    Object.keys(T.NO_ACTION).forEach((k) => { if (k !== 'operationTyrePressureControl') assert.strictEqual(s[k], T.NO_ACTION[k], k); });
    assert.strictEqual(s.operationTyrePressureControl, 'RDC_S_RPA_SETZEN');
    const p = T.build('pick', 2);
    assert.strictEqual(p.operationIDRSelection, 'MANUELLE_AUSWAHL');
    assert.strictEqual(p.operationSelectionTyreAvailable, 2);
});

test('the car\'s raw values: 0.1 psi, raw - 40 F, 65533 = target not set', () => {
    assert.deepStrictEqual(T.pressures({ actualValuePressureTyreFLH: 400, actualValuePressureTyreFRH: 410, actualValuePressureTyreRLH: 380, actualValuePressureTyreRRH: 370 }),
        { FLH: 40, FRH: 41, RLH: 38, RRH: 37 });
    assert.deepStrictEqual(T.targets({ targetPressureTyreFLH: 65533, targetPressureTyreFRH: 65533, targetPressureTyreRLH: 65533, targetPressureTyreRRH: 65533 }),
        { FLH: null, FRH: null, RLH: null, RRH: null });
    assert.strictEqual(T.temps({ actualValueTemperatureTyreFLH: 94 }).FLH, 54);
});

test('why auto detect fails, in plain English', () => {
    const d = T.detection({ statusWheelTypeChangeDetection: 'RDC_DEGRADIERT_KEIN_PASSENDER_REIFEN_GEFUNDEN' });
    assert.strictEqual(d.title, 'No matching tire found');
    assert.strictEqual(d.tone, 'bad');
    assert.strictEqual(T.dsc({ displayStatusDSC2: 'DSC_AUS' }).state, 'off');
});

test('the tire list: the car sends size steps (its own list, Nov 12)', () => {
    const e = (w, r, d, sp, season, id) => T.listEntry({ widthTypeTyre: w, relationSideTypeTyre: r, radiusTypeTyre: d, indexSpeedTypeTyre: sp,
        carcassTypeTyre: 'REIFEN_XL', seasonTypeTyre: season, runflatTypeTyre: 'NON_MINUS_RUNFLAT', statusTyreObjectListID: id });
    assert.strictEqual(e(13, 6, 7, 'H', 'WINTERREIFEN', 1).text, '225/45R18 H · XL · winter');
    assert.strictEqual(e(16, 5, 7, 'Y', 'SOMMERREIFEN', 3).text, '255/40R18 Y · XL · summer');
    assert.strictEqual(e(16, 4, 8, 'Y', 'SOMMERREIFEN', 4).size, '255/35R19 Y');
    assert.strictEqual(T.rearAxle({ widthBackAxleTypeTyre: 16, relationSideBackAxleTypeTyre: 5, radiusBackAxleTypeTyre: 7, indexSpeedBackAxleTypeTyre: 'Y' }).size, '255/40R18 Y');
    assert.strictEqual(T.frontAxle({ widthFrontAxleTypeTyre: 0 }), null);
});

let failed = 0;
tests.forEach(([name, fn]) => {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
});
if (failed) { console.log(failed + ' failed'); process.exit(1); }
