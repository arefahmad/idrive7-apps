'use strict';
/**
 * gif.js - read a GIF (GIF87a / GIF89a, animated or not) into whole frames, composited the way a
 * browser shows them. Node 8, no npm modules; nothing here touches the file system.
 *
 *   const GIF = require('./kit/gif');
 *   const info = GIF.parse(buf);          // { w, h, loops, frames: [{ x, y, w, h, delay, disposal, ... }] }
 *   const it = GIF.frames(info);          // composites one frame per next() (yield between them)
 *   for (let f = it.next(); f; f = it.next()) use(f.index, f.rgba, f.delay);   // rgba: w x h x 4, reused
 *
 * What it follows (as Chromium and Firefox do):
 *   - the canvas starts transparent (the logical screen's background colour is not painted);
 *   - disposal 2 clears the frame's own rectangle to transparent, disposal 3 puts back the canvas as it
 *     was before the frame, 0 and 1 leave it; a frame's transparent index leaves the pixel under it;
 *   - a delay of 0 or 10 ms plays as 100 ms (rawDelay keeps what the file says);
 *   - a frame without a local palette uses the global one; a palette index past its end draws nothing;
 *   - truncated or damaged picture data: the pixels decoded up to there are drawn, the rest left alone,
 *     and the file's frames up to there are kept (a GIF with no picture at all is refused).
 * Limits (parse's second argument overrides them): sides at most 2048 px, at most 2000 frames and
 * 200 million frame pixels in all, so a hostile file cannot keep the head unit busy for minutes.
 */

const LIMITS = { side: 2048, frames: 2000, pixels: 200e6 };
const MIN_DELAY_MS = 20;            // shorter delays (0 or 10 ms) play at...
const SLOW_DELAY_MS = 100;          // ...this, as browsers do

function GifError(message) { const e = new Error(message); e.code = 'GIF'; return e; }

/** The sub-blocks from offset o: { chunks: [[start, end], ...], end (offset after the terminator), cut }. */
function subBlocks(b, o) {
    const chunks = [];
    while (o < b.length) {
        const n = b[o];
        if (n === 0) return { chunks, end: o + 1, cut: false };
        if (o + 1 + n > b.length) { if (o + 1 < b.length) chunks.push([o + 1, b.length]); return { chunks, end: b.length, cut: true }; }
        chunks.push([o + 1, o + 1 + n]);
        o += 1 + n;
    }
    return { chunks, end: b.length, cut: true };
}

/** A palette (3 bytes an entry) as 32-bit RGBA words, in this machine's byte order. */
function palette32(b, at, entries) {
    const p8 = new Uint8Array(entries * 4);
    for (let i = 0; i < entries; i++) {
        p8[i * 4] = b[at + i * 3]; p8[i * 4 + 1] = b[at + i * 3 + 1]; p8[i * 4 + 2] = b[at + i * 3 + 2]; p8[i * 4 + 3] = 255;
    }
    return new Uint32Array(p8.buffer);
}

/**
 * The file's structure, no pixels decoded: { w, h, loops (0 = for ever, null = once: no loop block),
 * frames: [{ x, y, w, h, interlaced, palette, transparent, delay, rawDelay, disposal, minCode, data, cut }] }.
 * Throws GifError (code 'GIF') for a file that is not a GIF or holds no picture.
 */
function parse(buf, limits) {
    const L = Object.assign({}, LIMITS, limits || {});
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (b.length < 13) throw GifError('not a GIF (too short)');
    const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (sig !== 'GIF87a' && sig !== 'GIF89a') throw GifError('not a GIF');
    const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8), packed = b[10];
    if (!w || !h) throw GifError('the GIF has no size');
    if (w > L.side || h > L.side) throw GifError('the GIF is too big (' + w + ' x ' + h + ', at most ' + L.side + ' px a side)');
    let o = 13, global = null;
    if (packed & 0x80) {
        const n = 2 << (packed & 7);
        if (o + n * 3 > b.length) throw GifError('the GIF is cut short');
        global = palette32(b, o, n);
        o += n * 3;
    }
    const frames = [];
    let gce = null, loops = null, pixels = 0;
    while (o < b.length) {
        const kind = b[o];
        if (kind === 0x3b) break;                                       // trailer
        if (kind === 0x21 && o + 1 < b.length) {                        // extension
            const label = b[o + 1], sb = subBlocks(b, o + 2);
            if (label === 0xf9 && sb.chunks.length && sb.chunks[0][1] - sb.chunks[0][0] >= 4) {
                const s = sb.chunks[0][0];
                const raw = (b[s + 1] | (b[s + 2] << 8)) * 10;
                gce = { disposal: (b[s] >> 2) & 7, transparent: b[s] & 1 ? b[s + 3] : -1, rawDelay: raw };
            } else if (label === 0xff && sb.chunks.length >= 2) {
                const s = sb.chunks[0][0], id = String.fromCharCode.apply(null, Array.prototype.slice.call(b, s, sb.chunks[0][1]));
                const d = sb.chunks[1][0];
                if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && sb.chunks[1][1] - d >= 3 && b[d] === 1) loops = b[d + 1] | (b[d + 2] << 8);
            }
            o = sb.end;
            if (sb.cut) break;
            continue;
        }
        if (kind !== 0x2c) break;                                       // unknown block: the rest is unreadable
        if (o + 10 > b.length) break;
        const fx = b[o + 1] | (b[o + 2] << 8), fy = b[o + 3] | (b[o + 4] << 8);
        const fw = b[o + 5] | (b[o + 6] << 8), fh = b[o + 7] | (b[o + 8] << 8), fp = b[o + 9];
        o += 10;
        let pal = global;
        if (fp & 0x80) {
            const n = 2 << (fp & 7);
            if (o + n * 3 > b.length) break;
            pal = palette32(b, o, n);
            o += n * 3;
        }
        if (o >= b.length) break;
        const minCode = b[o];
        const sb = subBlocks(b, o + 1);
        o = sb.end;
        const g = gce || { disposal: 0, transparent: -1, rawDelay: 0 };
        gce = null;
        if (fw && fh) {
            pixels += fw * fh;
            if (frames.length >= L.frames) throw GifError('the GIF has too many frames (at most ' + L.frames + ')');
            if (pixels > L.pixels) throw GifError('the GIF is too long to play (too many pixels in all)');
            frames.push({
                x: fx, y: fy, w: fw, h: fh, interlaced: !!(fp & 0x40), palette: pal, transparent: g.transparent,
                rawDelay: g.rawDelay, delay: g.rawDelay < MIN_DELAY_MS ? SLOW_DELAY_MS : g.rawDelay, disposal: g.disposal,
                minCode, data: sb.chunks, cut: sb.cut,
            });
        }
        if (sb.cut) break;
    }
    if (!frames.length) throw GifError('the GIF holds no picture');
    return { w, h, loops, frames, bytes: b };
}

/**
 * LZW-decode a frame's data (GIF flavour: variable code size up to 12 bits, clear and end codes, no early
 * change) into out (palette indices, at most n). Returns how many pixels it produced; damaged data ends it.
 */
function lzw(b, chunks, minCode, out, n, tables) {
    if (!(minCode >= 1 && minCode <= 11)) return 0;
    const clear = 1 << minCode, eoi = clear + 1;
    const prefix = tables.prefix, suffix = tables.suffix, stack = tables.stack;
    let size = minCode + 1, mask = (1 << size) - 1, next = eoi + 1;
    let prev = -1, first = 0, op = 0, cur = 0, bits = 0;
    for (let k = 0; k < chunks.length; k++) {
        const end = chunks[k][1];
        for (let p = chunks[k][0]; p < end; p++) {
            cur |= b[p] << bits; bits += 8;
            while (bits >= size) {
                const code = cur & mask;
                cur >>>= size; bits -= size;
                if (code === clear) { size = minCode + 1; mask = (1 << size) - 1; next = eoi + 1; prev = -1; continue; }
                if (code === eoi) return op;
                if (prev < 0) {
                    if (code >= clear) return op;                       // the first code after a clear must be a pixel
                    out[op++] = code; prev = code; first = code;
                    if (op >= n) return op;
                    continue;
                }
                let c = code, sp = 0;
                if (code >= next) {
                    if (code > next) return op;                         // a code not made yet: damaged
                    stack[sp++] = first; c = prev;                      // KwKwK: the previous string and its first pixel
                }
                while (c >= clear) { stack[sp++] = suffix[c]; c = prefix[c]; }
                stack[sp++] = c; first = c;
                while (sp > 0) { out[op++] = stack[--sp]; if (op >= n) return op; }
                if (next < 4096) {
                    prefix[next] = prev; suffix[next] = first; next++;
                    if (next > mask && size < 12) { size++; mask = (1 << size) - 1; }
                }
                prev = code;
            }
        }
    }
    return op;
}

/** Decoded row r of an interlaced frame h rows tall -> its row in the picture. */
function interlaceRows(h) {
    const rows = new Uint32Array(h);
    let r = 0;
    [[0, 8], [4, 8], [2, 4], [1, 2]].forEach((pass) => { for (let y = pass[0]; y < h; y += pass[1]) rows[r++] = y; });
    return rows;
}

/**
 * Composite info's frames one at a time: next() -> { index, rgba (Uint8Array w*h*4, straight alpha; the
 * same buffer every time, so copy what you keep), delay, count } or null after the last.
 */
function frames(info) {
    const W = info.w, H = info.h, list = info.frames, b = info.bytes;
    const canvas = new Uint8Array(W * H * 4), c32 = new Uint32Array(canvas.buffer);
    let maxArea = 0;
    list.forEach((f) => { maxArea = Math.max(maxArea, f.w * f.h); });
    const idx = new Uint8Array(maxArea);
    const tables = { prefix: new Uint16Array(4096), suffix: new Uint8Array(4096), stack: new Uint8Array(4097) };
    let i = 0, prev = null, saved = null;
    const clearRect = (f) => {
        const x1 = Math.min(W, f.x + f.w), y1 = Math.min(H, f.y + f.h);
        for (let y = f.y; y < y1; y++) c32.fill(0, y * W + f.x, y * W + x1);
    };
    return {
        count: list.length,
        next() {
            if (i >= list.length) return null;
            const f = list[i];
            if (prev) {
                if (prev.disposal === 2) clearRect(prev);
                else if (prev.disposal === 3 && saved) canvas.set(saved);
            }
            if (f.disposal === 3) { if (!saved) saved = new Uint8Array(canvas.length); saved.set(canvas); }
            const got = f.palette ? lzw(b, f.data, f.minCode, idx, f.w * f.h, tables) : 0;
            const pal = f.palette, np = pal ? pal.length : 0, tr = f.transparent;
            const rows = f.interlaced ? interlaceRows(f.h) : null;
            const x1 = Math.min(W, f.x + f.w), cols = x1 - f.x;
            for (let r = 0, s = 0; r < f.h && s < got; r++, s += f.w) {
                const y = f.y + (rows ? rows[r] : r);
                if (y >= H || cols <= 0) continue;
                const d = y * W + f.x, lim = Math.min(cols, got - s);
                for (let x = 0; x < lim; x++) {
                    const k = idx[s + x];
                    if (k !== tr && k < np) c32[d + x] = pal[k];
                }
            }
            prev = f;
            return { index: i++, rgba: canvas, delay: f.delay, count: list.length };
        },
    };
}

/** Every frame's delay (ms, as played) and the whole loop's length. */
function timing(info) {
    const delays = info.frames.map((f) => f.delay);
    return { delays, duration: delays.reduce((a, d) => a + d, 0) };
}

module.exports = { parse, frames, timing, LIMITS, GifError };
