'use strict';
/**
 * Drive Log: records every drive in the background (it starts with the car) and keeps its numbers:
 * distance, time moving, top speed, best 0-60 mph, peak rpm, the most acceleration, braking and cornering
 * g, and the highest oil and coolant temperatures. "This drive" shows the drive going on (or the last one),
 * "History" the ones before, and Save CSV writes them all to drives.csv in the app's data folder.
 *
 * Read-only: it only listens to the car's own driving signals (speed, rpm, g-forces, temperatures, gear).
 *
 * Node 8 only (the car's version). Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { Trips, csv } = require('./trip');

const VERSION = '0.1.0';
const W = 1600, H = 520;
const SAVE_MS = 30000;
const ROWS = 7;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const FILE = path.join(ctx.dataDir, 'drivelog.json'), CSV = path.join(ctx.dataDir, 'drives.csv');
            let saved = null;
            try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first run */ }
            const tr = new Trips(saved);
            let dirty = !!(saved && saved.current);
            const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(tr.state())); dirty = false; } catch (e) { log.warn('save: ' + e.message); } };
            if (dirty) save();

            const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear'], { demo: false });
            let had = !!tr.current;
            car.onSample(guard('sample', (d, t) => {
                const before = tr.trips.length;
                tr.feed(d, t || Date.now());
                if (tr.current) dirty = true;
                if (tr.current && !had) log.info('drive started');
                if (tr.trips.length > before) { const c = tr.trips[tr.trips.length - 1]; log.info('drive ended: ' + c.km + ' km, top ' + c.topKmh + ' km/h, best 0-60 ' + c.best060); save(); }
                had = !!tr.current;
            }));
            setInterval(guard('save', () => { if (dirty) save(); }), SAVE_MS);
            // the car switching off stops the app: close the drive with it
            process.once('exit', () => { try { if (tr.current) { tr.end(Date.now()); fs.writeFileSync(FILE, JSON.stringify(tr.state())); } } catch (e) { /* too late */ } });

            let view = 'drive', page = 0, toast = null;
            ui.onClick('BTN_VIEW', guard('view', () => { view = view === 'drive' ? 'history' : 'drive'; page = 0; ui.text('BTN_VIEW', view === 'drive' ? 'History' : 'This drive'); }));
            ui.onClick('BTN_MORE', guard('more', () => { page++; }));
            ui.onClick('BTN_EXPORT', guard('export', () => {
                fs.writeFileSync(CSV, csv(tr.trips.concat(tr.current ? [tr.current] : []), settings.get('units')));
                toast = { text: 'Saved ' + (tr.trips.length + (tr.current ? 1 : 0)) + ' drives to drives.csv', until: Date.now() + 4000 };
            }));

            /* ---------- units and text ---------- */
            const us = () => settings.get('units') !== 'metric';
            const dist = (km) => (us() ? (km * 0.621371).toFixed(1) + ' mi' : km.toFixed(1) + ' km');
            const spd = (kmh) => (us() ? Math.round(kmh * 0.621371) + ' mph' : Math.round(kmh) + ' km/h');
            const temp = (c) => (c === null || c === undefined ? '-' : us() ? Math.round(c * 1.8 + 32) + ' F' : Math.round(c) + ' C');
            const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };
            const when = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
            const g = (x) => (x ? x.toFixed(2) + ' g' : '-');

            ctx.loop('MAIN', 4, guard('draw', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), L = { literal: true };
                if (view === 'drive') {
                    const c = tr.current || tr.trips[tr.trips.length - 1];
                    cv.text(tr.current ? 'This drive' : c ? 'Last drive' : 'No drives yet', 40, 50, 30, t.text, { font: 'bold', literal: true });
                    if (c) cv.text(when(c.start) + (tr.current ? '  ·  driving' : '  to  ' + when(c.end)), W - 40, 50, 18, t.dim, { align: 'right', literal: true });
                    if (!c) cv.text('Drive Log starts with the car and records each drive by itself.', 40, 100, 22, t.dim, L);
                    else {
                        const tiles = [
                            ['DISTANCE', dist(c.km)], ['MOVING', dur(c.movingMs)], ['TOP SPEED', spd(c.topKmh)],
                            ['BEST 0-60', c.best060 === null ? '-' : c.best060.toFixed(2) + ' s'], ['PEAK RPM', c.peakRpm ? Math.round(c.peakRpm) + '' : '-'],
                            ['ACCEL', g(c.maxAccelG)], ['BRAKING', g(c.maxBrakeG)], ['CORNERING', g(c.maxLatG)],
                            ['OIL MAX', temp(c.oilMax)], ['COOLANT MAX', temp(c.coolantMax)],
                        ];
                        const cw = (W - 80) / 5;
                        tiles.forEach((x, i) => {
                            const cx = 40 + (i % 5) * cw, cy = 90 + Math.floor(i / 5) * 190;
                            cv.roundRect(cx + 6, cy, cw - 12, 170, 16, t.panelTop || '#17181c');
                            cv.text(x[0], cx + cw / 2, cy + 44, 16, t.dim, { font: 'bold', align: 'center', literal: true });
                            cv.text(x[1], cx + cw / 2, cy + 112, 40, t.text, { font: 'bold', align: 'center', literal: true });
                        });
                    }
                    const best = tr.best060();
                    if (best !== null) cv.text('All-time best 0-60: ' + best.toFixed(2) + ' s (car speed, not GPS)', 40, H - 14, 16, t.dim, L);
                } else {
                    cv.text('History', 40, 50, 30, t.text, { font: 'bold', literal: true });
                    cv.text(tr.trips.length + ' drives kept', W - 40, 50, 18, t.dim, { align: 'right', literal: true });
                    const rows = tr.trips.slice().reverse();
                    const pages = Math.max(1, Math.ceil(rows.length / ROWS)), pg = page % pages;
                    if (!rows.length) cv.text('Finished drives show up here.', 40, 100, 22, t.dim, L);
                    rows.slice(pg * ROWS, pg * ROWS + ROWS).forEach((c, i) => {
                        const y = 100 + i * 52;
                        cv.text(when(c.start), 40, y + 20, 22, t.text, L);
                        cv.text(dist(c.km) + '   ' + dur(c.movingMs) + '   top ' + spd(c.topKmh) + '   0-60 ' + (c.best060 === null ? '-' : c.best060.toFixed(2) + ' s') + '   oil ' + temp(c.oilMax), 300, y + 20, 22, t.dim, L);
                    });
                    if (pages > 1) cv.text('Page ' + (pg + 1) + ' of ' + pages + ' (More)', W - 40, H - 14, 16, t.dim, { align: 'right', literal: true });
                }
                if (toast && Date.now() < toast.until) {
                    const w = cv.textWidth(toast.text, 22, L) + 60;
                    cv.roundRect((W - w) / 2, H - 66, w, 46, 23, '#2a2b31');
                    cv.text(toast.text, W / 2, H - 36, 22, '#ffffff', { align: 'center', literal: true });
                }
                await ui.image('MAIN_GFX', cv);
            }));
            log.info('started ' + VERSION + ' (' + tr.trips.length + ' drives kept)');
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
