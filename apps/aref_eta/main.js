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
const Car = require('./kit/car');
const SLOT = require('./slot');
// what's playing and its cover, for the second slot (Car Lyrics' modules, shared in app.json)
const NP = require('./nowplaying');
const ART = require('./artwork');
const http = require('./http');

const VERSION = (() => { try { return require('./kit/app-spec.json').version; } catch (e) { return 'dev'; } })();   // from the build (it said 1.25.0 on 1.26.0)
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
            // every guidance value to eta-probe.log only when Settings > probe log is on (off: no disk writes while driving);
            // tests, marks and starts always go to eta-tests.log (note2)
            const write = (line, always) => {
                if (!always && !ctx.settings.get('probe_log')) return;
                try {
                    try { if (fs.statSync(FILE).size > LOG_MAX) fs.renameSync(FILE, FILE + '.1'); } catch (e) { /* none yet */ }
                    fs.appendFileSync(FILE, new Date().toISOString() + ' ' + line + '\n');
                } catch (e) { /* full disk: the screen still shows it */ }
            };
            const TESTS = path.join(ctx.dataDir, 'eta-tests.log');
            const note2 = (line) => {     // tests, marks and starts: also in their own file and the app log
                write(line, true);
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
            // Diagnostics opens the raw values and closes them again (its pages turn by themselves)
            ui.onClick('BTN_MORE', guard('diagnostics', () => { diag = !diag; page = 0; try { ui.text('BTN_MORE', diag ? 'Close diagnostics' : 'Diagnostics'); } catch (e) { /* */ } }));
            setInterval(() => { if (diag) page++; }, 6000);
            // the ETA on the cluster (strip.js)
            let note = null;
            const say = (text) => { note = { text: text, until: Date.now() + 6000 }; };
            const strip = new Strip(ctx, note2);
            strip.start();
            // the route the cluster shows, or null. Turning the car off doesn't always say so: CarPlay's signals just
            // stop (Nov 12: the ETA stayed up). A route whose numbers haven't moved for STALE_MS counts as gone.
            const STALE_MS = 90000;
            // traffic colour, guessed from the time and distance left (CarPlay never sends Apple Maps' delay)
            const tg = new R.TrafficGuess();
            let tgGone = 0, tgLevel = -1;
            const stripRoute = () => {
                const r0 = trip(), w = vals['carplay.waypoints'], now = Date.now();
                const r = (w && now - w.at > STALE_MS) ? null : guiding() && r0 && r0.src === 'carplay' ? r0 : null;   // BMW's strip is blank only during a CarPlay route
                if (!r) { if (!tgGone) tgGone = now; else if (now - tgGone > 120000) { tg.reset(); tgLevel = -1; } return null; }
                tgGone = 0;
                const g = tg.apply(r, now);
                if (tg.last && tg.last.level !== tgLevel) {
                    tgLevel = tg.last.level;
                    note2('traffic guess ' + ['green', 'yellow', 'red'][tgLevel] + ': ' + Math.round(r.travelSec / 60) + ' min for ' + (r.rawDist ? (r.rawDist / 1609.34).toFixed(1) : '?') +
                        ' mi, arrival slipped ' + tg.last.slipMin + ' min, pace ' + tg.last.paceMin + ' min over open roads');
                }
                return g;
            };
            const style = () => {
                const g = (k, d) => { const v = ctx.settings.get(k); return v === undefined || v === null ? d : v; };
                const D = LOOK.DEFAULT_STYLE;
                return { street: !!g('street', false), preset: g('preset', 'bottom'), every: String(g('island_every', 'stay')), look: LOOK.lookOf(g('look', D.look)), layout: g('layout', D.layout), traffic: !!g('traffic', D.traffic), ampm: !!g('ampm', D.ampm),
                    arrival: !!g('show_arrival', D.arrival), minutes: !!g('show_minutes', D.minutes), distance: !!g('show_distance', D.distance) };
            };
            strip.setStyle(style());
            const font = () => strip.setFont(ctx.settings.get('font') === 'bmw' ? 'bmw' : 'apple');
            font();
            ctx.settings.onChange(guard('font', font));
            // a BMW Check Control message: the ETA steps aside for 8 s (the second slot stays)
            let ccSeen = false;
            ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
                newCCMessage: guard('cc', (v) => {
                    if (!ccSeen) { ccSeen = true; return; }          // the value held at start is no new message
                    strip.hideFor(8000);
                    note2('BMW message: ETA hidden 8 s ' + json(v).slice(0, 300));   // always logged (eta-tests.log)
                }),
            }, log).then((sub) => write('subscribed cc: ' + (sub.available ? 'available' : 'not available') + (sub.error ? ' (' + sub.error + ')' : '')),
                (e) => write('subscribe cc failed: ' + e.message));
            ctx.settings.onChange(guard('style', () => strip.setStyle(style())));
            // the street you're on, for the island preset's bottom strip: BMW's own map-matched street
            // (NavigationStatus.currentLocation, which keeps it during a CarPlay route; only the street is kept here,
            // never the coordinates), else CarPlay's currentRoad (Apple Maps often sends it empty while guiding)
            let navStreet = null;
            ctx.signals.watch('de.bmw.infotainment.navigation.navigationstatus.NavigationStatus', '1', {
                currentLocation: guard('street', (v) => {
                    const a = v && v.address, st = a && a.street;
                    const s = st && st.valid !== false && st.text ? String(st.text) : null;
                    if (s !== navStreet) { navStreet = s; write('street = ' + (s || '-')); }
                }),
            }, log, { pollMs: 5000 }).then((sub) => write('subscribed street: ' + (sub.available ? 'available' : 'not available') + (sub.error ? ' (' + sub.error + ')' : '')),
                (e) => write('subscribe street failed: ' + e.message));
            const textOf = (v) => { const e = v && v.elements; return Array.isArray(e) && e.length ? e.map((x) => x && x.text).filter(Boolean).join(' ') || null : null; };
            const road = () => navStreet || textOf(val('carplay.currentRoad'));
            // the second slot: oil / gear / g / clock / music where BMW's widgets are, while the strip holds the panel
            const car = new Car(ctx, ['temps', 'gear', 'accel', 'program', 'drivemode'], { demo: false });
            const NP_IFACES = [
                { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
                { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
                { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instances: [] },
                { iface: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', instances: [] },
            ];
            let np = null, artwork = null;
            const slotKind = () => ctx.settings.get('second_slot') || 'off';
            const covers = {};          // artwork ver -> { px, n } (150 px)
            let lastCover = null;
            const coverFor = (t) => {
                if (!artwork || !t || !t.title) return null;
                const e = artwork.get({ title: t.title, artist: t.artist, album: t.album, cover: t.cover });   // cover: the car's own file
                // not ready yet: no cover and no backdrop (never the last song's), so the two always match
                if (e.state !== 'ready') return (lastCover = null);
                if (!covers[e.ver]) {
                    Object.keys(covers).forEach((k) => delete covers[k]);
                    // the small cover, and a 300 px one for the backdrop (the same object while the song plays)
                    covers[e.ver] = { px: ART.squareResample(e.cover, e.n, e.n, 150, 0).px, n: 150, big: { px: e.cover, n: e.n } };
                }
                return (lastCover = covers[e.ver]);
            };
            const slotTick = guard('slot', () => {
                if (!strip.slot) return;
                const kind = slotKind();
                if (kind === 'off' && !strip.slot.shown) return;        // idle: nothing to draw or hide
                strip.slot.setShape(ctx.settings.get('music_shape') || 'bmw');
                // each side's edge: Settings > Music backdrop top / bottom / left / right edge
                const EDGE = { sharp: 0.015, soft: 0.05, softer: 0.12, fade: 0.25, long: 0.45 };
                const edge = (k, d) => EDGE[ctx.settings.get('music_edge_' + k)] || EDGE[d];
                strip.slot.setLook({ top: edge('top', 'soft'), bottom: edge('bottom', 'fade'), left: edge('left', 'soft'), right: edge('right', 'soft'),
                    opacity: (Number(ctx.settings.get('music_opacity')) || 100) / 100, blur: ({ none: 0, soft: 6, medium: 12, strong: 22 })[ctx.settings.get('music_blur') || 'medium'] || 0,
                    crop: ctx.settings.get('music_crop') === 'none' ? 1 : 0.9 });   // the art's top-left 90 %: the explicit badge's corner off
                if (kind === 'music' && !np) {          // started on first use: it subscribes to a lot
                    np = new NP.NowPlaying(ctx.signals, log, NP_IFACES);
                    np.start().catch((e) => log.warn('nowplaying: ' + e.message));
                    const net = http.client(ctx.dataDir);
                    artwork = new ART.Artwork((m, h, p, hd) => net.request(m, h, p, hd), log, undefined, { px: 300, blur: false, cache: 6, dir: path.join(ctx.dataDir, 'covers') });
                }
                const t = kind === 'music' && np ? np.track() : null;
                const cov = coverFor(t), c = SLOT.content(kind, car.data(), Date.now(), t, cov);
                if (c && c.music && cov) c.music.bg = cov.big;
                const SIZE = { small: 110, medium: 140, large: 170, xl: 200 }, BAR = { short: 140, medium: 180, long: 240, full: 300 };
                const THICK = { thin: 3, medium: 6, thick: 9 };
                strip.slot.setMusic({ size: SIZE[ctx.settings.get('music_cover_size')] || 140, bar: BAR[ctx.settings.get('music_bar')] || 180,
                    thick: THICK[ctx.settings.get('music_bar_thick')] || 3, time: ctx.settings.get('music_time') === 'above' ? 'above' : 'right',
                    back: !!ctx.settings.get('music_bar_back'), textBack: !!ctx.settings.get('music_text_back') });
                // a BMW message: the second slot fades out with the ETA and back after it, instead of blinking with the cluster's lock
                strip.slot.update(kind !== 'off' && strip.cfg.on && !strip.foreign(), c);   // off while another app draws on the cluster   // BMW's pop-ups and messages move only the ETA strip aside, not this (Nov 21)   // by itself, as BMW's own widget: not tied to the ETA or the map
            });
            setInterval(slotTick, 500);
            ui.onClick('BTN_TARGET', guard('target', () => {
                strip.moving = !strip.moving ? 'slot' : strip.moving === 'slot' ? 'backdrop' : null;
                const L = { slot: 'Moving: 2nd slot', backdrop: 'Moving: music backdrop' };
                try { ui.text('BTN_TARGET', L[strip.moving] || 'Moving: ETA'); } catch (e) { /* */ }
                say(strip.moving === 'slot' ? 'The buttons now move the second slot.' : strip.moving === 'backdrop'
                    ? 'The buttons now move only the music backdrop. Smaller pulls its bottom up off the tach.' : 'The buttons move the ETA again.');
            }));

            // Cluster Studio: a whole-cluster design the homelab copied here (eta/design.js)
            const designTick = guard('design', () => { if (strip.design) strip.design.tick(ctx.settings.get('design') !== false && !strip.foreign()); });
            setInterval(designTick, 4000);
            onRoute = guard('strip', () => { const r = stripRoute();
                strip.pendingRoute = !!r;                              // a route: the status is polled even while stepped aside
                if (!r && strip.idle && strip.idle()) return;          // idle: no route, nothing shown, no preview
                strip.update(r, r ? R.arrivalText(r, Date.now()) : null, road());
            });
            setInterval(onRoute, 1000);
            // another app's cluster coming or going: everything of ours follows at once, not on its next tick
            strip.onYield = () => { onRoute(); slotTick(); designTick(); };
            // the drive mode: the first hint that a cluster theme is about to come or go (strip.modeChanged)
            setInterval(guard('mode', () => { const m = car.data().driveMode; if (m !== strip.mode) strip.modeChanged(m); }), 200);
            const placed = () => say('Moved. Showing a preview on the cluster for 30 seconds.');
            // the button says what it will do, so an accidental press is easy to see and undo
            const toggleLabel = () => { try { ui.text('BTN_TOGGLE', strip.cfg.on ? 'Turn ETA off' : 'Turn ETA on'); } catch (e) { /* */ } };
            toggleLabel();
            ui.onClick('BTN_TOGGLE', guard('toggle', () => { strip.toggle(); toggleLabel(); say(strip.cfg.on ? 'The ETA will show on the cluster during Apple Maps routes.' : 'The ETA is off. Press Turn ETA on to bring it back.'); }));
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
            const LOOK_NAME = { black: 'Black', smoked: 'Smoked', glass: 'Glass', outline: 'Outline', plain: 'Plain text' };
            const EVERY = { stay: 'Pops out once, stays', 10: 'Every 10 s', 30: 'Every 30 s', 60: 'Every minute', 300: 'Every 5 min', change: 'When the ETA changes' };
            const IMG = 7101;
            let imgShown = null, sampleImg = null, sampleKey = null;
            const sample = () => {           // the sample route in the current look (redrawn only when the look changes)
                if (sampleKey !== strip.styleKey) { sampleKey = strip.styleKey; sampleImg = strip.sampleImage(); }
                return sampleImg;
            };
            const T = { literal: true }, B = { font: strip.fonts.bold, literal: true }, M = { font: strip.fonts.med, literal: true };
            const stateLine = () => {
                const s = strip.state;
                if (!strip.cr) return { c: C.orange, t: 'Install the Cluster renderer tool from the Store', d: s.client };
                if (!strip.ready) return { c: C.orange, t: 'Connecting to the cluster', d: s.client };
                if (!strip.cfg.on) return { c: C.dim2, t: 'Off', d: 'Turn it on with On / Off' };
                if (strip.showing()) return { c: C.green, t: Date.now() < strip.previewUntil && !stripRoute() ? 'Preview on the cluster' : 'On the cluster now', d: strip.style.preset === 'island' ? 'Island at the top' : 'Bottom strip' };
                if (strip.style.preset === 'island' && strip.map.state !== 'shown') return { c: C.orange, t: 'The island waits for the cluster map', d: 'It sits on Waze on cluster\'s map: turn that on (or switch to Bottom strip)' };
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
                const top = strip.style.preset === 'island';
                if (top) cv.roundRect(W / 2 - 70, py - 10, 140, 28, 14, '#1c1c1e');      // the camera, above the cluster's top edge
                else {
                    cv.text('8:54', px + 120, py + ph / 2 + 11, 30, C.dim2, M);
                    cv.text('COMFORT', px + pw - 120, py + ph / 2 + 11, 26, C.dim2, Object.assign({ align: 'right' }, M));
                }
                const live = !!stripRoute() || now < strip.previewUntil;
                const im = live && strip.image ? strip.image : sample();
                if (im && im !== imgShown) { setImage(IMG, im.w, im.h, im.data); imgShown = im; }
                if (im) cv.image(IMG, (W - im.w) / 2, top ? py + 22 - (im.h - 76) / 2 : py + (ph - im.h) / 2, im.w, im.h);
                cv.text(stripRoute() ? 'Live' : live ? 'Preview' : 'Sample', px + 22, py + 34, 18, C.dim, M);
                // the trip
                const r = trip(), ty = 324, tw = (W - 80 - 32) / 3;
                const tiles = r ? [['Arrival', R.arrivalText(r, now) || '--'], ['Time left', R.leftText(r.travelSec) || '--'], ['Distance', r.dist ? r.dist + ' ' + (r.unit || '') : '--']]
                    : strip.style.preset === 'island'
                        ? [['Preset', 'Island (top)'], ['Pops out', EVERY[strip.style.every] || strip.style.every], ['Layout', strip.style.layout === 'stacked' ? 'Stacked' : 'One row']]
                        : [['Preset', 'Bottom strip'], ['Look', LOOK_NAME[strip.style.look] || strip.style.look], ['Layout', strip.style.layout === 'stacked' ? 'Stacked' : 'One row']];
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
                cv.text('Page ' + (pg + 1) + ' of ' + pages + (pages > 1 ? ' (turns every 6 s)' : ''), W - 40, 500, 16, C.dim2, { align: 'right', literal: true });
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
