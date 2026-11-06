'use strict';
/**
 * Fault Watch: reads every control unit's fault memory in the background, every few minutes while the car
 * is on, and keeps a timeline of what changed: a new fault, one that turned active, one that cleared. Each
 * entry has the time and the drive at that moment (speed, gear, rpm, oil, drive mode), so a fault that
 * comes and goes can be matched to when it happened.
 *
 * Read-only: the only request it sends is UDS 19 02 (ReadDTCInformation, report by status mask), to all
 * units at once, as BMW's own testers and the Fault Scanner do. It never clears a fault and never writes.
 *
 * Node 8 only (the car's version). Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { Diag, parseDtcReply } = require('./kit/diag');
const { ECU } = require('./kit/ecus');
const FW = require('./watch');

const VERSION = '0.1.0';
const W = 1600, H = 520;
const MASK = 0x0D;                 // status bits asked for: test failed now (0x01), pending (0x04), confirmed (0x08)
const FIRST_SCAN_MS = 90000;       // after the app starts: let the car's units settle after waking
const MAX_EVENTS = 500;
const ROWS = 7;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const FILE = path.join(ctx.dataDir, 'faultwatch.json');
            let state = { last: null, events: [], scans: 0 };
            try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first run */ }
            const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { log.warn('save: ' + e.message); } };

            const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear', 'drivemode'], { demo: false });
            const diag = new Diag(ctx.signals, log);
            diag.quiet = true; diag.busyLog = false;
            await diag.init();

            let busy = false, status = 'Waiting for the first scan', nextAt = Date.now() + FIRST_SCAN_MS, view = 'timeline', page = 0;
            const everyMs = () => (Number(settings.get('every')) || 10) * 60000;
            const units = () => settings.get('units') || 'us';
            const name = (ecuHex) => ECU[parseInt(ecuHex, 16)] || 'ECU 0x' + ecuHex;

            /** The one request this app sends: 19 02 <mask> to every unit (read-only). */
            async function readFaults() {
                const params = [0x02, MASK];
                const replies = await diag.functional(0x19, params, { idleMs: 4000, maxMs: 25000 });
                const byEcu = new Map();
                replies.forEach((uds, addr) => {
                    const p = parseDtcReply(uds, params);
                    byEcu.set(addr, p.ok ? p.dtcs : []);
                });
                return byEcu;
            }

            async function scan(why) {
                if (busy) return;
                if (!diag.p) { status = 'No diagnostic link: ' + (diag.error || 'not ready'); return; }
                busy = true; status = 'Scanning (' + why + ')...';
                try {
                    const byEcu = await readFaults();
                    if (!byEcu.size) { status = 'No control unit answered (ignition off?)'; return; }
                    const next = FW.scanOf(byEcu, Date.now());
                    const ev = FW.compare(state.last, next, FW.contextOf(car.data()));
                    ev.forEach((e) => log.info('fault ' + e.kind + ': ' + name(e.ecu) + ' ' + e.code + ' ' + e.label + ' (' + FW.contextText(e.ctx, units()) + ')'));
                    state.events = FW.trim(state.events.concat(ev), MAX_EVENTS);
                    state.last = next; state.scans++;
                    save();
                    status = 'Last scan ' + clock(next.at) + ': ' + next.ecus.length + ' units, ' + Object.keys(next.faults).length + ' faults' + (ev.length ? ', ' + ev.length + ' changes' : '');
                    page = 0;
                } catch (e) {
                    status = 'Scan failed: ' + e.message;
                    log.warn('scan: ' + e);
                } finally {
                    busy = false;
                    nextAt = Date.now() + everyMs();
                }
            }
            setInterval(guard('timer', () => { if (Date.now() >= nextAt && !busy) scan('timer'); }), 5000);
            ui.onClick('BTN_SCAN', guard('scan', () => { scan('asked'); }));
            ui.onClick('BTN_VIEW', guard('view', () => {
                view = view === 'timeline' ? 'current' : 'timeline'; page = 0;
                ui.text('BTN_VIEW', view === 'timeline' ? 'Current faults' : 'Timeline');
            }));
            ui.onClick('BTN_MORE', guard('more', () => { page++; }));

            /* ---------- drawing ---------- */
            const clock = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
            const fit = (cv, s, size, w, opt) => {
                s = String(s || '');
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            const KIND = { new: ['NEW', '#ffb31a'], active: ['ACTIVE', '#ff3b30'], gone: ['CLEARED', '#2fd27a'], found: ['ALREADY STORED', '#8e9199'] };
            ctx.loop('MAIN', 2, guard('draw', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), L = { literal: true };
                cv.text(view === 'timeline' ? 'Timeline' : 'Current faults', 40, 50, 30, t.text, { font: 'bold', literal: true });
                const next = busy ? '' : '  ·  next ' + clock(nextAt);
                cv.text(fit(cv, status + next, 18, W - 400, L), W - 40, 50, 18, t.dim, { align: 'right', literal: true });
                let rows = [];
                if (view === 'timeline') {
                    rows = state.events.slice().reverse().map((e) => ({ badge: KIND[e.kind] || [e.kind, t.dim], a: name(e.ecu) + '  ' + e.code + '  ' + e.label, b: clock(e.at) + '  ·  ' + FW.contextText(e.ctx, units()) }));
                    if (!rows.length) rows.push({ badge: null, a: 'Nothing yet.', b: 'The first scan runs about 90 s after the app starts, then every ' + (settings.get('every') || 10) + ' min.' });
                } else {
                    const f = (state.last && state.last.faults) || {};
                    rows = Object.keys(f).sort().map((k) => { const p = k.split(':'); return { badge: [FW.statusLabel(f[k]), f[k] & 0x01 ? '#ff3b30' : '#ffb31a'], a: name(p[0]) + '  ' + p[1], b: 'Look the code up in ProTool or ISTA for its text' }; });
                    if (!rows.length) rows.push({ badge: null, a: state.last ? 'No faults stored.' : 'No scan yet.', b: '' });
                }
                const pages = Math.max(1, Math.ceil(rows.length / ROWS)), pg = page % pages;
                rows.slice(pg * ROWS, pg * ROWS + ROWS).forEach((r, i) => {
                    const y = 100 + i * 58;
                    let x = 40;
                    if (r.badge) {
                        const bw = cv.textWidth(r.badge[0], 14, { font: 'bold', literal: true }) + 20;
                        cv.roundRect(x, y - 2, bw, 24, 12, r.badge[1]);
                        cv.text(r.badge[0], x + bw / 2, y + 15, 14, '#000000', { font: 'bold', align: 'center', literal: true });
                        x += bw + 14;
                    }
                    cv.text(fit(cv, r.a, 22, W - x - 40, L), x, y + 17, 22, t.text, L);
                    if (r.b) cv.text(fit(cv, r.b, 17, W - 80, L), 40, y + 44, 17, t.dim, L);
                });
                if (pages > 1) cv.text('Page ' + (pg + 1) + ' of ' + pages + ' (More)', W - 40, H - 14, 16, t.dim, { align: 'right', literal: true });
                await ui.image('MAIN_GFX', cv);
            }));
            log.info('started ' + VERSION + ' (' + state.events.length + ' events kept, ' + state.scans + ' scans so far)');
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
