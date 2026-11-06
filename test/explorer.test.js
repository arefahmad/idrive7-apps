'use strict';
// Plain-Node tests for Car Explorer's catalog search (not installed on the car).  node test/explorer.test.js
const assert = require('assert');
const path = require('path');
const CAT = require(path.join(__dirname, '..', 'apps', 'aref_explorer', 'explore', 'catalog.js'));

const db = { interfaces: {
    'de.x.lighting.InteriorLight': { attributes: { statusAmbientLightColour: { getter: true, type: 'Rgb' }, statusLightProfile: {} }, methods: ['setAmbientLightColour'] },
    'de.x.vehicle.Vehicle2': { attributes: { statusCarSpeed2: { getter: true } } },
    'de.x.navigation.Guidance': { attributes: { remainingDistance: {}, estimatedTimeOfArrival: {} }, broadcasts: ['maneuverUpdate'] },
    'de.x.hmi.Personalisation': { attributes: { ambientLightSettings: {} } },
} };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('member names only, not their descriptions', () => {
    const names = CAT.namesIn(db.interfaces['de.x.lighting.InteriorLight']);
    assert.deepStrictEqual(names, { statusAmbientLightColour: 'field', statusLightProfile: 'field', setAmbientLightColour: 'method' });
});
ok('ambient light: both interfaces, the lighting one first', () => {
    const r = CAT.search(db, CAT.TOPICS.ambient);
    assert.deepStrictEqual(r.map((h) => h.iface), ['de.x.lighting.InteriorLight', 'de.x.hmi.Personalisation']);
    assert.strictEqual(r[0].methods, 1);
});
ok('route guidance finds the ETA fields', () => {
    const r = CAT.search(db, CAT.TOPICS.route);
    assert.strictEqual(r[0].iface, 'de.x.navigation.Guidance');
    assert.ok(r[0].names.some((x) => x[0] === 'estimatedTimeOfArrival'));
});
ok('the report covers every topic', () => {
    const t = CAT.report(db, 4);
    CAT.ORDER.forEach((k) => assert.ok(t.indexOf('==== ' + CAT.TOPICS[k].name) >= 0));
});
console.log(n + ' tests passed');
ok('members with their descriptions, fields first', () => {
    const m = CAT.membersOf(db.interfaces['de.x.lighting.InteriorLight']);
    assert.deepStrictEqual(m.map((x) => x[0] + ':' + x[1]), ['statusAmbientLightColour:field', 'statusLightProfile:field', 'setAmbientLightColour:method']);
    assert.deepStrictEqual(m[0][2], { getter: true, type: 'Rgb' });
});
console.log('membersOf ok');
