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
        canvas: (w, h) => new Recorder(w, h),   // what the car gives an app to draw on: a recording
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
            const rec = images[screen + '_GFX'], cv = new Canvas(rec.w, rec.h);
            play(rec.words(), cv);                // played back into pixels, as the car does without the GPU renderer
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
Date.now = () => NOW;
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

async function carLyrics() {
    // made-up lyrics for a made-up song: nothing here is anyone's work
    const lrc = ['[00:10.00]Headlights on the empty road', '[00:14.50]Counting every mile we owe', '[00:19.00]Radio low, the windows down',
        '[00:23.50]Leaving all the lights of town', '[00:28.00]', '[00:31.00]And the night keeps rolling on', '[00:35.50]Like the last line of a song'].join('\n');
    const signals = {
        loadConfig: () => ({ instances: ['Inst1'], fields: { nowPlaying: {}, playbackPosition: {} } }),
        watch: (iface, inst, handlers) => {
            if (/CarPlay/.test(iface)) { handlers.nowPlaying({ title: 'Night Drive', artist: 'Sample Artist', album: 'Demo Tapes', duration: 212 }); handlers.playbackPosition(24); }
            return Promise.resolve({ available: true, error: null });
        },
    };
    stubs['./http'] = { client: () => ({ online: () => true, request: () => Promise.resolve({ status: 200, body: Buffer.from(JSON.stringify({ syncedLyrics: lrc })) }) }) };
    const h = harness('aref_carlyrics', { signals });
    await h.ready();
    await h.shot('MAIN', 'lyrics.png');           // the first frame starts the lookup
    await new Promise((r) => setTimeout(r, 50));
    await h.shot('MAIN', 'lyrics.png');
    await h.shot('PROBE', 'probe.png');
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
    delete process.env.MGU_EXPLORER_ROOT;
}

(async () => {
    const only = process.argv[2];
    const all = { carcare: carCare, drivelog: driveLog, faultwatch: faultWatch, carlyrics: carLyrics, explorer };
    for (const k of Object.keys(all)) if (!only || only === k) await all[k]();
    Date.now = realNow;
    setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
