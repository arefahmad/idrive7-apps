'use strict';
/**
 * Tire Setup: the tire pressure monitor (RDC) as the car sees it, in plain English, and the iDrive tire menu's
 * own actions (get the tire list, pick a tire, auto detect, reset, season, load) sent from here.
 *
 * Reads: TPMS (pressures, temperatures, targets, tire state, the tire list, fitted front / rear tire, the
 * chassisControl struct), TPMSInternalData (why auto detect fails, the last reset, what the sensors say is
 * fitted, QR data, the radio receiver), FES.statusDSCSwitchHMI (DSC on / off) and the car's speed.
 *
 * Writes: only TPMS.chassisControl, the struct the HMI's tire menu sends. It also carries the DSC request, so:
 *   - every write is built by decode.js build(): all members "no request", the DSC member SIGNAL_UNGUELTIG,
 *     checked again right before sending (check());
 *   - only with "Allow changes" on in Settings, parked (speed 0), DSC state known, pressed twice;
 *   - the DSC state is read before and 1.5 s and 4 s after; a change raises an alarm, logs it, and DSC on
 *     (the only write that names DSC, and only DSC_EINSCHALTEN) puts it back. The DSC button and every new
 *     start of the car also turn DSC back on.
 * Everything goes to tires.log in the data folder (the homelab collects it).
 * Node 8 only. Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');
const T = require('./decode');

const VERSION = '0.1.1';
const W = 1600, H = 520;
const LOG_MAX = 512 * 1024;
const ARM_MS = 5000;                  // a change button pressed again within this sends it
const DSC_CHECKS = [1500, 4000];      // ms after a write: DSC read again
const WATCH = [
    { iface: 'de.bmw.infotainment.vehicle.TPMS', tag: 'tpms', fields: ['statusTyrePressure', 'statusTyreTemperature', 'statusTargetTyrePressure',
        'statusTyreState', 'statusAvailableTypeTyreList', 'statusFrontAxleTyre', 'statusRearAxleTyre', 'statusSummerTyre', 'statusWinterTyre',
        'statusTyresStatus', 'chassisControl'] },
    { iface: 'de.bmw.infotainment.vehicle.TPMSInternalData', tag: 'rdc', fields: ['statusWheelTypeChange', 'tpmsCalibrationData',
        'tpmsErfsActualTireData', 'qrCodeData', 'tyreDataRadioReceiver', 'tpmsInternalLastValues'] },
    { iface: 'de.bmw.infotainment.drivingexcitement.FES', tag: 'fes', fields: ['statusDSCSwitchHMI'] },
    { iface: 'de.bmw.infotainment.vehicle.Vehicle2', tag: 'car', fields: ['statusCarSpeed2'] },
];
// noisy values: shown at once, logged at most this often
const NOISY = /statusTyrePressure|statusTyreTemperature|statusCarSpeed2|tpmsInternalLastValues/;
const NOISY_MS = 60000;

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const base = require('./kit/themes').theme('m_tricolour');
            const CARPLAY = Object.assign({}, base, { name: 'CarPlay', bg: '#000000', panelTop: '#1c1c1e', panelBottom: '#1c1c1e', panelEdge: '#38383a',
                track: '#2c2c2e', tick: '#636366', text: '#ffffff', dim: '#98989f', accent: '#0a84ff', accent2: '#64d2ff', ok: '#30d158', warn: '#ff9f0a',
                crit: '#ff453a', sel: '#0a84ff', selText: '#ffffff', marker: '#0a84ff', glow: '#0a84ff40', stripes: ['#0a84ff'] });
            if (ctx.setTheme) ctx.setTheme(() => CARPLAY);
            const F = { bold: 'bold', med: 'label' };
            try {
                const dirs = [path.join(__dirname, 'fonts'), path.join(__dirname, 'data', 'fonts')];
                const src = pack.open(dirs.find((d) => fs.existsSync(d + '.pack') || fs.existsSync(d)) || dirs[0]);
                if (fonts.register('tw_bold', src.json('cl_bold.json'))) F.bold = 'tw_bold';
                if (fonts.register('tw_med', src.json('cl_med.json'))) F.med = 'tw_med';
            } catch (e) { log.warn('fonts: ' + e.message); }

            /* ---------- the log ---------- */
            const FILE = path.join(ctx.dataDir, 'tires.log');
            const json = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
            const write = (line) => {
                try {
                    try { if (fs.statSync(FILE).size > LOG_MAX) fs.renameSync(FILE, FILE + '.1'); } catch (e) { /* none yet */ }
                    fs.appendFileSync(FILE, new Date().toISOString() + ' ' + line + '\n');
                } catch (e) { /* full disk */ }
            };
            const history = [];               // the screen's Log view
            const note = (line) => { write(line); try { log.info(line); } catch (e) { /* */ } history.push({ at: Date.now(), line: line }); if (history.length > 40) history.shift(); };
            note('start ' + VERSION);

            /* ---------- reading ---------- */
            const vals = {}, proxies = {}, subs = [];
            const list = {};                  // tire list: id -> entry (the car sends it one entry at a time)
            const put = (key, v) => {
                const s = json(v), old = vals[key];
                if (old && old.s === s) return;
                const now = Date.now();
                vals[key] = { v: v, s: s, at: now, logged: old ? old.logged : 0 };
                if (key === 'tpms.statusAvailableTypeTyreList') { const e = T.listEntry(v); if (e) list[e.id] = e; }
                if (NOISY.test(key) && old && now - old.logged < NOISY_MS) return;
                vals[key].logged = now;
                write(key + ' = ' + (s.length > 4000 ? s.slice(0, 4000) + '...' : s));
            };
            WATCH.forEach((w) => {
                const handlers = {};
                w.fields.forEach((f) => { handlers[f] = guard(w.tag + '.' + f, (v) => put(w.tag + '.' + f, v)); });
                ctx.signals.watch(w.iface, '1', handlers, log, { pollMs: 10000 }).then((sub) => {
                    subs.push({ tag: w.tag, available: sub.available, error: sub.error });
                    if (sub.proxy) proxies[w.tag] = sub.proxy;
                    write('subscribed ' + w.tag + ': ' + (sub.available ? 'available' : 'not available') + (sub.error ? ' (' + sub.error + ')' : ''));
                }, (e) => { subs.push({ tag: w.tag, available: false, error: e.message }); write('subscribe ' + w.tag + ' failed: ' + e.message); });
            });
            const val = (k) => (vals[k] ? vals[k].v : undefined);
            const speedKmh = () => { const v = val('car.statusCarSpeed2'); const r = v && v.speedVehicleCentreOfGravity; return typeof r === 'number' && r < 65535 ? r * 0.015625 : null; };
            const parked = () => { const s = speedKmh(); return s !== null && s < 0.5; };
            const dscNow = () => T.dsc(val('fes.statusDSCSwitchHMI'));

            /* ---------- writing ---------- */
            let busy = false, alarm = null, armed = null, toast = null;
            const say = (text, tone, ms) => { toast = { text: text, tone: tone || 'info', until: Date.now() + (ms || 5000) }; };
            const LABEL = { list: 'Get the tire list', auto: 'Auto detect', pick: 'Use this tire', reset: 'Reset pressures', summer: 'Summer tires',
                winter: 'Winter tires', eco: 'Eco pressures', partly: 'Partly loaded', full: 'Fully loaded', test: 'Safe test' };
            // why a change can't be sent now, or null
            const blocked = () => {
                if (!settings.get('allow_writes')) return 'Changes are off. Turn on Settings > Allow changes to the car.';
                if (!proxies.tpms) return 'Not connected to the tire monitor yet.';
                if (busy) return 'Still checking the last change.';
                if (alarm) return 'DSC changed after the last write. Turn DSC back on first.';
                if (!parked()) return speedKmh() === null ? 'The car\'s speed isn\'t known yet.' : 'Only while parked.';
                const d = dscNow();
                if (!d) return 'DSC state isn\'t known yet, so nothing is sent.';
                if (d.state !== 'on') return 'DSC isn\'t on (' + d.state + '). Turn it on first.';
                return null;
            };
            const send = (action, arg) => {
                const why = blocked();
                if (why) { say(why, 'warn'); return; }
                const key = action + (arg !== undefined ? ':' + arg : '');
                if (!armed || armed.key !== key || Date.now() > armed.until) {
                    armed = { key: key, until: Date.now() + ARM_MS };
                    say('Press ' + LABEL[action] + ' again to send it to the car.', 'info', ARM_MS);
                    return;
                }
                armed = null;
                let struct;
                try { struct = action === 'test' ? Object.assign({}, T.NO_ACTION) : T.build(action, arg); T.check(struct); } catch (e) { note('WRITE refused ' + key + ': ' + e.message); say(e.message, 'bad'); return; }
                const before = dscNow();
                busy = true;
                note('WRITE ' + key + ' ' + json(struct) + ' | DSC before: ' + before.raw);
                say('Sending ' + LABEL[action] + '...', 'info');
                Promise.resolve().then(() => ctx.signals.set(proxies.tpms, 'chassisControl', struct)).then(
                    () => { note('WRITE accepted ' + key); say(LABEL[action] + ': the car took it. Checking DSC...', 'ok'); },
                    (e) => { note('WRITE failed ' + key + ': ' + (e && e.message || e)); say('The car refused it: ' + (e && e.message || e), 'bad', 8000); });
                DSC_CHECKS.forEach((ms, i) => setTimeout(guard('dsc check', () => {
                    const d = dscNow();
                    note('DSC after ' + ms + ' ms: ' + (d ? d.raw : 'unknown') + ' | chassisControl now ' + (vals['tpms.chassisControl'] ? vals['tpms.chassisControl'].s : '-'));
                    if (d && before && d.raw !== before.raw && !alarm) {
                        alarm = { at: Date.now(), from: before.state, to: d.state, action: key };
                        note('ALARM DSC changed ' + before.raw + ' -> ' + d.raw + ' after ' + key);
                    }
                    if (i === DSC_CHECKS.length - 1) {
                        busy = false;
                        if (!alarm) say(LABEL[action] + ' sent. DSC stayed ' + (d ? d.state : 'unknown') + '.', 'ok', 6000);
                    }
                }), ms));
            };
            // DSC back on: the only write that names DSC, and only to turn it on
            const dscOn = () => {
                if (!proxies.tpms) { say('Not connected yet. Press the DSC button on the console.', 'warn'); return; }
                const d = dscNow();
                if (d && d.state === 'on' && !alarm) { say('DSC is already on.', 'ok'); return; }
                const struct = Object.assign({}, T.NO_ACTION, { operationModeTractionDSC: 'DSC_EINSCHALTEN' });
                note('WRITE dsc-on ' + json(struct));
                Promise.resolve().then(() => ctx.signals.set(proxies.tpms, 'chassisControl', struct)).then(() => note('WRITE accepted dsc-on'), (e) => note('WRITE failed dsc-on: ' + (e && e.message || e)));
                setTimeout(guard('dsc on check', () => {
                    const n = dscNow();
                    note('DSC after dsc-on: ' + (n ? n.raw : 'unknown'));
                    if (n && n.state === 'on') { alarm = null; say('DSC is on again.', 'ok'); } else say('DSC still isn\'t on. Press the DSC button on the console.', 'bad', 10000);
                }), 2000);
            };

            /* ---------- buttons ---------- */
            let view = 'status', cursor = 0;
            const ids = () => Object.keys(list).map(Number).sort((a, b) => a - b);
            const setView = (v) => { view = v; try { ui.text('BTN_VIEW', view === 'status' ? 'Tire list' : 'Status'); } catch (e) { /* */ } };
            ui.onClick('BTN_VIEW', guard('view', () => setView(view === 'status' ? 'list' : 'status')));
            ui.onClick('BTN_LOG', guard('log', () => setView(view === 'log' ? 'status' : 'log')));
            ui.onClick('BTN_GETLIST', guard('list', () => { setView('list'); send('list'); }));
            ui.onClick('BTN_LPREV', guard('prev', () => { setView('list'); cursor = Math.max(0, cursor - 1); }));
            ui.onClick('BTN_LNEXT', guard('next', () => { setView('list'); cursor = Math.min(Math.max(0, ids().length - 1), cursor + 1); }));
            ui.onClick('BTN_PICK', guard('pick', () => {
                const id = ids()[cursor];
                if (id === undefined) { setView('list'); say('Get the tire list first.', 'warn'); return; }
                send('pick', id);
            }));
            ui.onClick('BTN_AUTO', guard('auto', () => send('auto')));
            ui.onClick('BTN_RESET', guard('reset', () => send('reset')));
            ui.onClick('BTN_SEASON', guard('season', () => { const st = T.tyreState(val('tpms.statusTyreState')); send(st && st.season === 'summer' ? 'winter' : 'summer'); }));
            ui.onClick('BTN_TEST', guard('test', () => send('test')));
            ui.onClick('BTN_DSC', guard('dsc', dscOn));

            /* ---------- drawing ---------- */
            const C = { bg: '#000000', card: '#1c1c1e', card2: '#2c2c2e', edge: '#38383a', text: '#ffffff', dim: '#98989f', dim2: '#636366',
                green: '#30d158', orange: '#ff9f0a', red: '#ff453a', blue: '#0a84ff' };
            const TONE = { ok: C.green, busy: C.orange, bad: C.red, warn: C.orange, info: C.blue, dim: C.dim2 };
            const B = { font: F.bold, literal: true }, M = { font: F.med, literal: true };
            const fit = (cv, s, size, w, opt) => {
                s = String(s == null ? '' : s);
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            const card = (cv, x, y, w, h) => cv.roundRect(x, y, w, h, 20, C.card);
            const kv = (cv, x, y, w, k, v, c) => { cv.text(k, x, y, 19, C.dim, M); cv.text(fit(cv, v || '-', 22, w * 0.6, B), x + w, y, 22, c || C.text, Object.assign({ align: 'right' }, B)); };

            const drawStatus = (cv) => {
                const det = T.detection(val('rdc.statusWheelTypeChange'));
                const tone = det ? TONE[det.tone] || C.dim : C.dim2;
                cv.circle(52, 68, 8, tone);
                cv.text(fit(cv, det ? det.title : 'Waiting for the tire monitor', 30, 900, B), 72, 79, 30, C.text, B);
                cv.text(fit(cv, det ? det.text : 'Turn the car on. The values come in within a few seconds.', 19, 1480, M), 72, 108, 19, C.dim, M);
                // the four tires, laid out like the car seen from above
                const P = T.pressures(val('tpms.statusTyrePressure')), TT = T.temps(val('tpms.statusTyreTemperature')), TG = T.targets(val('tpms.statusTargetTyrePressure'));
                const tx = 40, ty = 132, tw = 300, th = 150;
                [['FLH', 0, 0], ['FRH', 1, 0], ['RLH', 0, 1], ['RRH', 1, 1]].forEach((q) => {
                    const x = tx + q[1] * (tw + 14), y = ty + q[2] * (th + 14), p = P[q[0]], t = TT[q[0]], g = TG[q[0]];
                    card(cv, x, y, tw, th);
                    cv.text(T.WHEEL[q[0]], x + 22, y + 34, 18, C.dim, M);
                    cv.text(p === null ? '--' : p.toFixed(1), x + 22, y + 94, 52, C.text, B);
                    cv.text('psi', x + 26 + cv.textWidth(p === null ? '--' : p.toFixed(1), 52, B), y + 94, 22, C.dim, M);
                    cv.text(fit(cv, (t === null ? '' : t + '°F   ') + (g === null ? 'Target not set' : 'Target ' + g.toFixed(1)), 18, tw - 44, M), x + 22, y + 128, 18, g === null ? C.orange : C.dim, M);
                });
                // the details
                const dx = 40 + 2 * (tw + 14) + 6, dw = W - 40 - dx;
                card(cv, dx, ty, dw, 2 * th + 14);
                const st = T.tyreState(val('tpms.statusTyreState')), cal = T.calibration(val('rdc.tpmsCalibrationData'));
                const fa = T.frontAxle(val('tpms.statusFrontAxleTyre')), ra = T.rearAxle(val('tpms.statusRearAxleTyre')), se = T.sensorTire(val('rdc.tpmsErfsActualTireData'));
                const d = dscNow(), sp = speedKmh();
                const rows = [
                    ['Car thinks fitted (front)', fa ? fa.text : null],
                    ['Car thinks fitted (rear)', ra ? ra.text : null],
                    ['Sensors say fitted', se && se.tire ? se.tire.text : se ? (se.mounted ? 'mounted, no size stored' : 'no tire data in the sensors') : null],
                    ['Tire picked', st ? [st.mode, st.selection].filter(Boolean).join(', ') : null],
                    ['Last reset', cal ? cal.type + (cal.mileage ? ' at ' + Math.round(cal.mileage / 1.609344).toLocaleString('en-US') + ' mi' : '') : null],
                    ['Reset result', cal ? cal.result : null, cal ? TONE[cal.tone] : null],
                    ['Season / load', st ? [st.season, st.loading].filter(Boolean).join(', ') : null],
                    ['DSC', d ? d.state.charAt(0).toUpperCase() + d.state.slice(1) : 'unknown', d && d.state === 'on' ? C.green : C.orange],
                    ['Parked', sp === null ? 'unknown' : sp < 0.5 ? 'Yes' : 'No (' + Math.round(sp / 1.609) + ' mph)'],
                ];
                rows.forEach((r, i) => kv(cv, dx + 26, ty + 36 + i * 32, dw - 52, r[0], r[1], r[2]));
                cv.text(settings.get('allow_writes') ? 'Changes to the car: allowed (parked, DSC on, press twice)' : 'Changes to the car: off (Settings)', 40, 470, 17, C.dim2, M);
            };
            const drawList = (cv) => {
                const all = ids(), st = T.tyreState(val('tpms.statusTyreState'));
                cv.text('The car\'s tire list', 40, 76, 30, C.text, B);
                cv.text(all.length ? all.length + (st && st.listLength ? ' of ' + st.listLength : '') + ' tires. Previous / Next to choose, Use this tire to pick it.' : 'Press Get list: the car sends its list one tire at a time.', 40, 104, 19, C.dim, M);
                card(cv, 40, 124, W - 80, 340);
                const per = 8, first = Math.max(0, Math.min(cursor - 3, all.length - per));
                all.slice(first, first + per).forEach((id, i) => {
                    const e = list[id], y = 132 + i * 41, on = first + i === cursor;
                    if (on) cv.roundRect(48, y, W - 96, 38, 12, C.card2);
                    cv.text(String(id), 70, y + 27, 19, C.dim, M);
                    cv.text(fit(cv, e.text, 22, W - 260, on ? B : M), 120, y + 27, 22, C.text, on ? B : M);
                });
                if (!all.length) cv.text('No list yet', W / 2, 300, 24, C.dim2, Object.assign({ align: 'center' }, M));
            };
            const drawLog = (cv) => {
                cv.text('What the app sent', 40, 76, 30, C.text, B);
                cv.text('Every write, the DSC state before and after, and what the car answered. Saved to tires.log.', 40, 104, 19, C.dim, M);
                card(cv, 40, 124, W - 80, 340);
                history.slice(-11).forEach((h, i) => {
                    const c = /ALARM|failed|refused/.test(h.line) ? C.red : /WRITE/.test(h.line) ? C.text : C.dim;
                    cv.text(fit(cv, new Date(h.at).toTimeString().slice(0, 8) + '  ' + h.line, 16, W - 140, M), 64, 154 + i * 29, 16, c, M);
                });
            };
            ctx.loop('MAIN', 2, guard('draw', async () => {
                const cv = ctx.canvas(W, H).clear(C.bg), now = Date.now();
                if (view === 'list') drawList(cv); else if (view === 'log') drawLog(cv); else drawStatus(cv);
                if (alarm) {
                    cv.fillRect(0, 38, W, 82, C.bg);
                    cv.roundRect(40, 42, W - 80, 74, 18, C.red);
                    cv.text('DSC went from ' + alarm.from + ' to ' + alarm.to + ' after a write', 70, 74, 24, '#ffffff', B);
                    cv.text('Press DSC on here, or the DSC button on the console. A new start of the car also turns it on.', 70, 102, 18, '#ffffff', M);
                }
                if (toast && now < toast.until) {
                    const w = Math.min(W - 80, cv.textWidth(toast.text, 20, M) + 56);
                    cv.roundRect((W - w) / 2, 472, w, 42, 21, C.card2);
                    cv.circle((W - w) / 2 + 22, 493, 6, TONE[toast.tone] || C.blue);
                    cv.text(fit(cv, toast.text, 20, w - 56, M), (W - w) / 2 + 38, 500, 20, C.text, M);
                }
                await ui.image('MAIN_GFX', cv);
            }));
            log.info('started ' + VERSION);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
