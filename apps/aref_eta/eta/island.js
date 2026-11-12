'use strict';
/**
 * island.js - the "island" preset: the ETA in a black pill at the top of the cluster, under the driver attention
 * camera, that drops out of it and widens like iPhone's Dynamic Island, then shrinks back into it.
 *
 * Four image layers on the cluster's "panel" target, all black like the cluster: the pill's left cap, a 4 px wide
 * middle that the renderer stretches, the right cap, and the text (look.js, look "bare") on top. The motion is
 * the renderer's own animations (translate / scale keys, played on the cluster at its frame rate: nothing is sent
 * per frame) plus a few opacity steps for the text, so a pop costs a handful of small messages and no pixels.
 * The renderer only blends linearly between keys: the springy easing is sampled into keys here.
 *
 * Node 8. Never throws out: every call is caught.
 */
const { Canvas } = require('./kit/canvas');

const PH = 76;                  // the pill's height at scale 1 (cluster px)
const PAD = 40;                 // text to the pill's ends
const OPEN_MS = 520, CLOSE_MS = 430;

const ease = {
    // a little past the end, then back: Dynamic Island's spring
    outBack: (t) => { const c = 1.45; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    inCubic: (t) => t * t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
};
/** keys 't:v,v,v ...' from f(t in 0..1) -> [v, v, v], sampled n times between t0 and t1 ms. */
function keys(t0, t1, n, f, before) {
    const out = [];
    if (before !== undefined && t0 > 0) out.push('0:' + f(0).map(r).join(','));
    for (let i = 0; i <= n; i++) { const t = i / n; out.push(Math.round(t0 + (t1 - t0) * t) + ':' + f(t).map(r).join(',')); }
    return out.join(' ');
}
const r = (v) => Math.round(v * 1000) / 1000;

function pixels(cv) { return Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length); }
/** The pill's parts at height h: left cap, middle slice, right cap (black, with the cluster's hairline rim). */
function parts(h) {
    const rad = h / 2, rim = [255, 255, 255, 48];
    const L = new Canvas(Math.ceil(rad), h), R = new Canvas(Math.ceil(rad), h), M = new Canvas(4, h);
    [L, R, M].forEach((c) => c.clear([0, 0, 0, 0]));
    L.roundRect(0, 0, h, h, rad, [0, 0, 0, 255]); L.strokeRoundRect(0.5, 0.5, h - 1, h - 1, rad, 1, rim);
    R.roundRect(-h + Math.ceil(rad), 0, h, h, rad, [0, 0, 0, 255]); R.strokeRoundRect(-h + Math.ceil(rad) + 0.5, 0.5, h - 1, h - 1, rad, 1, rim);
    M.fillRect(0, 0, 4, h, [0, 0, 0, 255]); M.fillRect(0, 0, 4, 1, rim); M.fillRect(0, h - 1, 4, 1, rim);
    return { L: L, R: R, M: M };
}

class Island {
    /** cr: the cluster renderer client; note(line): the app's log. */
    constructor(cr, note) {
        this.cr = cr; this.note = note;
        this.refs = null; this.anims = {}; this.timers = [];
        this.open = false; this.place = { x: 960, y: 12, scale: 1 }; this.cw = 400; this.h = PH;
        this.img = null;
    }

    /** Its layers' refs -> names, for the log. */
    names() { const o = {}; if (this.refs) Object.keys(this.refs).forEach((k) => { o[this.refs[k]] = 'island ' + k; }); return o; }

    /** Make the layers (hidden). place: { x: the pill's centre, y: its top, scale }. iw, ih: the text image's size. */
    create(place, iw, ih, target) {
        this.place = place; this.iw = iw; this.ih = ih;
        // on the map target (Waze on cluster's): joins its picture, takes the map from nobody (contend 0) and leaves
        // the guidance box as Waze set it (guide_hold 0); the panel would cover BMW's own cluster widgets
        const T = target || 'panel', extra = T === 'map' ? { guide_hold: 0, contend: 0 } : {};
        this.h = Math.round(PH * place.scale);
        const p = parts(this.h), cr = this.cr, g = this.geom();
        const mk = (cv, rect, z) => {
            const ref = cr.image(Object.assign({ target: T, klass: 'overlay', z: z, x: rect.x, y: rect.y, w: rect.w, h: rect.h, iw: cv.w, ih: cv.h,
                sampling: 'bilinear', fps: 2, visible: false }, extra));
            cr.pixels(ref, null, pixels(cv));
            return ref;
        };
        this.parts = p;
        this.refs = { L: mk(p.L, g.L, 30), M: mk(p.M, g.M, 30), R: mk(p.R, g.R, 30),
            T: cr.image(Object.assign({ target: T, klass: 'overlay', z: 31, x: g.T.x, y: g.T.y, w: g.T.w, h: g.T.h, iw: iw, ih: ih, sampling: 'bilinear', fps: 2, visible: false }, extra)) };
    }

    /** The open pill's rects. */
    geom() {
        const s = this.place.scale, h = this.h, rad = Math.ceil(h / 2);
        const w = Math.max(h * 2, Math.round((this.cw + 2 * PAD) * s)), x0 = Math.round(this.place.x - w / 2), y = Math.round(this.place.y);
        const tw = Math.round(this.iw * s), th = Math.round(this.ih * s);
        return { w: w, L: { x: x0, y: y, w: rad, h: h }, R: { x: x0 + w - rad, y: y, w: rad, h: h }, M: { x: x0 + rad, y: y, w: w - 2 * rad, h: h },
            T: { x: Math.round(this.place.x - tw / 2), y: Math.max(0, Math.round(y + h / 2 - th / 2)), w: tw, h: th } };
    }

    /** The text: img = look.js render() of the parts with look 'bare' ({ data, cw }). Resizes an open pill. */
    setContent(img) {
        if (!this.refs) return;
        this.img = img;
        try {
            this.cr.pixels(this.refs.T, null, img.data);
            if (img.cw && img.cw !== this.cw) { this.cw = img.cw; this.layout(); }
        } catch (e) { this.note('island: ' + e.message); }
    }

    layout() {
        const g = this.geom();
        ['L', 'M', 'R', 'T'].forEach((k) => this.cr.set(this.refs[k], { x: g[k].x, y: g[k].y, w: g[k].w, h: g[k].h }));
    }

    move(place) {
        const rebuild = Math.round(PH * place.scale) !== this.h;
        this.place = place;
        if (!this.refs) return;
        if (rebuild) {
            this.h = Math.round(PH * place.scale);
            const p = parts(this.h);
            this.cr.pixels(this.refs.L, null, pixels(p.L)); this.cr.pixels(this.refs.R, null, pixels(p.R)); this.cr.pixels(this.refs.M, null, pixels(p.M));
            ['L', 'R', 'M'].forEach((k) => this.cr.set(this.refs[k], { iw: p[k].w, ih: p[k].h }));
        }
        this.layout();
    }

    _stopAll() {
        this.timers.forEach(clearTimeout); this.timers = [];
        Object.keys(this.anims).forEach((k) => { this.anims[k].forEach((a) => { try { this.cr.stop(this.refs[k], a); } catch (e) { /* */ } }); this.anims[k] = []; });
    }
    _anim(k, property, ks) {
        const a = this.cr.animate(this.refs[k], { property: property, keys: ks });
        (this.anims[k] = this.anims[k] || []).push(a);
    }
    _later(ms, fn) { this.timers.push(setTimeout(() => { try { fn(); } catch (e) { this.note('island: ' + e.message); } }, ms)); }
    _opacity(steps) { steps.forEach((s) => this._later(s[0], () => this.cr.set(this.refs.T, { opacity: s[1] }))); }

    /** Drop out of the camera and widen, then show the text. */
    pop() {
        if (!this.refs || this.open) return;
        this.open = true;
        try {
            this._stopAll();
            const g = this.geom(), h = this.h;
            const w0 = Math.round(h * 1.6), half = (g.w - w0) / 2;          // the closed pill: a little wider than tall
            const s0 = Math.max(0.02, (w0 - 2 * Math.ceil(h / 2)) / Math.max(1, g.M.w));
            const D = g.L.y + h + 8;                                         // up out of sight, behind the camera
            // 0-200 ms: drop down (closed width); 140-520 ms: widen with a spring
            const drop = (t) => -D * (1 - ease.outCubic(t));
            const wide = (t) => ease.outBack(t);
            const dropK = (side) => keys(0, OPEN_MS, 13, (t) => {
                const td = Math.min(1, t * OPEN_MS / 200), tw = Math.max(0, Math.min(1, (t * OPEN_MS - 140) / (OPEN_MS - 140)));
                return [side * half * (1 - wide(tw)), drop(td), 0];
            });
            this._anim('L', 'translate', dropK(1));
            this._anim('R', 'translate', dropK(-1));
            this._anim('M', 'translate', keys(0, 200, 6, (t) => [0, drop(t), 0]));
            this._anim('M', 'scale', keys(140, OPEN_MS, 10, (t) => [s0 + (1 - s0) * wide(t), 1, 1], true));
            this.cr.set(this.refs.T, { opacity: 0 });
            ['L', 'M', 'R', 'T'].forEach((k) => this.cr.set(this.refs[k], { visible: true }));
            this._opacity([[300, 0.3], [360, 0.65], [420, 1]]);
        } catch (e) { this.note('island: pop ' + e.message); }
    }

    /** Fade the text, shrink, rise back into the camera, hide. then(): after it's gone. */
    close(then) {
        if (!this.refs || !this.open) { if (then) then(); return; }
        this.open = false;
        try {
            this._stopAll();
            const g = this.geom(), h = this.h;
            const w0 = Math.round(h * 1.6), half = (g.w - w0) / 2;
            const s0 = Math.max(0.02, (w0 - 2 * Math.ceil(h / 2)) / Math.max(1, g.M.w));
            const D = g.L.y + h + 8;
            this._opacity([[0, 0.6], [60, 0.25], [110, 0]]);
            const sideK = (side) => keys(0, CLOSE_MS, 12, (t) => {
                const tw = Math.max(0, Math.min(1, (t * CLOSE_MS - 90) / 230)), tu = Math.max(0, Math.min(1, (t * CLOSE_MS - 290) / 140));
                return [side * half * ease.inCubic(tw) * 0 + side * half * ease.outCubic(tw), -D * ease.inCubic(tu), 0];
            });
            this._anim('L', 'translate', sideK(1));
            this._anim('R', 'translate', sideK(-1));
            this._anim('M', 'scale', keys(90, 320, 8, (t) => [1 - (1 - s0) * ease.outCubic(t), 1, 1], true));
            this._anim('M', 'translate', keys(290, CLOSE_MS, 5, (t) => [0, -D * ease.inCubic(t), 0], true));
            this._later(CLOSE_MS + 20, () => {
                ['L', 'M', 'R', 'T'].forEach((k) => this.cr.set(this.refs[k], { visible: false }));
                this._stopAll();
                if (then) then();
            });
        } catch (e) { this.note('island: close ' + e.message); if (then) then(); }
    }

    /** Hidden at once (the route ended while it was closed, the app turned off). */
    hide() {
        if (!this.refs) return;
        this.open = false;
        try { this._stopAll(); ['L', 'M', 'R', 'T'].forEach((k) => this.cr.set(this.refs[k], { visible: false })); } catch (e) { /* */ }
    }
}

/** The island as one picture, for the app's own screen: the open pill with the text (img: render() 'bare'). */
function preview(img, iw, ih) {
    const h = PH, w = Math.max(h * 2, img.cw + 2 * PAD);
    const cv = new Canvas(Math.max(w + 40, iw), Math.max(h + 40, ih));
    cv.clear([0, 0, 0, 0]);
    const x = (cv.w - w) / 2, y = (cv.h - h) / 2;
    cv.roundRect(x, y, w, h, h / 2, [0, 0, 0, 255]);
    cv.strokeRoundRect(x + 0.5, y + 0.5, w - 1, h - 1, h / 2, 1, [255, 255, 255, 48]);
    const src = { w: iw, h: ih, d: img.data };
    // the text image centred (straight alpha over the pill)
    const ox = Math.round((cv.w - iw) / 2), oy = Math.round((cv.h - ih) / 2);
    for (let py = 0; py < ih; py++) for (let px = 0; px < iw; px++) {
        const si = (py * iw + px) * 4, a = src.d[si + 3];
        if (a) cv._blend(ox + px, oy + py, [src.d[si], src.d[si + 1], src.d[si + 2], 255], a / 255);
    }
    return { w: cv.w, h: cv.h, data: pixels(cv) };
}

module.exports = { Island, preview, PH };
