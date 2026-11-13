'use strict';
/**
 * slot.js - the second slot: a live readout in the space BMW's own cluster widgets (music, trip computer) use,
 * on the right, drawn only while the bottom strip holds the cluster's panel (those widgets are gone then anyway).
 *
 * The look matches the cluster's own "0 mph" on the left: big white Inter Bold numbers, a small gray unit, no box,
 * so it reads as part of the cluster. Contents (Settings > Second slot):
 *   engine   oil temperature and the gear (D3, S4, M2, P)
 *   temps    oil and coolant temperature
 *   g        lateral and braking / accelerating g, live
 *   clock    the time, large
 *   music    what's playing: the album cover (when the car is online) with the title and artist
 *
 * One image layer on the panel, redrawn only when what it shows changes (at most twice a second); a few hundred
 * KB at most then, nothing in between.
 * Node 8. Never throws out: every call is caught.
 */
const { Canvas } = require('./kit/canvas');

const SW = 420, SH = 190;                               // the picture
const DEF = { x: 1470, y: 470, scale: 1 };             // its centre on the cluster: the right gauge's widget area (estimated from Aref's photo; Move adjusts)
const SLOTS = ['off', 'engine', 'temps', 'g', 'clock', 'music'];
const MIN_MS = 500;
const WHITE = [255, 255, 255, 255], GRAY = [152, 152, 159, 255], DIM = [99, 99, 102, 255];

const cToF = (c) => (typeof c === 'number' ? Math.round(c * 9 / 5 + 32) : null);

/** The gear as the cluster writes it: P, R, N, D3, S4, M2 (program from MDrive, else D). */
function gearText(d) {
    if (!d) return '--';
    const st = d.stage || d.selector;
    if (st === 'P' || st === 'R' || st === 'N') return st;
    if (d.gear === -1) return 'R';
    if (d.gear === 0) return st === 'D' ? 'D' : 'N';
    const prog = d.program === 'S' || d.program === 'M' ? d.program : 'D';
    return typeof d.gear === 'number' && d.gear > 0 ? prog + d.gear : prog;
}

/**
 * What a slot shows: [{ v, u }] for one or two big values, or { music: { title, artist, cover } }, or null.
 * d: the kit's car.data(); now: ms; track: nowplaying's track(); cover: { px, n } RGBA square or null.
 */
function content(kind, d, now, track, cover) {
    if (kind === 'engine') { const o = cToF(d && d.oil); return [{ v: o === null ? '--' : String(o), u: '°F oil' }, { v: gearText(d), u: 'gear' }]; }
    if (kind === 'temps') { const o = cToF(d && d.oil), c = cToF(d && d.coolant); return [{ v: o === null ? '--' : String(o), u: '°F oil' }, { v: c === null ? '--' : String(c), u: '°F coolant' }]; }
    if (kind === 'g') {
        const g = (x) => (typeof x === 'number' ? Math.abs(x / 9.81).toFixed(2) : '--');
        const lon = d && typeof d.gLong === 'number' ? (d.gLong < -0.3 ? 'braking' : d.gLong > 0.3 ? 'accel' : 'long') : 'long';
        return [{ v: g(d && d.gLat), u: 'g lateral' }, { v: g(d && d.gLong), u: 'g ' + lon }];
    }
    if (kind === 'clock') {
        const t = new Date(now), h = t.getHours(), m = t.getMinutes();
        return [{ v: ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m, u: h < 12 ? 'AM' : 'PM' }];
    }
    if (kind === 'music') return track && track.title ? { music: { title: track.title, artist: track.artist || '', cover: cover } } : null;
    return null;
}

function draw(c, fonts) {
    const cv = new Canvas(SW, SH);
    cv.clear([0, 0, 0, 0]);
    const B = { font: fonts.bold, literal: true }, M = { font: fonts.med, literal: true };
    const fit = (s, size, w, o) => { s = String(s || ''); if (cv.textWidth(s, size, o) <= w) return s; while (s.length > 1 && cv.textWidth(s + '…', size, o) > w) s = s.slice(0, -1); return s + '…'; };
    if (Array.isArray(c)) {
        // one or two columns, numbers on a shared baseline like the speedometer's "0 mph"
        const cols = c.length, cw = SW / cols, base = 112;
        c.forEach((q, i) => {
            const x = i * cw + cw / 2, size = cols === 1 ? 92 : 76;
            const vw = cv.textWidth(q.v, size, B);
            cv.text(q.v, x - vw / 2, base + 2, size, [0, 0, 0, 120], B);
            cv.text(q.v, x - vw / 2, base, size, WHITE, B);
            cv.text(fit(q.u, 24, cw - 20, M), x, base + 40, 24, GRAY, Object.assign({ align: 'center' }, M));
        });
        if (cols === 2) cv.fillRect(SW / 2, 40, 1, 110, DIM);
    } else if (c && c.music) {
        const m = c.music, n = 150, x0 = 10, y0 = (SH - n) / 2;
        if (m.cover && m.cover.px) {
            // the cover, scaled into n x n with rounded corners (nearest from the square it came as)
            const src = m.cover.px, sn = m.cover.n, r = 14;
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                const dx = Math.min(x, n - 1 - x), dy = Math.min(y, n - 1 - y);
                if (dx < r && dy < r && Math.hypot(r - dx - 0.5, r - dy - 0.5) > r) continue;
                const si = ((Math.floor(y * sn / n) * sn) + Math.floor(x * sn / n)) * 4;
                cv._blend(x0 + x, y0 + y, [src[si], src[si + 1], src[si + 2], 255], 1);
            }
        } else {
            cv.roundRect(x0, y0, n, n, 14, [28, 28, 30, 255]);
            cv.text('♪', x0 + n / 2, y0 + n / 2 + 26, 72, DIM, Object.assign({ align: 'center' }, M));
        }
        const tx = x0 + n + 22, tw = SW - tx - 6;
        cv.text(fit(m.title, 32, tw, B), tx, 82, 32, WHITE, B);
        cv.text(fit(m.artist, 24, tw, M), tx, 118, 24, GRAY, M);
    }
    return Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
}

class Slot {
    /** cr: the cluster renderer client (or null); fonts: { bold, med } atlas names; note(line): the app's log. */
    constructor(cr, fonts, note, place) {
        this.cr = cr; this.fonts = fonts; this.note = note;
        this.place = Object.assign({}, DEF, place);
        this.ref = null; this.key = null; this.shown = false; this.at = 0; this.pixels = null;
    }

    rect() {
        const s = this.place.scale, w = Math.round(SW * s), h = Math.round(SH * s);
        return { x: Math.round(this.place.x - w / 2), y: Math.round(this.place.y - h / 2), w: w, h: h };
    }

    create() {
        if (!this.cr || this.ref) return;
        try {
            const r = this.rect();
            this.ref = this.cr.image({ target: 'panel', klass: 'content', z: 22, x: r.x, y: r.y, w: r.w, h: r.h, iw: SW, ih: SH,
                sampling: 'bilinear', fps: 2, visible: false });
        } catch (e) { this.note('slot: ' + e.message); }
    }

    /** want: the bottom strip is on the cluster now; c: content() or null. */
    update(want, c) {
        if (!this.ref) return;
        try {
            const show = !!(want && c);
            if (show) {
                const key = JSON.stringify(c, (k, v) => (k === 'cover' ? (v ? 'cover' : null) : v));
                const now = Date.now();
                if (key !== this.key && now - this.at >= MIN_MS) {
                    this.key = key; this.at = now;
                    this.pixels = draw(c, this.fonts);
                    this.cr.pixels(this.ref, null, this.pixels);
                }
            }
            if (show !== this.shown) { this.shown = show; this.cr.set(this.ref, { visible: show }); this.note('slot: ' + (show ? 'show' : 'hide')); }
        } catch (e) { this.note('slot: ' + e.message); }
    }

    move(place) {
        this.place = Object.assign({}, DEF, place);
        if (this.ref) { try { const r = this.rect(); this.cr.set(this.ref, { x: r.x, y: r.y, w: r.w, h: r.h }); } catch (e) { /* next */ } }
    }
}

module.exports = { Slot, SLOTS, DEF, SW, SH, content, draw, gearText };
