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
 * 1.0: the ETA is drawn on the cluster itself, in the bottom strip's blank space (strip.js, through the Cluster
 * renderer tool), because BMW's strip shows no ETA for a CarPlay route and no guidance value changes that
 * (0.2-0.4 tested them). Nothing is written to or called on the car's services: they are only read.
 * Node 8 only (the car's version). Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const R = require('./route');
const HW = require('./kit/homewidget');
const { Strip } = require('./strip');
const LOOK = require('./look');
const { setImage } = require('./kit/record');

const VERSION = '1.2.0';
const W = 1600, H = 520;
const LOG_MAX = 512 * 1024;     // eta-probe.log is moved to .1 past this
const TESTS_MAX = 256 * 1024;   // eta-tests.log: only tests, marks and starts, so a route's data never pushes them out
const NOISY_MS = 30000;         // a value that changes every second during a route (time left) is logged at most this often
const NOISY = /waypoints|DestinationInfo|travelled/;
const ROUTE = /^(carplay\.waypoints|cpm\.)/;
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
        // the kit's header, bar and sheets in Apple's dark colours on pure black (the HMI's own black: no seam)
        const base = require('./kit/themes').theme('m_tricolour');
        const CARPLAY = Object.assign({}, base, { name: 'CarPlay', bg: '#000000', panelTop: '#1c1c1e', panelBottom: '#1c1c1e', panelEdge: '#38383a',
            track: '#2c2c2e', tick: '#636366', text: '#ffffff', dim: '#98989f', accent: '#0a84ff', accent2: '#64d2ff', ok: '#30d158', warn: '#ff9f0a',
            crit: '#ff453a', sel: '#0a84ff', selText: '#ffffff', marker: '#0a84ff', glow: '#0a84ff40', stripes: ['#0a84ff'] });
        if (ctx.setTheme) ctx.setTheme(() => CARPLAY);
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

            let onRoute = null;
            const put = (key, v) => {
                const s = json(v), old = vals[key];
                if (old && old.s === s) return;
                const now = Date.now();
                vals[key] = { v: v, s: s, at: now, n: (old ? old.n : 0) + 1, logged: old ? old.logged : 0 };
                if (ROUTE.test(key) && onRoute) onRoute();          // the cluster ETA follows each update at once (a reroute too)
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
            // guiding, and the phone still sends the route: when Apple Maps stops sending it (metadata false) the last
            // ETA would go stale, so it hides rather than show an old one
            const guiding = () => val('cpm.projectedGuidanceActive') === true && val('cpm.projectedGuidanceMetadataAvailable') !== false;

            let page = 0;
            let diag = false;
            ui.onClick('BTN_MORE', guard('diagnostics', () => { if (!diag) { diag = true; page = 0; } else page++; }));
            ui.onClick('BTN_BACK', guard('back', () => { diag = false; }));
            // the ETA on the cluster (strip.js)
            let note = null;
            const say = (text) => { note = { text: text, until: Date.now() + 6000 }; };
            const strip = new Strip(ctx, note2);
            strip.start();
            const stripRoute = () => {
                const r = trip();
                return guiding() && r && r.src === 'carplay' ? r : null;   // BMW's strip is blank only during a CarPlay route
            };
            const style = () => {
                const g = (k, d) => { const v = ctx.settings.get(k); return v === undefined || v === null ? d : v; };
                const D = LOOK.DEFAULT_STYLE;
                return { look: g('look', D.look), layout: g('layout', D.layout), traffic: !!g('traffic', D.traffic), ampm: !!g('ampm', D.ampm),
                    arrival: !!g('show_arrival', D.arrival), minutes: !!g('show_minutes', D.minutes), distance: !!g('show_distance', D.distance) };
            };
            strip.setStyle(style());
            ctx.settings.onChange(guard('style', () => strip.setStyle(style())));
            onRoute = guard('strip', () => { const r = stripRoute(); strip.update(r, r ? R.arrivalText(r, Date.now()) : null); });
            setInterval(onRoute, 1000);
            const placed = () => say('Moved. Showing a preview on the cluster for 30 seconds.');
            ui.onClick('BTN_TOGGLE', guard('toggle', () => { strip.toggle(); say(strip.cfg.on ? 'The ETA will show on the cluster during Apple Maps routes.' : 'The ETA is off. BMW\'s strip stays as it is.'); }));
            ui.onClick('BTN_PREVIEW', guard('preview', () => { strip.preview(); say('Showing a preview on the cluster for 30 seconds.'); }));
            ui.onClick('BTN_UP', guard('up', () => { strip.move(0, -1); placed(); }));
            ui.onClick('BTN_DOWN', guard('down', () => { strip.move(0, 1); placed(); }));
            ui.onClick('BTN_LEFT', guard('left', () => { strip.move(-1, 0); placed(); }));
            ui.onClick('BTN_RIGHT', guard('right', () => { strip.move(1, 0); placed(); }));
            ui.onClick('BTN_BIGGER', guard('bigger', () => { strip.size(1); placed(); }));
            ui.onClick('BTN_SMALLER', guard('smaller', () => { strip.size(-1); placed(); }));
            ui.onClick('BTN_RESET', guard('reset place', () => { strip.reset(); placed(); }));

            const fit = (cv, s, size, w, opt) => {
                s = String(s || '');
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            // the screen: Apple's dark look on pure black, so it meets the HMI's own black with no seam
            const C = { bg: '#000000', card: '#1c1c1e', card2: '#2c2c2e', edge: '#38383a', text: '#ffffff', dim: '#98989f', dim2: '#636366',
                green: '#30d158', orange: '#ff9f0a', red: '#ff453a', blue: '#0a84ff' };
            const LOOK_NAME = { glass: 'Frosted glass', card: 'Dark card', light: 'Light glass', plain: 'Plain text' };
            const IMG = 7101;
            let imgShown = null, sampleImg = null, sampleKey = null;
            const sample = () => {           // the sample route in the current look (redrawn only when the look changes)
                if (sampleKey !== strip.styleKey) { sampleKey = strip.styleKey; sampleImg = LOOK.render(LOOK.parts(LOOK.SAMPLE_ROUTE, '6:42 PM', strip.style), strip.style, strip.fonts); }
                return sampleImg;
            };
            const T = { literal: true }, B = { font: strip.fonts.bold, literal: true }, M = { font: strip.fonts.med, literal: true };
            const stateLine = () => {
                const s = strip.state;
                if (!strip.cr) return { c: C.orange, t: 'Install the Cluster renderer tool from the Store', d: s.client };
                if (!strip.ready) return { c: C.orange, t: 'Connecting to the cluster', d: s.client };
                if (!strip.cfg.on) return { c: C.dim2, t: 'Off', d: 'Turn it on with On / Off' };
                if (strip.shown) return { c: C.green, t: Date.now() < strip.previewUntil && !stripRoute() ? 'Preview on the cluster' : 'On the cluster now', d: '' };
                if (guiding()) return { c: C.orange, t: 'Apple Maps is guiding, waiting for its arrival time', d: 'Some iPhones send it a few seconds after the route starts' };
                return { c: C.blue, t: 'Ready', d: 'Start a route in Apple Maps. The ETA appears on the cluster by itself.' };
            };
            const drawMain = (cv, now) => {
                // status
                const st = stateLine();
                cv.circle(52, 68, 8, st.c);
                cv.text(fit(cv, st.t, 30, W - 140, B), 72, 79, 30, C.text, B);
                if (st.d) cv.text(fit(cv, st.d, 20, W - 140, M), 72, 108, 20, C.dim, M);
                // the cluster preview: what the strip shows, on a strip of black glass
                const px = 40, py = 128, pw = W - 80, ph = 176;
                cv.card(px, py, pw, ph, 22, [[0, '#0b0b0d'], [1, '#050506']]);
                cv.strokeRoundRect(px, py, pw, ph, 22, 1.5, C.edge);
                cv.text('8:54', px + 120, py + ph / 2 + 11, 30, C.dim2, M);
                cv.text('COMFORT', px + pw - 120, py + ph / 2 + 11, 26, C.dim2, Object.assign({ align: 'right' }, M));
                const live = !!stripRoute() || now < strip.previewUntil;
                const im = live && strip.image ? strip.image : sample();
                if (im && im !== imgShown) { setImage(IMG, im.w, im.h, im.data); imgShown = im; }
                if (im) cv.image(IMG, (W - im.w) / 2, py + (ph - im.h) / 2, im.w, im.h);
                cv.text(stripRoute() ? 'Live' : live ? 'Preview' : 'Sample', px + 22, py + 34, 18, C.dim, M);
                // the trip
                const r = trip(), ty = 324, tw = (W - 80 - 32) / 3;
                const tiles = r ? [['Arrival', R.arrivalText(r, now) || '--'], ['Time left', R.leftText(r.travelSec) || '--'], ['Distance', r.dist ? r.dist + ' ' + (r.unit || '') : '--']]
                    : [['Look', LOOK_NAME[strip.style.look] || strip.style.look], ['Layout', strip.style.layout === 'stacked' ? 'Stacked' : 'One row'], ['Size', Math.round(strip.cfg.scale * 100) + '%']];
                tiles.forEach((tl, i) => {
                    const x = 40 + i * (tw + 16);
                    cv.roundRect(x, ty, tw, 120, 20, C.card);
                    cv.text(tl[0], x + 26, ty + 40, 20, C.dim, M);
                    const c = r && i === 1 && r.traffic ? (r.traffic === 'red' ? C.red : r.traffic === 'yellow' ? C.orange : C.green) : C.text;
                    cv.text(fit(cv, tl[1], 40, tw - 52, B), x + 26, ty + 92, 40, c, B);
                });
                const hint = r ? 'From Apple Maps on CarPlay' : 'Change the look in Settings. Move it with Up, Down, Left and Right.';
                cv.text(fit(cv, hint, 18, W - 80, M), 40, 484, 18, C.dim2, M);
                if (note && now < note.until) {
                    const w = Math.min(W - 80, cv.textWidth(note.text, 20, M) + 48);
                    cv.roundRect((W - w) / 2, 458, w, 44, 22, C.card2);
                    cv.text(note.text, W / 2, 487, 20, C.text, Object.assign({ align: 'center' }, M));
                }
            };
            const drawDiag = (cv) => {
                cv.text('Diagnostics', 40, 76, 30, C.text, B);
                cv.text('What the car\'s guidance services report. Every change is saved to eta-probe.log.', 40, 104, 18, C.dim, M);
                cv.text(fit(cv, 'Cluster: ' + strip.status(), 18, W - 80, M), 40, 130, 18, C.dim, M);
                const keys = Object.keys(vals).sort();
                const rows = keys.map((k) => k + ' = ' + vals[k].s + '  (' + vals[k].n + ')');
                subs.forEach((s) => { if (!s.available) rows.push(s.tag + ': not available' + (s.error ? ' - ' + s.error : '')); });
                if (!rows.length) rows.push('Waiting for the car...');
                const PER = 11, pages = Math.max(1, Math.ceil(rows.length / PER)), pg = page % pages;
                cv.roundRect(40, 146, W - 80, 330, 18, C.card);
                rows.slice(pg * PER, pg * PER + PER).forEach((s, i) => cv.text(fit(cv, s, 17, W - 130, T), 64, 178 + i * 28, 17, i % 2 ? C.dim : C.text, T));
                cv.text('Page ' + (pg + 1) + ' of ' + pages + '   ·   Diagnostics again: next page   ·   Done: back', W - 40, 500, 16, C.dim2, { align: 'right', literal: true });
            };
            ctx.loop('MAIN', 2, guard('draw', async () => {
                const cv = ctx.canvas(W, H).clear(C.bg), now = Date.now();
                if (diag) drawDiag(cv); else drawMain(cv, now);
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
