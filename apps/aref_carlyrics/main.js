'use strict';
/**
 * Car Lyrics: synced lyrics for whatever the car is playing (Apple Music over CarPlay, Bluetooth, USB),
 * with no Spotify and no phone app. The track comes from the head unit itself (car/nowplaying.js), the
 * lyrics from LRCLIB (stage/lyrics.js, from G's Music).
 *
 * Version 0.1 is also a probe: which interface and field carry the CarPlay track on iDrive 7 is not
 * known yet, so the Probe screen shows every value the car reports and the interfaces in its catalog
 * that look like media. The same goes to the app's log and to carlyrics-probe.txt in its data folder.
 *
 * Read-only toward the car: it subscribes to and reads fields, never calls a method or writes a value.
 *
 * Node 8 only (the car's version): no ?. ?? import, object spread, flat(), class fields, optional catch
 * binding. Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const NP = require('./nowplaying');
const LyricsLib = require('./lyrics');
const http = require('./http');

const VERSION = '0.1.0';
const HOMEPAGE = 'https://github.com/arefahmad/idrive7-apps';
const W = 1600, H = 520;
const IFACES = [
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
    { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
];
const LEAD_MS = 250;              // a line shows this much before its time (reading takes a moment)
const SCROLL_MS = 300;            // a new line slides into the middle over this long
const TICK_CAP_MS = 2500;         // a position the car keeps sending: no guessing further than this past it
const REPORT_MS = 60000;          // carlyrics-probe.txt is written again this often (when anything changed)

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const net = http.client(ctx.dataDir);
            const lyrics = new LyricsLib.Lyrics((m, h, p, hd) => net.request(m, h, p, hd), log,
                'CarLyrics/' + VERSION + ' (iDrive 7 head-unit app; ' + HOMEPAGE + ')');
            const np = new NP.NowPlaying(ctx.signals, log, IFACES);
            let catalog = { error: 'not read yet', hits: [] };
            let toast = null;
            const say = (text, ms) => { toast = { text: text, until: Date.now() + (ms || 3000) }; };

            /* ---------- the track and where in it we are ---------- */
            let cur = null;           // { key, title, artist, album, duration }
            let startAt = Date.now(); // estimated: when the track began (ms epoch)
            let posVal = null, posAt = 0, posTicks = 0;   // the car's own position, when it sends one
            const follow = () => {
                const t = np.track();
                if (!t) return;
                const key = t.title + '|' + t.artist;
                if (!cur || cur.key !== key) {
                    cur = { key: key, title: t.title, artist: t.artist, album: t.album, duration: t.duration || 0, from: t.from };
                    startAt = Date.now(); posVal = null; posTicks = 0;
                    log.info('track: "' + t.title + '" by "' + t.artist + '" (' + Math.round((t.duration || 0) / 1000) + ' s) from ' + t.from);
                }
                if (t.duration && !cur.duration) cur.duration = t.duration;
                if (t.position !== null && t.position !== undefined && t.position !== posVal) {
                    if (posVal !== null) posTicks++;
                    posVal = t.position; posAt = t.positionAt || Date.now();
                }
            };
            np.onChange(guard('change', follow));
            const offset = () => Number(settings.get('offset')) || 0;
            const position = () => {
                if (posVal !== null) {
                    // a position that keeps coming is followed between updates, but never guessed far past the last one
                    const dt = Date.now() - posAt;
                    return posVal + (posTicks >= 2 ? Math.min(dt, TICK_CAP_MS) : dt) + offset();
                }
                return Date.now() - startAt + offset();
            };
            const timing = () => (posVal !== null ? 'from the car' : 'estimated (tap "Song just started" to sync)');

            ui.onClick('BTN_SYNC', guard('sync', () => { startAt = Date.now(); posVal = null; posTicks = 0; say('Synced: the song starts now'); }));
            ui.onClick('BTN_PROBE', guard('probe', () => { ui.open('PROBE'); }));

            /* ---------- MAIN: the song and its lyrics ---------- */
            const fit = (cv, s, size, w, opt) => {
                s = String(s || '');
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            function drawSynced(cv, t, lines, pos) {
                const p = pos + LEAD_MS, i = LyricsLib.lineAt(lines, p);
                const e = i >= 0 ? Math.max(0, Math.min(1, (p - lines[i].t) / SCROLL_MS)) : 1;
                const sc = i >= 0 ? i - 1 + (1 - Math.pow(1 - e, 3)) : -1;
                const top = 150, bottom = H - 20, cy = 300, LH = 56, X = 80, LW = W - 160;
                cv.clip(0, top, W, bottom - top);
                for (let j = Math.floor(sc) - 2; j <= Math.floor(sc) + 3; j++) {
                    if (j < 0 || j >= lines.length) continue;
                    const y = cy + (j - sc) * LH, a = Math.max(0, 1 - Math.abs(y - cy) / 190);
                    if (a <= 0.03) continue;
                    const now = j === i, opt = { font: now ? 'bold' : undefined, literal: true };
                    let size = now ? 40 : 30;
                    const txt = lines[j].text || '·   ·   ·';
                    while (size > 24 && cv.textWidth(txt, size, opt) > LW) size -= 2;
                    cv.alpha(now ? 1 : 0.3 + 0.5 * a);
                    cv.text(fit(cv, txt, size, LW, opt), X, y + size * 0.35, size, now ? t.text : t.dim, opt);
                    cv.alpha(1);
                }
                cv.noclip();
            }
            function drawPlain(cv, t, text) {
                cv.text('LYRICS (NOT SYNCED)', W - 80, 172, 16, t.dim, { font: 'bold', align: 'right', literal: true });
                text.filter(Boolean).slice(0, 8).forEach((s, k) => cv.text(fit(cv, s, 28, W - 160), 80, 210 + k * 38, 28, k ? t.dim : t.text, { literal: true }));
            }
            function center(cv, t, a, b) {
                cv.text(a, W / 2, 290, 34, t.text, { font: 'bold', align: 'center', literal: true });
                if (b) cv.text(fit(cv, b, 24, W - 200), W / 2, 340, 24, t.dim, { align: 'center', literal: true });
            }
            ctx.loop('MAIN', 10, guard('main', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
                if (!cur) {
                    follow();
                }
                if (!cur) {
                    center(cv, t, 'Play a song on your phone', 'Looking for the track in the car\'s data. If nothing shows up, open Probe and send a photo of it.');
                } else {
                    cv.text(fit(cv, cur.title, 40, W - 520, { font: 'bold', literal: true }), 80, 64, 40, t.text, { font: 'bold', literal: true });
                    cv.text(fit(cv, cur.artist + (cur.album ? '  ·  ' + cur.album : ''), 26, W - 520), 80, 104, 26, t.dim, { literal: true });
                    cv.text('Timing: ' + timing(), W - 80, 64, 18, t.dim, { align: 'right', literal: true });
                    if (offset()) cv.text('Offset ' + (offset() > 0 ? '+' : '') + offset() + ' ms', W - 80, 92, 18, t.dim, { align: 'right', literal: true });
                    cv.fillRect(80, 124, W - 160, 2, t.track || '#222');
                    if (cur.duration) cv.fillRect(80, 124, Math.max(0, Math.min(1, position() / cur.duration)) * (W - 160), 2, t.accent);
                    const lyr = lyrics.get({ title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration });
                    if (lyr.state === 'synced') drawSynced(cv, t, lyr.lines, position());
                    else if (lyr.state === 'plain') drawPlain(cv, t, lyr.text);
                    else if (lyr.state === 'loading') center(cv, t, 'Finding the lyrics...', '');
                    else if (lyr.state === 'instrumental') center(cv, t, 'Instrumental', '');
                    else if (lyr.state === 'error') center(cv, t, 'Can\'t reach LRCLIB', net.online() ? 'Trying again in a moment.' : 'The car is offline: Store > Settings > Wi-Fi, or a phone hotspot.');
                    else if (lyr.state === 'undrawable') center(cv, t, 'Lyrics in letters this app can\'t draw yet', '');
                    else center(cv, t, 'No lyrics found for this song', 'LRCLIB has no entry for this title and artist.');
                }
                if (toast && Date.now() < toast.until) {
                    const w = cv.textWidth(toast.text, 24, { literal: true }) + 60;
                    cv.roundRect((W - w) / 2, H - 70, w, 50, 25, '#2a2b31');
                    cv.text(toast.text, W / 2, H - 37, 24, '#ffffff', { align: 'center', literal: true });
                }
                await ui.image('MAIN_GFX', cv);
            }));

            /* ---------- PROBE: everything the car reports ---------- */
            let page = 0;
            const PAGES = ['Values the car sends', 'Media interfaces in the catalog', 'Subscriptions'];
            ui.onClick('BTN_PAGE', guard('page', () => { page = (page + 1) % PAGES.length; }));
            const report = () => {
                const L = ['Car Lyrics ' + VERSION + ' probe, ' + new Date().toISOString(), ''];
                L.push('== track picked: ' + (cur ? JSON.stringify(cur) : 'none'), '');
                L.push('== subscriptions');
                np.status().forEach((s) => L.push(s.iface + ' / ' + s.instance + ': ' + (s.available ? 'available' : 'not available') + ', ' + s.fields + ' fields' + (s.error ? ', error ' + s.error : '')));
                L.push('', '== values (newest first)');
                np.values().forEach((v) => L.push(v.key + ' = ' + v.text + (v.changes ? '  (' + v.changes + ' changes)' : '')));
                L.push('', '== catalog (' + (catalog.error ? 'error ' + catalog.error : catalog.total + ' interfaces') + '): interfaces naming a title, artist, album or now-playing data');
                catalog.hits.forEach((h) => L.push(h.iface + ': ' + h.words.join(', ')));
                return L.join('\n') + '\n';
            };
            const reportFile = path.join(ctx.dataDir, 'carlyrics-probe.txt');
            let lastReport = '';
            const saveReport = () => {
                const r = report();
                if (r.slice(r.indexOf('\n')) === lastReport) return false;
                lastReport = r.slice(r.indexOf('\n'));
                fs.writeFileSync(reportFile, r);
                return true;
            };
            ui.onClick('BTN_SAVE', guard('save', () => { saveReport(); say('Saved to ' + reportFile, 5000); }));
            setInterval(guard('report', () => { if (np.values().length) saveReport(); }), REPORT_MS);

            ctx.loop('PROBE', 2, guard('probe', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
                cv.text(PAGES[page] + '  (' + (page + 1) + '/' + PAGES.length + ')', 40, 44, 26, t.text, { font: 'bold', literal: true });
                cv.text(cur ? 'Track: "' + cur.title + '" by "' + cur.artist + '"' : 'Track: not found yet', W - 40, 44, 18, t.dim, { align: 'right', literal: true });
                const rows = [];
                if (page === 0) {
                    const v = np.values();
                    if (!v.length) rows.push('Nothing yet. Play a song on your phone with CarPlay connected.');
                    v.slice(0, 18).forEach((x) => rows.push(x.key + ' = ' + x.text));
                    if (v.length > 18) rows.push('... and ' + (v.length - 18) + ' more in carlyrics-probe.txt (Save report)');
                } else if (page === 1) {
                    if (catalog.error) rows.push('Catalog not read: ' + catalog.error);
                    catalog.hits.slice(0, 18).forEach((h) => rows.push(h.iface.replace('de.bmw.infotainment.', '') + ': ' + h.words.join(', ')));
                    if (!catalog.error && !catalog.hits.length) rows.push('No interface in the catalog names a title or an artist.');
                } else {
                    np.status().forEach((s) => rows.push(s.iface.split('.').pop() + ' / ' + s.instance + ': ' + (s.available ? 'available' : 'not available') + ', ' + s.fields + ' fields' + (s.error ? ' - ' + s.error : '')));
                    rows.push('', 'Report file: ' + reportFile, 'Online: ' + (net.online() ? 'yes' : 'no (lyrics need the Store\'s internet)'));
                }
                rows.forEach((r, k) => cv.text(fit(cv, r, 20, W - 80, { literal: true }), 40, 92 + k * 24, 20, k % 2 ? t.dim : t.text, { literal: true }));
                if (toast && Date.now() < toast.until) cv.text(toast.text, W / 2, H - 16, 20, t.accent2 || t.text, { align: 'center', literal: true });
                await ui.image('PROBE_GFX', cv);
            }));

            /* ---------- start: the catalog (one read), then the subscriptions ---------- */
            catalog = NP.scanCatalog();
            log.info('catalog: ' + (catalog.error ? 'error ' + catalog.error : catalog.total + ' interfaces, ' + catalog.hits.length + ' look like media'));
            catalog.hits.forEach((h) => log.info('catalog: ' + h.iface + ': ' + h.words.join(', ')));
            np.start().then(() => log.info('subscribed: ' + JSON.stringify(np.status())), (e) => log.error('nowplaying start: ' + (e && e.stack || e)));
            log.info('started ' + VERSION);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
