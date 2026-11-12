'use strict';
/**
 * Car Watch: Misfire Watch, Fault Watch and Drive Log in one background app (one process instead of three,
 * about 120 MB less of the head unit's memory). Starts with the car.
 *
 * The three sections are the old apps' code (sections/sec_*.js), each given its own view of this app:
 *   - one shared car-data reader (kit/car.js) with every signal group the three used, and one diagnostic link
 *     (kit/diag.js; it already sorts each reply to the request that asked for it);
 *   - their own buttons (ids prefixed MF_, FW_, DL_), shown only while their section is on screen;
 *   - their own settings (prefixed mf_, fw_, dl_; theme and units shared);
 *   - their own data files, under the old names, in this app's data folder.
 * Section switches the screen: Misfires, Faults, Drives. The home-screen widget sums up all three.
 *
 * First start: the old apps' history is imported (importOld): from the copy their last versions leave in
 * /dev/shm (Misfire Watch 0.1.1, Fault Watch 0.2.2, Drive Log 0.3.2), else from their data folders if this
 * app may read them. A file this app already has is never replaced.
 *
 * Read-only toward the car, as the three were. Node 8 only. Nothing may throw out of a callback.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { Diag } = require('./kit/diag');
const HW = require('./kit/homewidget');
const SECTIONS = [
    { key: 'misfire', title: 'Misfires', prefix: 'MF_', set: 'mf_', start: require('./sec_misfire'), old: 'aref_misfire', files: ['misfires.json', 'misfires.csv'] },
    { key: 'faults', title: 'Faults', prefix: 'FW_', set: 'fw_', start: require('./sec_faults'), old: 'aref_faultwatch', files: ['faultwatch.json'] },
    { key: 'drives', title: 'Drives', prefix: 'DL_', set: 'dl_', start: require('./sec_drives'), old: 'aref_drivelog', files: ['drivelog.json', 'drives.csv'] },
];
const SHARED_SETTINGS = ['theme', 'units'];
const VERSION = '0.1.1';
const BUTTONS = ['MF_VIEW', 'MF_MORE', 'MF_SAVE', 'FW_SCAN', 'FW_VIEW', 'FW_MORE', 'DL_VIEW', 'DL_DRAGY', 'DL_EXPORT', 'DL_MORE',
    'DL_UP', 'DL_DOWN', 'DL_UP2', 'DL_DOWN2', 'DL_SAVE', 'DL_SKIP'];

/** The old apps' file: the newest readable copy, from their handoff folder or their own data folder. */
function findOld(oldId, name, log) {
    const cands = [path.join('/dev/shm', 'aref-handoff-' + oldId, name)];
    try {
        // their data folders (readable only if the system allows it): the folder that holds <old id>.log
        const base = '/var/opt/public/oap';
        fs.readdirSync(base).forEach((d) => {
            ['data', 'source/data'].forEach((sub) => {
                const dir = path.join(base, d, sub);
                try { if (fs.existsSync(path.join(dir, oldId + '.log'))) cands.push(path.join(dir, name)); } catch (e) { /* not readable */ }
            });
        });
    } catch (e) { /* no access */ }
    let best = null;
    cands.forEach((p) => {
        try { const st = fs.statSync(p); fs.accessSync(p, fs.constants.R_OK); if (!best || st.mtimeMs > best.t) best = { p: p, t: st.mtimeMs }; } catch (e) { /* not there */ }
    });
    if (best) log.info('import: ' + name + ' from ' + best.p);
    return best && best.p;
}
function importOld(dataDir, log) {
    const out = [];
    SECTIONS.forEach((s) => s.files.forEach((name) => {
        const dst = path.join(dataDir, name);
        if (fs.existsSync(dst)) return;
        const src = findOld(s.old, name, log);
        if (!src) { if (/\.json$/.test(name)) out.push(name + ': nothing to import'); return; }
        try {
            const body = fs.readFileSync(src);
            if (/\.json$/.test(name)) JSON.parse(body.toString('utf8'));       // only a whole file
            fs.writeFileSync(dst, body);
            out.push(name + ': imported (' + Math.round(body.length / 1024) + ' KB)');
        } catch (e) { out.push(name + ': import failed (' + e.message + ')'); }
    }));
    out.forEach((l) => log.info('import: ' + l));
    return out;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const imported = importOld(ctx.dataDir, log);
            const car = new Car(ctx, ['rpm', 'speed', 'accel', 'temps', 'gear', 'torque', 'drivemode'], { demo: false });
            const diag = new Diag(ctx.signals, log);
            diag.quiet = true; diag.busyLog = false;
            await diag.init();

            let active = 0;
            const want = {};          // button id -> what its section wants (visible or not)
            const labels = {};        // button id -> its section's text
            /** Show or hide a bar button on both bars (the HMI's own, and the one the kit draws with the renderer). */
            const show = (id, on) => {
                const D = ctx.display;
                ui.visible(id, on && !(D && D.hmiBarHidden));
                if (D && D.ownHidden) {
                    if (on) D.ownHidden.delete(id); else D.ownHidden.add(id);
                    D._btns = null;
                    if (D.place && typeof D._place === 'function') D._place();
                }
            };
            const apply = () => {
                Object.keys(want).forEach((id) => show(id, want[id] && id.indexOf(SECTIONS[active].prefix) === 0));
                Object.keys(labels).forEach((id) => { if (id.indexOf(SECTIONS[active].prefix) === 0) ui.text(id, labels[id]); });
                ui.text('BTN_SECTION', 'Show ' + SECTIONS[(active + 1) % SECTIONS.length].title);
            };
            const layouts = [];
            ctx.onLayout(guard('layout', () => { layouts.forEach((f) => { try { f(); } catch (e) { /* its own guard logs */ } }); apply(); }));

            const draws = [], widgets = [];
            // the import's result, over the screen for the first 30 s
            let note = imported.some((l) => /imported|failed/.test(l)) ? { text: 'From the old apps: ' + imported.join('  ·  '), until: Date.now() + 30000 } : null;
            const banner = (cv) => {
                if (!note) return;
                if (Date.now() > note.until) { note = null; return; }
                const L = { literal: true }, W = cv.w, H = cv.h;
                let s = note.text;
                while (s.length > 1 && cv.textWidth(s, 18, L) > W - 120) s = s.slice(0, -1);
                const w = cv.textWidth(s, 18, L) + 60;
                cv.roundRect((W - w) / 2, H - 64, w, 44, 22, '#2a2b31');
                cv.text(s, W / 2, H - 36, 18, '#ffffff', { align: 'center', literal: true });
            };
            const subCtx = (s, i) => {
                const id = (b) => (b === 'BTN_SETTINGS' ? b : s.prefix + b.replace(/^BTN_/, ''));
                const sui = {
                    onClick: (b, fn) => ui.onClick(id(b), fn),
                    text: (b, t) => { labels[id(b)] = t; if (active === i) return ui.text(id(b), t); return Promise.resolve(); },
                    visible: (b, on) => { want[id(b)] = on; if (active === i) show(id(b), on); return Promise.resolve(); },
                    image: (name, cv) => { if (active !== i) return Promise.resolve(); banner(cv); return ui.image(name, cv); },
                };
                const sset = Object.create(settings);
                sset.get = (k) => settings.get(SHARED_SETTINGS.indexOf(k) >= 0 ? k : s.set + k);
                return Object.assign(Object.create(ctx), {
                    ui: sui, settings: sset, car: car, diag: diag, display: null,
                    onLayout: (fn) => layouts.push(fn),
                    loop: (fps, fn) => { draws[i] = fn; },
                    widget: (fn) => { widgets[i] = fn; },
                });
            };
            // every section's buttons start hidden but for the first section's; sections set their own after
            BUTTONS.forEach((b) => { want[b] = true; });
            for (let i = 0; i < SECTIONS.length; i++) {
                try { await SECTIONS[i].start(subCtx(SECTIONS[i], i)); } catch (e) { log.error('section ' + SECTIONS[i].key + ': ' + (e && e.stack || e)); }
            }
            apply();
            ui.onClick('BTN_SECTION', guard('section', () => { active = (active + 1) % SECTIONS.length; apply(); }));

            ctx.loop('MAIN', 4, guard('draw', async () => {
                const f = draws[active];
                if (f) await f();
            }));

            HW.start(ctx, () => {
                const w = widgets.map((f) => { try { return f ? f() : null; } catch (e) { return null; } });
                const mf = w[0] || {}, fw = w[1] || {}, dl = w[2] || {};
                const tone = [mf.tone, fw.tone].indexOf('crit') >= 0 ? 'crit' : [mf.tone, fw.tone].indexOf('warn') >= 0 ? 'warn' : 'ok';
                const n = /^\d+/.exec(mf.value || '');
                return { label: 'Car Watch', value: n ? n[0] + ' misfire' + (n[0] === '1' ? '' : 's') : mf.value ? 'No misfires' : 'Misfires: -', sub: fw.value ? 'Faults: ' + fw.value + (fw.sub ? ', ' + fw.sub : '') : 'Faults: no scan yet',
                    sub2: dl.small ? dl.small[0] : '', tone: tone, small: [(mf.small || ['Misfires: -'])[0], fw.value ? 'Faults: ' + fw.value : 'Faults: no scan yet'] };
            });
            log.info('started ' + VERSION);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
