'use strict';
/**
 * ETA Bar 0.1 (probe): what the car's guidance services report while a route runs, so the next version
 * can put Apple Maps' arrival time in the cluster's bottom strip (between the clock and the drive mode),
 * where it shows a Waze route's ETA and Google Maps' street today.
 *
 * Watches CarPlay's guidance (ProjectedModeGuiding: waypoints = arrival, time and distance left, traffic;
 * currentRoad), BMW's navigation (Guidance: final / next / all destinations, state, provider, road) and
 * CarPlayManager's guidance flags. Every change goes to eta-probe.log in the data folder (the homelab
 * collects it); the screen shows the trip it would show and the raw values.
 *
 * Tests: see setState() below. Nothing else is written or called.
 * Node 8 only (the car's version). Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const R = require('./route');
const HW = require('./kit/homewidget');

const VERSION = '0.4.1';
const W = 1600, H = 520;
const LOG_MAX = 512 * 1024;     // eta-probe.log is moved to .1 past this
const TESTS_MAX = 256 * 1024;   // eta-tests.log: only tests, marks and starts, so a route's data never pushes them out
const NOISY_MS = 30000;         // a value that changes every second during a route (time left) is logged at most this often
const NOISY = /waypoints|DestinationInfo|travelled/;
const WATCH = [
    { iface: 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding', inst: 'Main_Instance', tag: 'carplay',
        fields: ['waypoints', 'currentRoad', 'activeRouteChange'] },
    { iface: 'de.bmw.infotainment.navigation.guiding.Guidance', inst: 'Main_Instance', tag: 'bmw',
        fields: ['finalDestinationInfo', 'nextDestinationInfo', 'allDestinationsInfo', 'guidanceState', 'guidingProvider', 'currentRoad', 'travelledDistance', 'travelledTime'] },
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', inst: 'CarPlayManagerInst1', tag: 'cpm',
        fields: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable'] },
];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const FILE = path.join(ctx.dataDir, 'eta-probe.log');
            const vals = {};              // 'tag.field' -> { v, at, n }
            const subs = [], proxies = {};
            const json = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
            const write = (line) => {
                try {
                    try { if (fs.statSync(FILE).size > LOG_MAX) fs.renameSync(FILE, FILE + '.1'); } catch (e) { /* none yet */ }
                    fs.appendFileSync(FILE, new Date().toISOString() + ' ' + line + '\n');
                } catch (e) { /* full disk: the screen still shows it */ }
            };
            const TESTS = path.join(ctx.dataDir, 'eta-tests.log');
            const note2 = (line) => {     // tests, marks and starts: also in their own file and the app log
                write(line);
                try { log.info(line); } catch (e) { /* no log */ }
                try {
                    try { if (fs.statSync(TESTS).size > TESTS_MAX) fs.renameSync(TESTS, TESTS + '.1'); } catch (e) { /* none yet */ }
                    fs.appendFileSync(TESTS, new Date().toISOString() + ' ' + line + '\n');
                } catch (e) { /* full disk */ }
            };
            note2('start ' + VERSION);

            const put = (key, v) => {
                const s = json(v), old = vals[key];
                if (old && old.s === s) return;
                const now = Date.now();
                vals[key] = { v: v, s: s, at: now, n: (old ? old.n : 0) + 1, logged: old ? old.logged : 0 };
                if (NOISY.test(key) && old && now - old.logged < NOISY_MS) return;   // shown on screen, logged every 30 s
                vals[key].logged = now;
                write(key + ' = ' + (s.length > 4000 ? s.slice(0, 4000) + '...(' + s.length + ')' : s));
            };
            WATCH.forEach((w) => {
                const handlers = {};
                w.fields.forEach((f) => { handlers[f] = guard(w.tag + '.' + f, (v) => put(w.tag + '.' + f, v)); });
                ctx.signals.watch(w.iface, w.inst, handlers, log, { pollMs: 15000 }).then((sub) => {
                    subs.push({ tag: w.tag, available: sub.available, error: sub.error });
                    if (sub.proxy) proxies[w.tag] = sub.proxy;
                    write('subscribed ' + w.tag + ': ' + (sub.available ? 'available' : 'not available') + (sub.error ? ' (' + sub.error + ')' : ''));
                }, (e) => { subs.push({ tag: w.tag, available: false, error: e.message }); write('subscribe ' + w.tag + ' failed: ' + e.message); });
            });

            const val = (k) => (vals[k] ? vals[k].v : undefined);
            const trip = () => R.pick({ waypoints: val('carplay.waypoints'), finalDestinationInfo: val('bmw.finalDestinationInfo'),
                nextDestinationInfo: val('bmw.nextDestinationInfo'), allDestinationsInfo: val('bmw.allDestinationsInfo') });
            const guiding = () => val('cpm.projectedGuidanceActive') === true;
            // the guidance state as the car reports it right now, for the test and mark lines
            const snapshot = () => ['bmw.guidanceState', 'bmw.guidingProvider', 'bmw.currentRoad', 'carplay.currentRoad', 'cpm.projectedGuidanceActive']
                .map((k) => k + '=' + (vals[k] ? vals[k].s : '-')).join(' ');

            let page = 0;
            ui.onClick('BTN_MORE', guard('more', () => { page++; }));
            ui.onClick('BTN_SAVE', guard('mark', () => { note2('MARK (button) ' + snapshot()); }));
            /*
             * The test (0.4). 0.3 showed: ProjectedModeGuiding.setGuidanceState(ACTIVE, CAR_PLAY) with no route hides the
             * street, the same as a real Apple Maps route; during a route it changes nothing (Apple Maps already set that).
             * So the strip is in guidance mode, but it shows an ETA only for a route it thinks is BMW's own. Test A sends
             * ACTIVE with provider NONE, Test B with OTHER, during an Apple Maps route, to see whether the strip then reads
             * Guidance.finalDestinationInfo (which holds the phone's ETA). Test: reset sends what the car had: ACTIVE,
             * CAR_PLAY while CarPlay guides, else INACTIVE, NONE. Ending the route resets it as well.
             */
            let note = null;
            const say = (text) => { note = { text: text, until: Date.now() + 9000 }; };
            const setState = (state, provider, label) => {
                if (!proxies.carplay) { say('Not connected to CarPlay guidance yet'); note2('TEST no proxy'); return; }
                note2('TEST ' + label + ': setGuidanceState ' + state + ', ' + provider + ' (CarPlay guiding: ' + guiding() + ')');
                ctx.signals.call(proxies.carplay, 'setGuidanceState', { guidanceState: state, guidingProvider: provider }).then(
                    (r) => { note2('TEST ' + label + ' accepted ' + json(r)); setTimeout(guard('after', () => note2('TEST ' + label + ' 3 s later: ' + snapshot())), 3000); say(label + ': sent ' + state + ', ' + provider + ' - look at the strip, then tap Mark in log'); },
                    (e) => { note2('TEST ' + label + ' failed: ' + (e && e.message || e)); say('The car refused it: ' + (e && e.message || e)); });
            };
            ui.onClick('BTN_TEST', guard('test a', () => setState('ACTIVE', 'NONE', 'Test A')));
            ui.onClick('BTN_TEST2', guard('test b', () => setState('ACTIVE', 'OTHER', 'Test B')));
            ui.onClick('BTN_OFF', guard('test reset', () => (guiding() ? setState('ACTIVE', 'CAR_PLAY', 'Reset') : setState('INACTIVE', 'NONE', 'Reset'))));

            const fit = (cv, s, size, w, opt) => {
                s = String(s || '');
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            const TC = { green: '#2fd27a', yellow: '#ffb31a', red: '#ff3b30' };
            ctx.loop('MAIN', 2, guard('draw', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), L = { literal: true }, B = { font: 'bold', literal: true };
                const r = trip(), now = Date.now();
                // the trip, as the bottom strip would show it
                if (r) {
                    cv.text(R.arrivalText(r, now) || '--', 40, 110, 72, t.text, B);
                    cv.text('arrival', 40, 140, 20, t.dim, L);
                    const parts = [R.leftText(r.travelSec), r.dist ? r.dist + ' ' + (r.unit || '') : null].filter(Boolean).join('   ·   ');
                    cv.text(parts || '', 420, 100, 40, t.text, B);
                    if (r.traffic) { cv.circle(430, 135, 9, TC[r.traffic]); cv.text((r.delaySec ? '+' + R.leftText(r.delaySec) + ' traffic' : 'traffic ' + r.traffic), 450, 142, 20, t.dim, L); }
                    cv.text('from ' + (r.src === 'carplay' ? 'CarPlay' : 'BMW navigation'), W - 40, 60, 18, t.dim, { align: 'right', literal: true });
                } else {
                    cv.text(guiding() ? 'CarPlay is guiding, but sends no arrival data' : 'No route', 40, 100, 40, t.text, B);
                    cv.text(guiding() ? 'Logging everything it does send. Drive a bit, then check the log.' : 'Start a route in Apple Maps, Waze or Google Maps on CarPlay.', 40, 140, 20, t.dim, L);
                }
                // the raw values: the probe
                const keys = Object.keys(vals).sort();
                const rows = keys.map((k) => k + ' = ' + vals[k].s + '  (' + vals[k].n + ')');
                subs.forEach((s) => { if (!s.available) rows.push(s.tag + ': not available' + (s.error ? ' - ' + s.error : '')); });
                if (!rows.length) rows.push('Waiting for the car...');
                const PER = 11, pages = Math.max(1, Math.ceil(rows.length / PER)), pg = page % pages;
                cv.fillRect(40, 168, W - 80, 1, t.dim);
                rows.slice(pg * PER, pg * PER + PER).forEach((s, i) => cv.text(fit(cv, s, 17, W - 80, L), 40, 196 + i * 27, 17, i % 2 ? t.dim : t.text, L));
                cv.text('Page ' + (pg + 1) + ' of ' + pages + (pages > 1 ? ' (More)' : '') + '   ·   Every change is saved to eta-probe.log', W - 40, H - 14, 15, t.dim, { align: 'right', literal: true });
                if (note && Date.now() < note.until) cv.text(fit(cv, note.text, 22, W - 80, B), 40, H - 14, 22, t.accent2 || t.text, B);
                await ui.image('MAIN_GFX', cv);
            }));

            HW.start(ctx, () => {
                const r = trip(), now = Date.now();
                if (!r) return { label: 'ETA', value: 'No route', sub: guiding() ? 'CarPlay sends no arrival data' : 'Start a route on CarPlay', small: ['ETA', 'No route'] };
                const a = R.arrivalText(r, now) || '--', left = [R.leftText(r.travelSec), r.dist ? r.dist + ' ' + (r.unit || '') : null].filter(Boolean).join(' · ');
                return { label: 'Arrival', value: a, sub: left, sub2: r.src === 'carplay' ? 'CarPlay' : 'BMW navigation',
                    tone: r.traffic === 'red' ? 'crit' : r.traffic === 'yellow' ? 'warn' : 'ok', small: ['Arrival ' + a, left] };
            });
            log.info('started ' + VERSION);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
