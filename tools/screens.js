'use strict';
/**
 * screens.js - renders each app's screens on a PC with made-up data, for the READMEs.
 *
 *   node tools/screens.js            -> docs/screenshots/<id>/*.png (outside apps/: the build would install them)
 *
 * It runs an app's real main.js and drawing code against stand-ins for the head unit: the kit's runtime
 * (mgu.js: screens, buttons, settings), the car's signals (Car), the diagnostic link (Diag) and the
 * network. The pictures are the app's own drawing, at the size it draws (1600 x 520); the values are
 * invented. Nothing here is installed on the car.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'kit', 'runtime');
const { Canvas } = require(path.join(RUNTIME, 'canvas'));
const { Recorder, play } = require(path.join(RUNTIME, 'record'));
const themes = require(path.join(RUNTIME, 'themes'));

/* the GPU renderer draws scaled pictures filtered: do the same here (bilinear) so the shots look as on the car */
Canvas.prototype.drawImage = function (src, sw, sh, x, y, w, h) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y)), x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    const d = this.d, fx = sw / w, fy = sh / h;
    for (let py = y0; py < y1; py++) {
        const sy = Math.max(0, Math.min(sh - 1.001, (py - y + 0.5) * fy - 0.5)), ya = sy | 0, wy = sy - ya, yb = Math.min(sh - 1, ya + 1);
        for (let px = x0; px < x1; px++) {
            const sx = Math.max(0, Math.min(sw - 1.001, (px - x + 0.5) * fx - 0.5)), xa = sx | 0, wx = sx - xa, xb = Math.min(sw - 1, xa + 1), di = (py * this.w + px) * 4;
            const v = [0, 0, 0, 0];
            for (let c = 0; c < 4; c++) {
                const p = (yy, xx) => { const q = src[(yy * sw + xx) * 4 + c]; return q === undefined ? 255 : q; };
                v[c] = (p(ya, xa) * (1 - wx) + p(ya, xb) * wx) * (1 - wy) + (p(yb, xa) * (1 - wx) + p(yb, xb) * wx) * wy;
            }
            const k = v[3] / 255, q = 1 - k;
            d[di] = v[0] * k + d[di] * q; d[di + 1] = v[1] * k + d[di + 1] * q; d[di + 2] = v[2] * k + d[di + 2] * q; d[di + 3] = 255;
        }
    }
    return this;
};

/* ---------- module stand-ins ---------- */
const stubs = {};          // './kit/<name>' -> exports
let appDir = '';
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (req, parent, isMain, opts) {
    if (stubs[req]) return 'stub:' + req;
    if (req.indexOf('./kit/') === 0) return resolve0.call(this, path.join(RUNTIME, req.slice(6)), parent, isMain, opts);
    // an app module required as './name': installed side by side on the car, kept in folders here
    if (req.indexOf('./') === 0 && parent && parent.filename && parent.filename.indexOf(appDir) === 0) {
        const name = req.slice(2).replace(/\.js$/, '') + '.js';
        const found = walk(appDir).find((f) => path.basename(f) === name);
        if (found) return found;
    }
    return resolve0.call(this, req, parent, isMain, opts);
};
const load0 = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    return load0.apply(this, arguments);
};
function walk(d) {
    let out = [];
    fs.readdirSync(d).forEach((n) => {
        const p = path.join(d, n), st = fs.statSync(p);
        if (st.isDirectory() && n !== 'screenshots') out = out.concat(walk(p)); else if (/\.js$/.test(n)) out.push(p);
    });
    return out;
}

/* ---------- a stand-in for the kit's runtime (mgu.run) ---------- */
function harness(id, opts) {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', id, 'app.json'), 'utf8'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), id + '-'));
    Object.keys(opts.files || {}).forEach((f) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(opts.files[f])));
    const values = {};
    (spec.settings || []).forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, opts.settings || {});
    const clicks = {}, loops = {}, images = {}, layout = [];
    let widgetFn = null;
    const ctx = {
        spec, dataDir, display: null,
        log: { info() {}, warn() {}, error(m) { console.error(id + ': ' + m); }, debug() {} },
        settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} },
        theme: () => themes.theme(values.theme),
        canvas: (w, h) => {                     // what the car gives an app to draw on: a recording
            const r = new Recorder(w, h);
            if (opts.own) { r.own = true; r.place = { scale: opts.own.scale, ox: opts.own.ox, oy: opts.own.oy, full: true }; r.extra = opts.own.extra; r.chrome = { tabs: null }; }
            return r;
        },
        hideButton() {}, onTab: (fn) => { ctx.tab = fn; },
        onLayout: (fn) => layout.push(fn),
        signals: opts.signals || { watch: () => Promise.resolve({ available: false, error: 'PC' }), loadConfig: () => { throw new Error('PC'); } },
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        widget: { loop: (fps, fn) => { widgetFn = fn; }, set() {}, onChange() {}, active: () => true },
        ui: {
            onClick: (b, fn) => { clicks[b] = fn; }, text() { return Promise.resolve(); }, visible() { return Promise.resolve(); },
            open() { return Promise.resolve(); }, isVisible: () => true,
            image: (name, cv) => { images[name] = cv; return Promise.resolve(); },
        },
    };
    stubs['./kit/mgu'] = { run: (app) => { ctx.started = app.start(ctx); } };
    appDir = path.join(ROOT, 'apps', id);
    Object.keys(require.cache).forEach((k) => { if (k.indexOf(appDir) === 0) delete require.cache[k]; });
    require(path.join(appDir, 'main.js'));
    return {
        ctx, clicks,
        ready: () => Promise.resolve(ctx.started).then(() => new Promise((r) => setTimeout(r, 50))),
        async widget(file) {
            const cv = await widgetFn({ spawnId: 1, big: true, visible: true });
            const out = path.join(ROOT, 'docs', 'screenshots', id);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, file), cv.png(9));
            console.log('wrote docs/screenshots/' + id + '/' + file);
        },
        async shot(screen, file) {
            await loops[screen]();
            const rec = images[screen + '_GFX'], extra = rec.extra || 0;
            let cv = new Canvas(rec.w, rec.h + extra);
            play(rec.words(), cv);                // played back into pixels, as the car does without the GPU renderer
            if (rec.own) {                        // the part full-screen mode shows (display.js FULL.src)
                const out = new Canvas(1576, rec.h + extra - 38);
                for (let y = 0; y < out.h; y++) out.d.set(cv.d.subarray(((y + 38) * cv.w + 12) * 4, ((y + 38) * cv.w + 12 + 1576) * 4), y * out.w * 4);
                cv = out;
            }
            const out = path.join(ROOT, 'docs', 'screenshots', id);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(path.join(out, file), cv.png(9));
            console.log('wrote docs/screenshots/' + id + '/' + file);
        },
    };
}

/** A Car stand-in: data() returns d, onSample feeds nothing (the apps' saved data carries the story). */
function carStub(d) {
    function Car() {}
    Car.prototype.data = () => Object.assign({}, d);
    Car.prototype.onSample = () => {};
    return Car;
}

const DAY = 86400000, NOW = Date.UTC(2026, 10, 6, 23, 30);
const realNow = Date.now;
let later = 0;                 // ms the clock has moved on (animations)
Date.now = () => NOW + later;
const tick = (s) => NOW - s * 1000;

async function carCare() {
    const KM = 1.609344, odo = 118000 * KM;
    const h = harness('aref_carcare', {
        files: { 'carcare.json': { odo, recs: {
            oil: { km: odo - 2410 * KM, at: NOW - 70 * DAY },
            plugs: { km: odo - 6000 * KM, at: NOW - 160 * DAY },
            diff: { km: odo - 9000 * KM, at: NOW - 200 * DAY },
            xfer: { km: odo - 9000 * KM, at: NOW - 200 * DAY },
            trans: { km: odo - 12000 * KM, at: NOW - 250 * DAY },
            brake: { km: odo - 9000 * KM, at: NOW - 400 * DAY },
            cabin: { km: odo - 15000 * KM, at: NOW - 380 * DAY },
        } } },
    });
    await h.ready();
    await h.shot('MAIN', 'items.png');
    await h.widget('widget.png');
    h.clicks.BTN_EARLIER();
    for (let i = 0; i < 2; i++) h.clicks.BTN_KM_UP();
    h.clicks.BTN_KM_UP2(); h.clicks.BTN_MO_UP(); h.clicks.BTN_MO_UP();
    await h.shot('MAIN', 'done-earlier.png');
}

async function driveLog() {
    stubs['./kit/car'] = carStub({});
    const drive = (daysAgo, km, mins, top, best, extra) => Object.assign({
        start: NOW - daysAgo * DAY - mins * 60000, end: NOW - daysAgo * DAY, km, movingMs: mins * 50000, topKmh: top,
        peakRpm: 6450, maxAccelG: 0.71, maxBrakeG: 0.93, maxLatG: 0.82, oilMax: 112, coolantMax: 104, best060: best, runs060: best ? 2 : 0,
    }, extra || {});
    const trips = [drive(6, 31.2, 38, 128, null), drive(5, 18.4, 25, 104, null), drive(4, 54.0, 52, 161, 3.71),
        drive(3, 12.9, 19, 92, null), drive(2, 27.5, 31, 142, 3.68), drive(1, 40.3, 44, 151, 3.74), drive(0.1, 46.8, 41, 167, 3.66)];
    const runs = [
        { id: 'a', at: NOW - 4 * DAY, car: 3.71, dragy: 3.94, skipped: false },
        { id: 'b', at: NOW - 2 * DAY, car: 3.68, dragy: 3.95, skipped: false },
        { id: 'c', at: NOW - 1 * DAY, car: 3.74, dragy: 3.97, skipped: false },
        { id: 'd', at: NOW - 0.1 * DAY, car: 3.66, dragy: null, skipped: false },
    ];
    const files = { 'drivelog.json': { trips, current: null, runs } };
    let h = harness('aref_drivelog', { files, settings: { dragy: true } });
    await h.ready();
    await h.shot('MAIN', 'this-drive.png');
    await h.widget('widget.png');
    h.clicks.BTN_VIEW(); await h.shot('MAIN', 'history.png');
    h.clicks.BTN_VIEW(); await h.shot('MAIN', 'runs.png');
    h.clicks.BTN_DRAGY(); h.clicks.BTN_UP(); h.clicks.BTN_UP(); h.clicks.BTN_UP2();
    await h.shot('MAIN', 'enter-dragy.png');
    delete stubs['./kit/car'];
}

async function faultWatch() {
    stubs['./kit/car'] = carStub({ speed: 0, stage: 'P' });
    stubs['./kit/diag'] = Object.assign({}, require(path.join(RUNTIME, 'diag')), {
        Diag: function () { this.p = {}; this.init = () => Promise.resolve(this); },
    });
    const ctx = (kmh, gear, rpm, oil, mode) => ({ kmh, gear, rpm, oil, mode });
    const ev = (ago, kind, ecu, code, status, label, c) => ({ at: tick(ago), kind, ecu, code, status, label, ctx: c });
    const events = [
        ev(86400 * 2, 'found', '06', '801A27', 0x08, 'STORED', ctx(0, 0, 720, 64)),
        ev(86400, 'new', '43', 'E2C410', 0x08, 'STORED', ctx(108, 7, 2150, 98, 'COMFORT')),
        ev(80000, 'gone', '43', 'E2C410', 0x08, 'STORED', ctx(0, 0, 0, 92)),
        ev(7200, 'new', '43', 'E2C410', 0x09, 'ACTIVE', ctx(113, 8, 2240, 101, 'COMFORT')),
        ev(5400, 'new', '37', 'A1B605', 0x08, 'STORED', ctx(64, 5, 1980, 99, 'SPORT')),
        ev(600, 'active', '06', '801A27', 0x09, 'ACTIVE', ctx(0, 0, 690, 88)),
    ];
    const last = { at: tick(600), ecus: ['06', '10', '12', '18', '29', '37', '40', '43', '44', '60', '63'], faults: { '06:801A27': 0x09, '43:E2C410': 0x09, '37:A1B605': 0x08 } };
    const h = harness('aref_faultwatch', { files: { 'faultwatch.json': { last, events, scans: 412 } } });
    await h.ready();
    await h.shot('MAIN', 'timeline.png');
    await h.widget('widget.png');
    h.clicks.BTN_VIEW(); await h.shot('MAIN', 'current.png');
    delete stubs['./kit/car']; delete stubs['./kit/diag'];
}

async function misfire() {
    // a made-up history: a few drives, misfires mostly on cylinder 3 under load
    stubs['./kit/car'] = carStub({ rpm: 2350, speed: 72, gear: 4, coolant: 96, oil: 104, torque: 180, driveMode: 'SPORT' });
    stubs['./kit/diag'] = Object.assign({}, require(path.join(RUNTIME, 'diag')), {
        Diag: function () { this.p = {}; this.init = () => Promise.resolve(this); },
    });
    const now = [0, 1, 7, 0, 0, 1], avg = [0, 1, 4, 0, 1, 0];
    stubs['./dids'] = { DidReader: function () {
        this.raws = {};
        this.monitorKey = (e, m, d) => (d ? 'F6' : 'MID ') + m.toString(16);
        this.supported = () => Promise.resolve([0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7]);
        this.monitor = (e, mid) => Promise.resolve([{ tid: 0x0B, value: avg[mid - 0xA2] }, { tid: 0x0C, value: now[mid - 0xA2] }]);
    } };
    const c = (rpm, kmh, gear, nm, mode) => ({ rpm, speed: kmh, gear, torque: nm, coolant: 95, mode });
    const ev = (ago, drive, cyl, n, ctx, early) => ({ at: tick(ago), drive, cyl, n, ctx, early: !!early });
    const events = [
        ev(86400 * 3, 1, 3, 2, c(820, 0, 0, 40), true), ev(86400 * 3 - 900, 1, 3, 1, c(5450, 118, 3, 470, 'SPORT PLUS')),
        ev(86400 * 2, 2, 6, 1, c(760, 0, 0, 35)), ev(86400 - 400, 3, 3, 3, c(5900, 131, 3, 480, 'SPORT PLUS')), ev(86400 - 380, 3, 2, 1, c(6100, 137, 3, 475, 'SPORT PLUS')),
        ev(900, 4, 3, 2, c(4800, 96, 4, 430, 'SPORT')), ev(600, 4, 6, 1, c(800, 0, 0, 30)), ev(240, 4, 3, 3, c(5600, 104, 3, 465, 'SPORT')), ev(200, 4, 2, 1, c(5800, 109, 3, 470, 'SPORT')),
    ];
    const d = (id, ago, mins, counts) => ({ id, start: tick(ago), end: tick(ago - mins * 60), counts, first: [0, 0, 0, 0, 0, 0], avg10: avg });
    const state = { drive: d(4, 1500, 25, [0, 1, 5, 0, 0, 1]), drives: [d(1, 86400 * 3 + 1200, 34, [0, 0, 3, 0, 0, 0]), d(2, 86400 * 2 + 600, 18, [0, 0, 0, 0, 0, 1]), d(3, 86400 + 1800, 41, [0, 1, 3, 0, 0, 0])],
        events, totals: [0, 2, 11, 0, 0, 2], last: { at: tick(60), counts: [0, 1, 5, 0, 0, 1] }, avg10: avg, reads: 3120 };
    const h = harness('aref_misfire', { files: { 'misfires.json': state } });
    await h.ready();
    await new Promise((r) => setTimeout(r, 30));
    await h.shot('MAIN', 'overview.png');
    await h.widget('widget.png');
    h.clicks.BTN_VIEW(); await h.shot('MAIN', 'log.png');
    h.clicks.BTN_VIEW(); await h.shot('MAIN', 'drives.png');
    delete stubs['./kit/car']; delete stubs['./kit/diag']; delete stubs['./dids'];
}

async function carLyrics() {
    // made-up lyrics for a made-up song, and a made-up cover (test/fixtures/cover_demo.jpg): nobody's work
    const lrc = ['[00:10.00]Headlights on the empty road', '[00:14.50]Counting every mile we owe', '[00:19.00]Radio low, the windows down and the city fading in the mirror',
        '[00:23.50]Leaving all the lights of town', '[00:28.00]', '[00:31.00]And the night keeps rolling on', '[00:35.50]Like the last line of a song',
        '[00:40.00]Hold on, hold on', '[00:44.00]We were never meant to stay'].join('\n');
    const meta = [{ key: 'TITLE', value: { stringValue: 'Night Drive' } }, { key: 'ARTIST', value: { stringValue: 'Sample Artist' } }, { key: 'ALBUM', value: { stringValue: 'Demo Tapes' } }];
    const signals = {
        loadConfig: (iface) => (/MediaPlayer$/.test(iface) ? { instances: ['CarPlayMedia'], fields: { currentItemMetadata: {}, currentItemTime: {}, playerState: {}, playbackSpeed: {} } } : { instances: [], fields: {} }),
        watch: (iface, inst, h) => {
            if (inst === 'CarPlayMedia') { h.currentItemMetadata(meta); h.currentItemTime({ elapsed: 24900, total: 212000 }); h.playerState('PLAYER_STATE_PLAY'); h.playbackSpeed(1000); }
            return Promise.resolve({ available: true, error: null });
        },
    };
    const cover = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'cover_demo.jpg'));
    stubs['./http'] = { client: () => ({ online: () => true, request: (m, host) => {
        if (host === 'itunes.apple.com') return Promise.resolve({ status: 200, body: Buffer.from(JSON.stringify({ results: [{ trackName: 'Night Drive', artistName: 'Sample Artist', artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg' }] })) });
        if (host === 'lrclib.net') return Promise.resolve({ status: 200, body: Buffer.from(JSON.stringify({ syncedLyrics: lrc })) });
        return Promise.resolve({ status: 200, body: cover });
    } }) };
    // as the car's full-screen mode shows the page (display.js, 1920 x 720 screen): scaled 1.165, 53 px more below
    const h = harness('aref_carlyrics', { signals, own: { scale: 1.165, ox: 70, oy: 36, extra: 53 } });
    await h.ready();
    await h.shot('MAIN', 'lyrics.png');           // the first frame starts the lookups
    await new Promise((r) => setTimeout(r, 400));
    await h.shot('MAIN', 'lyrics.png');           // the line lights up: a moment later
    later = 1000;
    await h.shot('MAIN', 'lyrics.png');
    later = 0;
    h.ctx.tab(1);
    await h.shot('MAIN', 'probe.png');
    h.ctx.tab(0);
    await h.widget('widget.png');
    delete stubs['./http'];
}

async function explorer() {
    // a made-up catalog with the shapes the real one has (interface -> attributes / methods / broadcasts)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-'));
    fs.mkdirSync(path.join(root, 'etc/oap/someip'), { recursive: true });
    const iface = (attrs, methods, bc) => { const a = {}; attrs.forEach((n) => { a[n] = { getter: true, notifier: true }; }); return { attributes: a, methods: methods || [], broadcasts: bc || [] }; };
    fs.writeFileSync(path.join(root, 'etc/oap/someip/someip-interfaces.json'), JSON.stringify({ interfaces: {
        'de.example.lighting.InteriorLight': iface(['statusAmbientLightColour', 'statusAmbientBrightness', 'statusLightProfile'], ['setAmbientLightColour']),
        'de.example.hmi.Personalisation': iface(['ambientLightSettings', 'driverProfile'], ['setAmbientLightSettings']),
        'de.example.vehicle.BodyControl': iface(['statusDoors', 'statusWindows'], []),
        'de.example.navigation.Guidance': iface(['guidanceState', 'remainingDistance', 'estimatedTimeOfArrival'], [], ['maneuverUpdate']),
    } }));
    process.env.MGU_EXPLORER_ROOT = root;
    const h = harness('aref_explorer', {});
    await h.ready();
    await h.shot('MAIN', 'ambient.png');
    h.clicks.BTN_DETAIL();
    await h.shot('MAIN', 'details.png');
    delete process.env.MGU_EXPLORER_ROOT;
}

async function carWatch() {
    // the three old apps in one: misfires imported from Misfire Watch's handoff copy, faults and drives from the data folder
    stubs['./kit/car'] = carStub({ rpm: 2350, speed: 72, gear: 4, coolant: 96, oil: 104, torque: 180, driveMode: 'SPORT' });
    stubs['./kit/diag'] = Object.assign({}, require(path.join(RUNTIME, 'diag')), {
        Diag: function () { this.p = {}; this.init = () => Promise.resolve(this); this.functional = () => new Promise(() => {}); },
    });
    const now = [0, 1, 2, 0, 0, 0], avg = [0, 0, 1, 0, 0, 0];
    stubs['./dids'] = { DidReader: function () {
        this.raws = {};
        this.monitorKey = (e, m, d) => (d ? 'F6' : 'MID ') + m.toString(16);
        this.supported = () => Promise.resolve([0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7]);
        this.monitor = (e, mid) => Promise.resolve([{ tid: 0x0B, value: avg[mid - 0xA2] }, { tid: 0x0C, value: now[mid - 0xA2] }]);
    } };
    const c = (rpm, kmh, gear, nm, mode) => ({ rpm, speed: kmh, gear, torque: nm, coolant: 70, mode });
    const ev = (ago, drive, cyl, n, ctx) => ({ at: tick(ago), drive, cyl, n, ctx, early: false });
    const events = [ev(86400, 1, 4, 2, c(820, 0, 0, 40)), ev(900, 2, 1, 1, c(900, 0, 0, 30)), ev(240, 2, 3, 1, c(2800, 95, 6, 20, 'COMFORT'))];
    const d = (id, ago, mins, counts) => ({ id, start: tick(ago), end: tick(ago - mins * 60), counts, first: [0, 0, 0, 0, 0, 0], avg10: avg });
    const mf = { drive: d(2, 1500, 25, [1, 0, 1, 0, 0, 0]), drives: [d(1, 86400 + 1200, 34, [0, 0, 0, 2, 0, 0])], events, totals: [1, 0, 1, 2, 0, 0],
        last: { at: tick(60), counts: [1, 0, 1, 0, 0, 0] }, avg10: avg, reads: 812 };
    const hand = '/dev/shm/aref-handoff-aref_misfire';
    fs.mkdirSync(hand, { recursive: true });
    fs.writeFileSync(path.join(hand, 'misfires.json'), JSON.stringify(mf));
    const last = { at: tick(600), ecus: ['06', '10', '12', '23', '60'], faults: { '06:800BE2': 0x08, '23:D1C604': 0x08, '60:E114D0': 0x08, '60:E11598': 0x08 } };
    const fev = [{ at: tick(7200), kind: 'new', ecu: '10', code: 'CD0420', status: 0x09, label: 'ACTIVE', ctx: { kmh: 0, gear: 0, rpm: 0 } },
        { at: tick(3600), kind: 'gone', ecu: '10', code: 'CD0420', status: 0x09, label: 'ACTIVE', ctx: { kmh: 0, gear: 0, rpm: 720 } }];
    const trip = (ago, km, mins, top) => ({ start: NOW - ago * DAY - mins * 60000, end: NOW - ago * DAY, km, movingMs: mins * 50000, topKmh: top,
        peakRpm: 3400, maxAccelG: 0.48, maxBrakeG: 0.5, maxLatG: 0.4, oilMax: 107, coolantMax: 96, best060: null, runs060: 0 });
    const h = harness('aref_carwatch', { files: { 'faultwatch.json': { last, events: fev, scans: 90 },
        'drivelog.json': { trips: [trip(1, 29, 21, 151), trip(0.2, 11.6, 13, 113)], current: null, runs: [] } } });
    await h.ready();
    await new Promise((r) => setTimeout(r, 30));
    await h.shot('MAIN', 'misfires.png');
    await h.widget('widget.png');
    h.clicks.BTN_SECTION(); await h.shot('MAIN', 'faults.png');
    h.clicks.FW_VIEW(); await h.shot('MAIN', 'faults-current.png');
    h.clicks.BTN_SECTION(); await h.shot('MAIN', 'drives.png');
    h.clicks.DL_VIEW(); await h.shot('MAIN', 'drives-history.png');
    h.clicks.BTN_SECTION(); h.clicks.MF_VIEW(); await h.shot('MAIN', 'misfire-log.png');
    const imported = fs.existsSync(path.join(h.ctx.dataDir, 'misfires.json'));
    console.log('car watch: misfires imported ' + imported + ', data in ' + h.ctx.dataDir);
    fs.unlinkSync(path.join(hand, 'misfires.json')); fs.rmdirSync(hand);
    delete stubs['./kit/car']; delete stubs['./kit/diag']; delete stubs['./dids'];
}

async function eta() {
    // a stand-in for the Cluster renderer tool: accepts the layer and says it's shown
    const EventEmitter = require('events');
    class FakeCR extends EventEmitter {
        image() { return 1; } pixels() {} set() {}
        connect() { setImmediate(() => this.emit('ready')); }
    }
    stubs['./kit/cluster_render'] = { loadClient: () => ({ ClusterRender: FakeCR, sock: '/dev/null' }) };
    const route = (on) => ({
        waypoints: on ? [{ isCheckeredFlag: true, travelTime: 23 * 60 + 10, delayTime: 0, delayStatus: 'GREEN',
            estimatedArrivalTime: { date: { invalid: false, year: 2026, month: 11, day: 12 }, time: { invalid: false, hour: 18, minute: 42, seconds: 0 } },
            formattedDistance: { distance: '14.2', unit: 'MILE_US', rawDistance: 22850 } }] : [],
    });
    let guiding = false;
    const signals = {
        watch: (iface, inst, h) => {
            if (/ProjectedModeGuiding$/.test(iface)) h.waypoints(route(guiding).waypoints);
            if (/CarPlayManager$/.test(iface)) { h.projectedGuidanceActive(guiding); h.projectedGuidanceMetadataAvailable(guiding); }
            return Promise.resolve({ available: true, error: null });
        },
    };
    const own = { scale: 1.165, ox: 70, oy: 36, extra: 53 };
    for (const look of ['black', 'smoked', 'outline', 'plain', 'island']) {
        guiding = look === 'black' || look === 'island';
        const h = harness('aref_eta', { signals, own, settings: look === 'island' ? { preset: 'island', island_every: '30' } : { look, layout: look === 'smoked' ? 'stacked' : 'row' } });
        await h.ready();
        await new Promise((r) => setTimeout(r, 1100));
        await h.shot('MAIN', 'app-' + look + '.png');
        if (look === 'black') { h.clicks.BTN_MORE(); await h.shot('MAIN', 'diagnostics.png'); h.clicks.BTN_BACK(); await h.widget('widget.png'); }
    }
    delete stubs['./kit/cluster_render'];
}

async function tires() {
    // values in the car's shapes (pressures and temperatures from the M440i's own log, Nov 12); the rest made up
    let dsc = 'DSC_EIN';
    const sets = [];
    const data = {
        TPMS: { statusTyrePressure: { actualValuePressureTyreFLH: 400, actualValuePressureTyreFRH: 410, actualValuePressureTyreRLH: 380, actualValuePressureTyreRRH: 370 },
            statusTyreTemperature: { actualValueTemperatureTyreFLH: 113, actualValueTemperatureTyreFRH: 112, actualValueTemperatureTyreRLH: 108, actualValueTemperatureTyreRRH: 106 },
            statusTargetTyrePressure: { targetPressureTyreFLH: 65533, targetPressureTyreFRH: 65533, targetPressureTyreRLH: 65533, targetPressureTyreRRH: 65533 },
            statusTyreState: { statusSelectionTyre: 'AUSWAHL', lengthObjectListTypeTyre: 3, statusTyreSeasonTyrePressureControl: 'SOMMERREIFEN', statusTargetPressureLoadingConditionTyrePressureControl: 'ECO_SOLLDRUCK', statusManualSelection: 'MANUELLE_REIFENAUSWAHL' },
            statusFrontAxleTyre: { widthFrontAxleTypeTyre: 225, relationSideFrontAxleTypeTyre: 40, radiusFrontAxleTypeTyre: 19, indexLoadCapacityFrontAxleTypeTyre: 93, indexSpeedFrontAxleTypeTyre: 'W', carcassFrontAxleTypeTyre: 'REIFEN_XL', seasonFrontAxleTypeTyre: 'SOMMERREIFEN', runflatFrontAxleTypeTyre: 'RUNFLAT' },
            statusRearAxleTyre: { widthRearAxleTypeTyre: 254, relationSideRearAxleTypeTyre: 35, radiusRearAxleTypeTyre: 19, indexLoadCapacityRearAxleTypeTyre: 96, indexSpeedRearAxleTypeTyre: 'W', carcassRearAxleTypeTyre: 'REIFEN_XL', seasonRearAxleTypeTyre: 'SOMMERREIFEN', runflatRearAxleTypeTyre: 'RUNFLAT' },
        },
        TPMSInternalData: { statusWheelTypeChange: { statusWheelTypeChangePosition: 0, statusWheelTypeChangeDetection: 'RDC_DEGRADIERT_KEIN_PASSENDER_REIFEN_GEFUNDEN' },
            tpmsCalibrationData: { tpmsCalibrationPlausibility: 'FAILED', tpmsCalibrationCalibrationType: 'ERFS_HMI_USER_INITIATED_SELECTION', tpmsCalibrationMileage: 118590 },
            tpmsErfsActualTireData: { tpmsErfsActTireDimSummerMounted: 'TIRE_MOUNTED' } },
        Vehicle2: { statusCarSpeed2: { speedVehicleCentreOfGravity: 0 } },
    };
    const list = [[225, 40, 19, 93], [225, 45, 18, 95], [245, 40, 18, 97]];
    const signals = {
        watch: (iface, inst, h) => {
            const k = iface.split('.').pop();
            if (k === 'FES') h.statusDSCSwitchHMI({ displayStatusDSC2: dsc });
            Object.keys(data[k] || {}).forEach((f) => h[f] && h[f](data[k][f]));
            if (k === 'TPMS') list.forEach((t, i) => h.statusAvailableTypeTyreList({ widthTypeTyre: t[0], relationSideTypeTyre: t[1], radiusTypeTyre: t[2], indexLoadCapacityTypeTyre: t[3], indexSpeedTypeTyre: 'W', carcassTypeTyre: 'REIFEN_XL', seasonTypeTyre: 'SOMMERREIFEN', runflatTypeTyre: 'RUNFLAT', statusTyreObjectListID: i + 1 }));
            const proxy = { tag: k, h };
            if (k === 'FES') signals.fes = (v) => h.statusDSCSwitchHMI(v);
            return Promise.resolve({ available: true, error: null, proxy });
        },
        set: (p, field, v) => { sets.push([field, v]); if (signals.flip) signals.fes({ displayStatusDSC2: 'DSC_AUS' }); return Promise.resolve(); },
    };
    const own = { scale: 1.165, ox: 70, oy: 36, extra: 53 };
    const h = harness('aref_tires', { signals, own, settings: { allow_writes: true } });
    await h.ready();
    await h.shot('MAIN', 'status.png');
    h.clicks.BTN_VIEW(); h.clicks.BTN_LNEXT(); await h.shot('MAIN', 'tire-list.png');
    // a write: pressed twice, DSC stays on
    h.clicks.BTN_RESET(); h.clicks.BTN_RESET();
    await new Promise((r) => setTimeout(r, 4300));
    // a write after which DSC changes (simulated): the alarm
    signals.flip = true; h.clicks.BTN_TEST(); h.clicks.BTN_TEST();
    await new Promise((r) => setTimeout(r, 4300));
    h.clicks.BTN_LOG(); await h.shot('MAIN', 'log.png');
    const dscOk = sets.every((s) => s[1].operationModeTractionDSC === 'SIGNAL_UNGUELTIG');
    console.log('tires: ' + sets.length + ' writes, DSC member left alone in every one: ' + dscOk);
    console.log(fs.readFileSync(path.join(h.ctx.dataDir, 'tires.log'), 'utf8').split('\n').filter((l) => /WRITE|DSC|ALARM/.test(l)).join('\n'));
}

(async () => {
    const only = process.argv[2];
    const all = { carcare: carCare, drivelog: driveLog, faultwatch: faultWatch, carlyrics: carLyrics, explorer, misfire, carwatch: carWatch, eta, tires };
    for (const k of Object.keys(all)) if (!only || only === k) await all[k]();
    Date.now = realNow;
    setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
