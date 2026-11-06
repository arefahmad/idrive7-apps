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
const HW = require('./kit/homewidget');

const VERSION = '0.2.4';
const HOMEPAGE = 'https://github.com/arefahmad/idrive7-apps';
const W = 1600, H = 520;
const IFACES = [
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
    { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
    // found by Car Explorer on a G22: what the HMI's own media screens show, and the dynamic (streaming) player
    { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instances: [] },
    { iface: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', instances: [] },
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

            /* ---------- MAIN: the song and its lyrics ---------- */
            const fit = (cv, s, size, w, opt) => {
                s = String(s || '');
                if (cv.textWidth(s, size, opt) <= w) return s;
                while (s.length > 1 && cv.textWidth(s + '...', size, opt) > w) s = s.slice(0, -1);
                return s + '...';
            };
            /*
             * The glass look: a deep gradient in the song's own colours (picked from its title, so each song has
             * its own), soft glows behind frosted panels, and lyrics left-aligned and bold, the current line in
             * full white and the others faded, as Apple Music shows them.
             */
            const GX = 40, GW = 440, LX = 540, LW = W - LX - 60;     // the now-playing panel; the lyrics column
            function palette(seed) {
                let h = 0;
                for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
                const hue = h % 360, hsl = (hh, ss, ll) => {
                    const a = ss * Math.min(ll, 1 - ll), f = (n) => { const k = (n + hh / 30) % 12; return Math.round(255 * (ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
                    return [f(0), f(8), f(4), 255];
                };
                return { top: hsl(hue, 0.55, 0.22), bottom: hsl((hue + 40) % 360, 0.6, 0.07), glow1: hsl((hue + 330) % 360, 0.8, 0.45), glow2: hsl((hue + 60) % 360, 0.7, 0.4), art1: hsl(hue, 0.65, 0.5), art2: hsl((hue + 50) % 360, 0.7, 0.3) };
            }
            const A = (c, a) => [c[0], c[1], c[2], Math.round(255 * a)];
            const WHITE = [255, 255, 255, 255];
            function backdrop(cv, P) {
                cv.gradientRect(0, 0, W, H, [[0, P.top], [1, P.bottom]]);
                // soft glows (stacked translucent circles stand in for a blur)
                [[260, 120, P.glow1], [1250, 420, P.glow2], [900, 60, P.glow1]].forEach((g) => {
                    for (let r = 320; r > 20; r -= 15) cv.circle(g[0], g[1], r, A(g[2], 0.014));
                });
            }
            function glass(cv, x, y, w, h, r) {
                cv.roundRect(x, y, w, h, r, A(WHITE, 0.09));
                cv.strokeRoundRect(x, y, w, h, r, 1.5, A(WHITE, 0.18));
                cv.roundRect(x + 1, y + 1, w - 2, Math.min(60, h / 3), r, A(WHITE, 0.04));     // a sheen at the top
            }
            const mmss = (ms) => { const s2 = Math.max(0, Math.round(ms / 1000)); return Math.floor(s2 / 60) + ':' + String(s2 % 60).padStart(2, '0'); };
            function nowPlaying(cv, P) {
                glass(cv, GX, 30, GW, H - 60, 28);
                // the "artwork": the song's colours and its initials (the car doesn't pass the artwork on)
                const ax = GX + 30, ay = 58, as = 180;
                cv.card(ax, ay, as, as, 18, [[0, P.art1], [1, P.art2]]);
                const ini = cur.title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
                cv.text(ini, ax + as / 2, ay + as / 2 + 26, 72, A(WHITE, 0.9), { font: 'bold', align: 'center', literal: true });
                const tx = ax + as + 24, tw = GW - (tx - GX) - 24;
                cv.text('NOW PLAYING', tx, ay + 22, 13, A(WHITE, 0.6), { font: 'bold', spacing: 1.5, literal: true });
                const B = { font: 'bold', literal: true };
                let size = 28;
                while (size > 20 && cv.textWidth(cur.title, size, B) > tw) size -= 2;
                cv.text(fit(cv, cur.title, size, tw, B), tx, ay + 64, size, WHITE, B);
                cv.text(fit(cv, cur.artist, 20, tw, { literal: true }), tx, ay + 96, 20, A(WHITE, 0.7), { literal: true });
                if (cur.album) cv.text(fit(cv, cur.album, 16, tw, { literal: true }), tx, ay + 122, 16, A(WHITE, 0.5), { literal: true });
                // the progress line with times
                const py = ay + as + 48, pw = GW - 60, pos = position();
                cv.roundRect(GX + 30, py, pw, 6, 3, A(WHITE, 0.2));
                if (cur.duration) cv.roundRect(GX + 30, py, Math.max(6, Math.min(1, pos / cur.duration) * pw), 6, 3, A(WHITE, 0.9));
                cv.text(mmss(pos), GX + 30, py + 30, 15, A(WHITE, 0.6), { literal: true });
                if (cur.duration) cv.text('-' + mmss(cur.duration - pos), GX + 30 + pw, py + 30, 15, A(WHITE, 0.6), { align: 'right', literal: true });
                cv.text(fit(cv, 'Timing ' + (posVal !== null ? 'from the car' : 'estimated') + (offset() ? ', offset ' + (offset() > 0 ? '+' : '') + offset() + ' ms' : ''), 14, pw, { literal: true }), GX + 30, H - 56, 14, A(WHITE, 0.45), { literal: true });
            }
            function drawSynced(cv, lines, pos) {
                const p = pos + LEAD_MS, i = LyricsLib.lineAt(lines, p);
                const e = i >= 0 ? Math.max(0, Math.min(1, (p - lines[i].t) / SCROLL_MS)) : 1;
                const sc = i >= 0 ? i - 1 + (1 - Math.pow(1 - e, 3)) : -1;
                const top = 30, bottom = H - 30, cy = 200, LH = 66;
                cv.clip(LX, top, LW + 40, bottom - top);
                for (let j = Math.floor(sc) - 2; j <= Math.floor(sc) + 5; j++) {
                    if (j < 0 || j >= lines.length) continue;
                    const y = cy + (j - sc) * LH;
                    if (y < top - 40 || y > bottom + 40) continue;
                    const now = j === i, past = j < i, opt = { font: 'bold', literal: true };
                    let size = now ? 44 : 38;
                    const txt = lines[j].text || '·  ·  ·';
                    while (size > 26 && cv.textWidth(txt, size, opt) > LW) size -= 2;
                    const a = now ? 1 : past ? 0.22 : Math.max(0.18, 0.5 - (j - i - 1) * 0.08);
                    cv.text(fit(cv, txt, size, LW, opt), LX, y + size * 0.35, size, A(WHITE, a), opt);
                }
                cv.noclip();
            }
            function drawPlain(cv, text) {
                cv.text('LYRICS (NOT SYNCED)', LX, 60, 14, A(WHITE, 0.55), { font: 'bold', spacing: 1.5, literal: true });
                text.filter(Boolean).slice(0, 7).forEach((s, k) => cv.text(fit(cv, s, 30, LW, { font: 'bold', literal: true }), LX, 110 + k * 52, 30, A(WHITE, k ? 0.55 : 1), { font: 'bold', literal: true }));
            }
            function message(cv, a, b) {
                cv.text(a, LX, 230, 38, WHITE, { font: 'bold', literal: true });
                if (b) cv.text(fit(cv, b, 22, LW), LX, 280, 22, A(WHITE, 0.65), { literal: true });
            }
            let probe = false;            // the Probe view is on (it shares this screen)
            ctx.loop('MAIN', 10, guard('main', async () => {
                if (probe) { await drawProbe(); return; }
                const cv = ctx.canvas(W, H);
                if (!cur) follow();
                if (!cur) {
                    const P = palette('Car Lyrics');
                    backdrop(cv, P);
                    glass(cv, 300, 140, W - 600, 240, 28);
                    cv.text('Play a song on your phone', W / 2, 240, 38, WHITE, { font: 'bold', align: 'center', literal: true });
                    cv.text('Looking for the track in the car\'s data. If nothing shows up, open Probe and send a photo of it.', W / 2, 290, 20, A(WHITE, 0.65), { align: 'center', literal: true });
                } else {
                    const P = palette(cur.title + cur.artist);
                    backdrop(cv, P);
                    nowPlaying(cv, P);
                    const lyr = lyrics.get({ title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration });
                    if (lyr.state === 'synced') drawSynced(cv, lyr.lines, position());
                    else if (lyr.state === 'plain') drawPlain(cv, lyr.text);
                    else if (lyr.state === 'loading') message(cv, 'Finding the lyrics...', '');
                    else if (lyr.state === 'instrumental') message(cv, 'Instrumental', 'Nothing to sing along to.');
                    else if (lyr.state === 'error') message(cv, 'Can\'t reach LRCLIB', net.online() ? 'Trying again in a moment.' : 'The car is offline: Store > Settings > Wi-Fi, or a phone hotspot.');
                    else if (lyr.state === 'undrawable') message(cv, 'Lyrics in letters this app can\'t draw yet', '');
                    else message(cv, 'No lyrics for this song', 'LRCLIB has no entry for this title and artist.');
                }
                if (toast && Date.now() < toast.until) {
                    const w = cv.textWidth(toast.text, 22, { literal: true }) + 60;
                    cv.roundRect((W - w) / 2, H - 70, w, 48, 24, A([20, 20, 24], 0.85));
                    cv.strokeRoundRect((W - w) / 2, H - 70, w, 48, 24, 1, A(WHITE, 0.2));
                    cv.text(toast.text, W / 2, H - 39, 22, WHITE, { align: 'center', literal: true });
                }
                await ui.image('MAIN_GFX', cv);
            }));

            /* ---------- home-screen widget: the song and the line playing ---------- */
            HW.start(ctx, () => {
                if (!cur) return { label: 'Car Lyrics', value: 'Nothing playing', sub: 'Play a song on your phone', small: ['Car Lyrics', 'Nothing playing'] };
                const lyr = lyrics.get({ title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration });
                let line = '';
                if (lyr.state === 'synced') { const i = LyricsLib.lineAt(lyr.lines, position() + LEAD_MS); line = i >= 0 ? lyr.lines[i].text : ''; }
                return { label: 'Now playing', value: cur.title, sub: line || cur.artist, sub2: line ? cur.artist : '',
                    bar: cur.duration ? position() / cur.duration : null, small: [cur.title, line || cur.artist] };
            }, { fps: 1 });

            /*
             * PROBE: everything the car reports, shown in the main screen (a second screen of its own drew over
             * this one on iDrive 7, and the two flashed). Probe switches between the lyrics and the probe.
             */
            let page = 0, vpage = 0;
            const PAGES = ['Values the car sends', 'Media interfaces in the catalog', 'Subscriptions'];
            const PROBE_BTNS = ['BTN_PAGE', 'BTN_MORE', 'BTN_SAVE'];
            const shown = (id, on) => {
                const D = ctx.display;
                ui.visible(id, on && !(D && D.hmiBarHidden));
                if (D && D.ownHidden) {
                    if (on) D.ownHidden.delete(id); else D.ownHidden.add(id);
                    D._btns = null;
                    if (D.place && typeof D._place === 'function') D._place();
                }
            };
            const showButtons = () => {
                PROBE_BTNS.forEach((b) => shown(b, probe));
                shown('BTN_SYNC', !probe);
                ui.text('BTN_PROBE', probe ? 'Lyrics' : 'Probe');
            };
            ctx.onLayout(guard('layout', () => showButtons()));
            showButtons();
            ui.onClick('BTN_PROBE', guard('probe', () => { probe = !probe; page = 0; vpage = 0; showButtons(); }));
            ui.onClick('BTN_PAGE', guard('page', () => { page = (page + 1) % PAGES.length; vpage = 0; }));
            ui.onClick('BTN_MORE', guard('more', () => { vpage++; }));
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

            // the values that say most about what is playing first: metadata, item, title, state, time
            const RANK = /metadata|item|title|artist|album|state|time|track|song/i;
            async function drawProbe() {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), PER = 17;
                cv.text(PAGES[page] + '  (' + (page + 1) + '/' + PAGES.length + ')', 40, 44, 26, t.text, { font: 'bold', literal: true });
                cv.text(cur ? 'Track: "' + cur.title + '" by "' + cur.artist + '"' : 'Track: not found yet', W - 40, 44, 18, t.dim, { align: 'right', literal: true });
                let rows = [];
                if (page === 0) {
                    const v = np.values().slice().sort((a, b) => (RANK.test(b.key) ? 1 : 0) - (RANK.test(a.key) ? 1 : 0) || b.changes - a.changes || b.at - a.at);
                    if (!v.length) rows.push('Nothing yet. Play a song on your phone with CarPlay connected.');
                    rows = rows.concat(v.map((x) => x.key.replace('MediaPlayer/', '') + ' = ' + x.text + (x.changes ? '  (' + x.changes + ' changes)' : '')));
                } else if (page === 1) {
                    if (catalog.error) rows.push('Catalog not read: ' + catalog.error);
                    rows = rows.concat(catalog.hits.map((h) => h.iface.replace('de.bmw.infotainment.', '') + ': ' + h.words.join(', ')));
                    if (!catalog.error && !catalog.hits.length) rows.push('No interface in the catalog names a title or an artist.');
                } else {
                    np.status().forEach((s2) => rows.push(s2.iface.split('.').pop() + ' / ' + s2.instance + ': ' + (s2.available ? 'available' : 'not available') + ', ' + s2.fields + ' fields' + (s2.error ? ' - ' + s2.error : '')));
                    rows.push('', 'Report file: ' + reportFile, 'Online: ' + (net.online() ? 'yes' : 'no (lyrics need the Store\'s internet)'));
                }
                const pages = Math.max(1, Math.ceil(rows.length / PER)), pg = vpage % pages;
                rows.slice(pg * PER, pg * PER + PER).forEach((r, k) => cv.text(fit(cv, r, 20, W - 80, { literal: true }), 40, 86 + k * 24, 20, k % 2 ? t.dim : t.text, { literal: true }));
                if (pages > 1) cv.text('Page ' + (pg + 1) + ' of ' + pages + ' (More)', W - 40, H - 14, 16, t.dim, { align: 'right', literal: true });
                if (toast && Date.now() < toast.until) cv.text(toast.text, 40, H - 14, 16, t.accent2 || t.text, { literal: true });
                await ui.image('MAIN_GFX', cv);
            }

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
