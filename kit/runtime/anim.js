'use strict';
/**
 * anim.js - an animation for an app's home-screen widget: a GIF made into frames of the widget's size
 * (prepare), kept in one file in the app's data folder (Store), and which frame shows when (Timeline).
 * Node 8, no npm modules. widget_anim.js plays what this makes.
 *
 *   const anim = require('./kit/anim');
 *   const a = await anim.prepare(gifBuffer, { w: 384, h: 256, fit: 'cover', onProgress: (done, total) => ... });
 *   new anim.Store(path.join(ctx.dataDir, 'widget_anim.bin')).save(a, { name: 'party.gif' });
 *
 * prepare() composites every frame of the GIF (gif.js), keeps at most as many as the budgets allow
 * (frames are merged in time, so the loop keeps its length and pace: a 100-frame GIF at 50 fps becomes
 * 50 frames at 25 fps, never a faster or slower loop), scales each kept frame into w x h and encodes it
 * as a PNG (what the HMI shows; the GPU path decodes them again). It yields to the event loop between
 * frames, so an app keeps drawing while a GIF is prepared.
 *
 *   fit 'cover'   fills the whole widget, centred, cutting off what sticks out (the default)
 *       'contain' the whole GIF inside the widget, centred, transparent around it
 *
 * Scaling is a box filter in premultiplied alpha: an average of the source pixels under each target
 * pixel when shrinking, and sharp (each source pixel a block, its edges blended) when enlarging, so
 * small pixel-art GIFs stay crisp; transparent pixels never darken their neighbours' edges.
 */
const fs = require('fs');
const GIF = require('./gif');
const PNG = require('./png');
const { Canvas } = require('./canvas');

const DEFAULTS = {
    maxFrames: 60,                      // frames kept at most
    maxRgbaBytes: 20 * 1024 * 1024,     // all kept frames as RGBA (what the GPU path holds): w * h * 4 each
    maxPngBytes: 4 * 1024 * 1024,       // all kept frames as PNG (the data file, and its copy the HMI reads)
    pngLevel: 6,
    yieldMs: 12,                        // run at most this long before letting the event loop go on
};
const FITS = ['cover', 'contain'];
const MAGIC = 0x5741474e;               // 'NGAW' little-endian
const VERSION = 1;

function AnimError(message, code) { const e = new Error(message); e.code = code || 'ANIM'; return e; }
const later = () => new Promise((r) => setImmediate(r));

/**
 * Where a sw x sh picture goes in a tw x th box: the part of it shown (crop: x, y, w, h, fractional) and
 * where that lands (dest: whole px).
 */
function fitRect(sw, sh, tw, th, fit) {
    if (fit === 'contain') {
        const k = Math.min(tw / sw, th / sh), dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
        return { crop: { x: 0, y: 0, w: sw, h: sh }, dest: { x: (tw - dw) >> 1, y: (th - dh) >> 1, w: dw, h: dh } };
    }
    const k = Math.max(tw / sw, th / sh), cw = tw / k, ch = th / k;
    return { crop: { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch }, dest: { x: 0, y: 0, w: tw, h: th } };
}

/**
 * One axis' filter: for each of n target pixels, the source pixels (index, weight) under it, from a crop
 * starting at s0, len long, in a source size long. { start, count, idx, wt }.
 */
function axisWeights(s0, len, n, size) {
    const k = len / n, start = new Uint32Array(n), count = new Uint32Array(n), idx = [], wt = [];
    for (let i = 0; i < n; i++) {
        let a, b;
        if (k >= 1) { a = s0 + i * k; b = a + k; } else { const c = s0 + (i + 0.5) * k; a = c - 0.5; b = c + 0.5; }
        a = Math.max(0, a); b = Math.min(size, b);
        if (b <= a) { const j = Math.max(0, Math.min(size - 1, Math.floor(a))); a = j; b = j + 1; }
        start[i] = idx.length;
        let sum = 0;
        for (let j = Math.floor(a); j < Math.ceil(b); j++) {
            const w = Math.min(b, j + 1) - Math.max(a, j);
            if (w > 1e-6) { idx.push(j); wt.push(w); sum += w; }
        }
        for (let q = start[i]; q < idx.length; q++) wt[q] /= sum;
        count[i] = idx.length - start[i];
    }
    return { start, count, idx: Uint32Array.from(idx), wt: Float32Array.from(wt) };
}

/**
 * A scaler from sw x sh RGBA to tw x th RGBA for one fit (made once, used for every frame):
 * scale(src, out) fills out (transparent outside the picture).
 */
function scaler(sw, sh, tw, th, fit) {
    const r = fitRect(sw, sh, tw, th, fit), d = r.dest;
    const X = axisWeights(r.crop.x, r.crop.w, d.w, sw), Y = axisWeights(r.crop.y, r.crop.h, d.h, sh);
    // the source rows the vertical filter reads, and a float row (premultiplied) for each, d.w wide
    let y0 = sh, y1 = 0;
    for (let q = 0; q < Y.idx.length; q++) { y0 = Math.min(y0, Y.idx[q]); y1 = Math.max(y1, Y.idx[q] + 1); }
    const rows = y1 - y0, tmp = new Float32Array(rows * d.w * 4);
    return function scale(src, out) {
        out.fill(0);
        for (let y = y0; y < y1; y++) {
            const so = y * sw * 4, to = (y - y0) * d.w * 4;
            for (let x = 0; x < d.w; x++) {
                let rr = 0, gg = 0, bb = 0, aa = 0;
                for (let q = X.start[x], e = q + X.count[x]; q < e; q++) {
                    const p = so + X.idx[q] * 4, a = src[p + 3] * X.wt[q];
                    rr += src[p] * a; gg += src[p + 1] * a; bb += src[p + 2] * a; aa += a;
                }
                const t = to + x * 4;
                tmp[t] = rr; tmp[t + 1] = gg; tmp[t + 2] = bb; tmp[t + 3] = aa;
            }
        }
        for (let y = 0; y < d.h; y++) {
            const oo = ((d.y + y) * tw + d.x) * 4;
            for (let x = 0; x < d.w; x++) {
                let rr = 0, gg = 0, bb = 0, aa = 0;
                for (let q = Y.start[y], e = q + Y.count[y]; q < e; q++) {
                    const t = ((Y.idx[q] - y0) * d.w + x) * 4, w = Y.wt[q];
                    rr += tmp[t] * w; gg += tmp[t + 1] * w; bb += tmp[t + 2] * w; aa += tmp[t + 3] * w;
                }
                const o = oo + x * 4;
                if (aa > 0.5) { out[o] = rr / aa + 0.5; out[o + 1] = gg / aa + 0.5; out[o + 2] = bb / aa + 0.5; out[o + 3] = aa + 0.5; }
            }
        }
        return out;
    };
}

/**
 * Which of n frames (delays ms) to keep so at most m remain, merged in time: the loop is cut into m equal
 * slices and a frame is kept where a new slice starts; a kept frame shows until the next kept one.
 * Returns [{ i, delay }].
 */
function keepFrames(delays, m) {
    const n = delays.length, total = delays.reduce((a, d) => a + d, 0);
    const out = [];
    if (n <= m) { delays.forEach((d, i) => out.push({ i, delay: d })); return out; }
    let t = 0, slice = -1;
    for (let i = 0; i < n; i++) {
        const s = Math.floor(t * m / total);
        if (s !== slice) { out.push({ i, delay: 0 }); slice = s; }
        out[out.length - 1].delay += delays[i];
        t += delays[i];
    }
    return out;
}

/**
 * GIF bytes -> { w, h, fit, frames: [{ png, delay }], duration, source: { w, h, frames, loops, bytes } }.
 * opts: { w, h, fit, maxFrames, maxRgbaBytes, maxPngBytes, onProgress(done, total) }. Throws (rejects)
 * with code 'GIF' for a file gif.js refuses.
 */
async function prepare(buf, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const W = o.w | 0, H = o.h | 0, fit = FITS.indexOf(o.fit) >= 0 ? o.fit : 'cover';
    if (!(W > 0 && H > 0 && W <= 1024 && H <= 1024)) throw AnimError('widget size ' + W + ' x ' + H + ' is not 1..1024 px');
    const info = GIF.parse(buf);
    const delays = GIF.timing(info).delays;
    const m = Math.max(1, Math.min(o.maxFrames, Math.floor(o.maxRgbaBytes / (W * H * 4))));
    const keep = keepFrames(delays, m), want = new Map(keep.map((k) => [k.i, k]));
    const scale = scaler(info.w, info.h, W, H, fit);
    const out = new Canvas(W, H), frames = [];
    const it = GIF.frames(info);
    let t0 = Date.now(), done = 0;
    for (let f = it.next(); f; f = it.next()) {
        const k = want.get(f.index);
        if (k) {
            scale(f.rgba, out.d);
            if (Date.now() - t0 >= o.yieldMs) { await later(); t0 = Date.now(); }
            frames.push({ png: out.png(o.pngLevel), delay: k.delay });
            done++;
            if (o.onProgress) { try { o.onProgress(done, keep.length); } catch (e) { /* the caller's */ } }
        }
        if (Date.now() - t0 >= o.yieldMs) { await later(); t0 = Date.now(); }
    }
    // over the PNG budget: fewer frames, merged in time again (no new encoding)
    let bytes = frames.reduce((a, fr) => a + fr.png.length, 0), list = frames;
    while (bytes > o.maxPngBytes && list.length > 1) {
        const m2 = Math.max(1, Math.min(list.length - 1, Math.floor(list.length * o.maxPngBytes / bytes)));
        list = keepFrames(list.map((fr) => fr.delay), m2).map((k) => ({ png: list[k.i].png, delay: k.delay }));
        bytes = list.reduce((a, fr) => a + fr.png.length, 0);
    }
    if (bytes > o.maxPngBytes) throw AnimError('one frame of this GIF is too big to keep (' + Math.round(bytes / 1024) + ' KB)', 'TOOBIG');
    return {
        w: W, h: H, fit, frames: list, duration: list.reduce((a, fr) => a + fr.delay, 0),
        source: { w: info.w, h: info.h, frames: info.frames.length, loops: info.loops, bytes: buf.length },
    };
}

/** Which frame shows when, looping: at(t) -> frame index, wait(t) -> ms until it changes. */
class Timeline {
    constructor(delays) {
        this.delays = delays.map((d) => Math.max(1, d));
        this.starts = [];
        let t = 0;
        this.delays.forEach((d) => { this.starts.push(t); t += d; });
        this.duration = t;
    }
    _pos(t) { return ((t % this.duration) + this.duration) % this.duration; }
    at(t) {
        const p = this._pos(t), s = this.starts;
        let lo = 0, hi = s.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= p) lo = mid; else hi = mid - 1; }
        return lo;
    }
    wait(t) { const i = this.at(t); return Math.max(1, Math.ceil(this.starts[i] + this.delays[i] - this._pos(t))); }
}

/**
 * Frames to play: { png, delay } each (prepare's, or Store.load's), w x h. at(t) / wait(t) as Timeline;
 * rgba(i) decodes frame i once and keeps it (for the GPU and for an app's preview) until drop().
 */
class Clip {
    constructor(frames, w, h) {
        this.frames = frames; this.w = w; this.h = h;
        this.timeline = new Timeline(frames.map((f) => f.delay));
        this.duration = this.timeline.duration;
        this.cache = [];
    }
    get count() { return this.frames.length; }
    at(t) { return this.timeline.at(t); }
    wait(t) { return this.timeline.wait(t); }
    rgba(i) {
        let px = this.cache[i];
        if (!px) {
            const im = PNG.decode(this.frames[i].png);
            if (im.w !== this.w || im.h !== this.h) throw AnimError('frame ' + i + ' is ' + im.w + ' x ' + im.h + ', not ' + this.w + ' x ' + this.h);
            px = this.cache[i] = im.data;
        }
        return px;
    }
    drop() { this.cache = []; }
}

/**
 * The prepared animation in one file: 'NGAW', version, the JSON's length, the JSON ({ w, h, fit, delays,
 * sizes, name, source, saved }), then every frame's PNG. Written under a temporary name and renamed, so a
 * crash or a full disk never leaves half a file in its place.
 */
class Store {
    constructor(file) { this.file = file; }
    has() { try { return fs.statSync(this.file).isFile(); } catch (e) { return false; } }
    save(a, extra) {
        const meta = Object.assign({ name: '' }, extra || {}, {
            w: a.w, h: a.h, fit: a.fit, delays: a.frames.map((f) => f.delay), sizes: a.frames.map((f) => f.png.length),
            source: a.source || null, saved: new Date().toISOString(),
        });
        const json = Buffer.from(JSON.stringify(meta), 'utf8'), head = Buffer.alloc(12);
        head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(VERSION, 4); head.writeUInt32LE(json.length, 8);
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, Buffer.concat([head, json].concat(a.frames.map((f) => f.png))));
        fs.renameSync(tmp, this.file);
        return meta;
    }
    /** { meta, frames: [{ png, delay }] }, or null when there is none; throws for a damaged file. */
    load() {
        let b;
        try { b = fs.readFileSync(this.file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        if (b.length < 12 || b.readUInt32LE(0) !== MAGIC) throw AnimError('not an animation file');
        if (b.readUInt32LE(4) !== VERSION) throw AnimError('animation file version ' + b.readUInt32LE(4));
        const jl = b.readUInt32LE(8);
        if (12 + jl > b.length) throw AnimError('animation file cut short');
        const meta = JSON.parse(b.toString('utf8', 12, 12 + jl));
        const sizes = meta.sizes || [], delays = meta.delays || [];
        if (!sizes.length || sizes.length !== delays.length || !(meta.w > 0 && meta.h > 0)) throw AnimError('animation file has no frames');
        let o = 12 + jl;
        const frames = sizes.map((n, i) => {
            if (!(n > 0) || o + n > b.length) throw AnimError('animation file cut short');
            const png = b.slice(o, o + n);
            o += n;
            return { png, delay: delays[i] };
        });
        return { meta, frames };
    }
    remove() { try { fs.unlinkSync(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

module.exports = { prepare, Store, Timeline, Clip, keepFrames, fitRect, scaler, FITS, DEFAULTS };
