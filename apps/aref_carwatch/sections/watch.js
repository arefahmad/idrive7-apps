'use strict';
/**
 * watch.js - Fault Watch's logic, with no car in it (so it can be tested on a PC).
 *
 * A scan is { at, faults: { "<ecu hex>:<code>": status byte } }. compare(prev, next, ctx) lists what changed:
 *   new      a fault that wasn't in the previous scan
 *   active   a fault that is failing right now and wasn't at the previous scan (status bit 0)
 *   gone     a fault that was in the previous scan and isn't any more (cleared, or aged out)
 *   found    every fault of the very first scan (what was already stored before watching began)
 * Each event carries the drive context at the scan (speed, gear, rpm, temperatures, drive mode), which is
 * the point: a fault that comes and goes (a headlight dropping, the bass cutting out) gets a time and the
 * conditions it happened in.
 *
 * Node 8: no ?., ??, object spread or optional catch binding.
 */

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');

/** ISO 14229 status byte -> the label shown (worst first). */
function statusLabel(b) {
    if (b & 0x01) return 'ACTIVE';
    if (b & 0x80) return 'WARNING LAMP';
    if (b & 0x04) return 'PENDING';
    if (b & 0x08) return 'STORED';
    return 'HISTORY';
}

/** One scan from parsed replies: byEcu = Map(address -> [{ code, status }]); ecus = the units that answered. */
function scanOf(byEcu, at) {
    const faults = {}, ecus = [];
    byEcu.forEach((list, addr) => { ecus.push(hex(addr)); list.forEach((d) => { faults[hex(addr) + ':' + d.code] = d.status; }); });
    return { at: at || Date.now(), faults, ecus };
}

/** The drive context kept with an event, from Car.data(): only what was live. */
function contextOf(d) {
    const c = {};
    if (!d) return c;
    if (isFinite(d.speed)) c.kmh = Math.round(d.speed);
    if (isFinite(d.rpm)) c.rpm = Math.round(d.rpm);
    if (d.gear !== undefined && d.gear !== null) c.gear = d.gear;
    if (d.stage) c.stage = d.stage;
    if (isFinite(d.oil)) c.oil = Math.round(d.oil);
    if (isFinite(d.coolant)) c.coolant = Math.round(d.coolant);
    if (d.driveMode) c.mode = d.driveMode;
    return c;
}

/** What changed from prev to next: [{ at, kind, ecu, code, status, label, ctx }]. prev null: everything is new. */
function compare(prev, next, ctx) {
    const out = [];
    const before = (prev && prev.faults) || {}, now = next.faults;
    Object.keys(now).forEach((k) => {
        const s = now[k], p = before[k], parts = k.split(':');
        const ev = { at: next.at, ecu: parts[0], code: parts[1], status: s, label: statusLabel(s), ctx: ctx || {} };
        if (p === undefined) out.push(Object.assign({ kind: prev ? 'new' : 'found' }, ev));
        else if ((s & 0x01) && !(p & 0x01)) out.push(Object.assign({ kind: 'active' }, ev));
    });
    Object.keys(before).forEach((k) => {
        if (now[k] !== undefined) return;
        const parts = k.split(':');
        // a unit that didn't answer this scan (asleep, busy) hasn't cleared anything
        if (next.ecus && next.ecus.indexOf(parts[0]) < 0) { now[k] = before[k]; return; }
        out.push({ at: next.at, kind: 'gone', ecu: parts[0], code: parts[1], status: before[k], label: statusLabel(before[k]), ctx: ctx || {} });
    });
    return out;
}

/** "64 mph, 3rd, 2,850 rpm, oil 96 °C, SPORT" from a context (units: 'us' or 'metric'). */
function contextText(c, units) {
    const us = units !== 'metric', parts = [];
    if (c.kmh !== undefined) parts.push(c.kmh < 2 ? 'stopped' : (us ? Math.round(c.kmh * 0.621371) + ' mph' : c.kmh + ' km/h'));
    if (c.stage === 'P') parts.push('in P');
    else if (c.gear > 0) parts.push('gear ' + c.gear);
    if (c.rpm !== undefined && c.rpm > 0) parts.push(c.rpm + ' rpm');
    if (c.oil !== undefined) parts.push('oil ' + (us ? Math.round(c.oil * 1.8 + 32) + ' F' : c.oil + ' C'));
    if (c.mode) parts.push(c.mode);
    return parts.join(', ') || 'no drive data';
}

/** Keep the newest max events. */
function trim(events, max) { return events.length > max ? events.slice(events.length - max) : events; }

module.exports = { statusLabel, scanOf, contextOf, compare, contextText, trim, hex };
