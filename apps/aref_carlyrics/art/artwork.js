'use strict';
/**
 * artwork.js - the album art for a song, and the blurred backdrop made from it.
 *
 * The cover comes first from the car itself: BMW's media service saves the phone's artwork for the song playing
 * (CarPlay sends it) as a JPEG on a RAM disk, and names it in the song's metadata (COVER_FILE, e.g.
 * /tmp/mediaramdisk_hu/covers/cover_MGU_MediaEngineWifi_7.jpg, readable by apps): no internet needed, and
 * exactly what Apple Music shows. Without it (no file, not readable), Apple's iTunes Search API (free, no key). It is decoded on the car (vendor/jpeg_decoder.js)
 * into two pixel pictures:
 *
 *   cover: ART_PX x ART_PX, centre-cropped, corners rounded in its alpha
 *   blur:  BG_W x BG_H, the cover heavily blurred and darkened, drawn stretched behind the whole page
 *   blur2: the same from the cover turned round, a second layer drifting the other way
 *          (the renderer scales pictures by the nearest pixel, and a blur this soft shows no steps)
 *
 *   const art = new Artwork(request, log);
 *   art.get({ title, artist, album })   // { state: 'none' | 'loading' | 'ready' | 'missing', cover, blur, tint, colours }
 *
 * request(method, host, path, headers) -> Promise<{ status, body: Buffer }> (net/http.js).
 * Node 8: no ?., ??, object spread or optional catch binding.
 */
const querystring = require('querystring');
const url = require('url');
const LyricsLib = require('./lyrics');

const ART_PX = 600;           // the cover's pixels (drawn ~380 logical px, ~440 screen px)
const ART_R = 0.04;           // its corner radius, share of its side
const BG_W = 400, BG_H = 150; // the backdrop's pixels (drawn ~1600 x 600 logical)
const BLUR = 18;              // the backdrop's box-blur radius (px of BG_W), three passes ~ a gaussian
const DIM = 0.55;             // the backdrop's brightness (Apple Music: the blur under a 50 % black layer)
const SATURATE = 1.5;         // ... and its colour (Apple Music: saturate(1.5))
const RETRY_MS = 60000;       // a failed lookup is tried again after this long
const CACHE = 6;              // covers kept decoded by default (a song played again, skipping back: at once); opts.cache
const SETTLE_MS = 300;        // skipping fast: a song is looked up once it has been current this long ...
const SKIP_MS = 4000;
const CAR_WAIT_MS = 1200;      // a new song: give the car this long to name its own cover before asking iTunes         // ... unless the song before it played this long (not skipping): then at once
const MISSING_MS = 600000;    // no match found: asked again after 10 min (a skip can send a half-changed title)
const DISK_MAX = 300;         // covers kept on disk (opts.dir): a song played again shows at once, even offline
const RAW_MAX_BYTES = 25e6;   // decoded covers kept too (.rgba next to the .jpg): a replay needs no JPEG decode (1-6 s on a busy head unit)

/** Lower-case words only, for comparing names ("Lil' Uzi Vert" ~ "lil uzi vert"). */
function norm(s) { return LyricsLib.fold(String(s || '')).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * The best iTunes result for the song: the same album counts most (a song is on its single, its album and
 * compilations, each with its own cover; the one playing is the one Apple Music shows), then title and artist.
 */
function pick(results, track) {
    const list = (results || []).filter((r) => r && r.artworkUrl100);
    if (!list.length) return null;
    const t = norm(LyricsLib.baseTitle(track.title)), a = norm(String(track.artist || '').split(/,|&| feat\.? | x /i)[0]);
    const score = (r) => {
        const rt = norm(LyricsLib.baseTitle(r.trackName)), ra = norm(r.artistName);
        let s = 0;
        if (rt === t) s += 4; else if (rt.indexOf(t) >= 0 || t.indexOf(rt) >= 0) s += 2;
        if (a && (ra.indexOf(a) >= 0 || a.indexOf(ra) >= 0)) s += 3;
        if (track.album) {
            const ca = norm(r.collectionName), ta = norm(track.album);
            if (ca === ta) s += 6; else if (ca && ta && (ca.indexOf(ta) >= 0 || ta.indexOf(ca) >= 0)) s += 3;
        }
        if (/various artists/i.test(r.collectionArtistName || '')) s -= 2;          // compilations last
        return s;
    };
    const best = list.map((r) => [score(r), r]).sort((x, y) => y[0] - x[0])[0];
    return best[0] >= 3 ? best[1] : null;
}

/** The artwork link at size px (iTunes serves any size: .../100x100bb.jpg -> .../600x600bb.jpg). */
function sized(href, px) { return String(href).replace(/\/\d+x\d+(bb)?(-\d+)?\.(jpg|png|webp)$/i, '/' + px + 'x' + px + 'bb.jpg'); }

/**
 * Bilinear resample of RGBA (sw x sh) to a square n x n, centre-cropped; the corners rounded (radius r px)
 * in the alpha. From G's Music (nickgcode/idrive7-apps, MIT). Returns { px, avg: [r, g, b] }.
 */
function squareResample(src, sw, sh, n, r) {
    const side = Math.min(sw, sh), ox = (sw - side) / 2, oy = (sh - side) / 2;
    const out = new Uint8Array(n * n * 4), k = side / n;
    let sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < n; y++) {
        const fy = Math.max(0, Math.min(sh - 1.001, oy + (y + 0.5) * k - 0.5)), y0 = fy | 0, wy = fy - y0;
        for (let x = 0; x < n; x++) {
            const fx = Math.max(0, Math.min(sw - 1.001, ox + (x + 0.5) * k - 0.5)), x0 = fx | 0, wx = fx - x0;
            const a = (y0 * sw + x0) * 4, b = a + 4, c = a + sw * 4, d = c + 4, o = (y * n + x) * 4;
            for (let ch = 0; ch < 3; ch++) {
                out[o + ch] = (src[a + ch] * (1 - wx) + src[b + ch] * wx) * (1 - wy) + (src[c + ch] * (1 - wx) + src[d + ch] * wx) * wy;
            }
            sr += out[o]; sg += out[o + 1]; sb += out[o + 2];
            let al = 255;
            if (r > 0) {
                const cx = x < r ? r : x >= n - r ? n - r : -1, cy = y < r ? r : y >= n - r ? n - r : -1;
                if (cx >= 0 && cy >= 0) {
                    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dist = Math.sqrt(dx * dx + dy * dy);
                    al = Math.round(255 * Math.max(0, Math.min(1, r - dist + 0.5)));
                }
            }
            out[o + 3] = al;
        }
    }
    const m = n * n;
    return { px: out, avg: [Math.round(sr / m), Math.round(sg / m), Math.round(sb / m)] };
}

/** One box-blur pass of channel data (w x h floats, 3 channels interleaved) along x, then along y. */
function boxPass(c, w, h, r) {
    const tmp = new Float32Array(c.length), win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        for (let ch = 0; ch < 3; ch++) {
            let acc = 0;
            for (let i = -r; i <= r; i++) acc += c[(y * w + Math.max(0, Math.min(w - 1, i))) * 3 + ch];
            for (let x = 0; x < w; x++) {
                tmp[(y * w + x) * 3 + ch] = acc / win;
                acc += c[(y * w + Math.min(w - 1, x + r + 1)) * 3 + ch] - c[(y * w + Math.max(0, x - r)) * 3 + ch];
            }
        }
    }
    for (let x = 0; x < w; x++) {
        for (let ch = 0; ch < 3; ch++) {
            let acc = 0;
            for (let i = -r; i <= r; i++) acc += tmp[(Math.max(0, Math.min(h - 1, i)) * w + x) * 3 + ch];
            for (let y = 0; y < h; y++) {
                c[(y * w + x) * 3 + ch] = acc / win;
                acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + ch] - tmp[(Math.max(0, y - r) * w + x) * 3 + ch];
            }
        }
    }
}

/**
 * The backdrop: the cover (RGBA n x n) scaled to cover w x h, blurred (three box passes), saturation
 * lifted a little and brightness to DIM, as Apple Music's blurred artwork behind its lyrics. RGBA bytes.
 */
function backdrop(px, n, w, h, turned) {
    // cover-fit: the square's middle band, as wide as the page is (turned: the cover upside down and
    // mirrored, a second layer that moves the other way, as Apple Music's background flows)
    const k = n / w, oy = (n - h * k) / 2, c = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        let sy = Math.max(0, Math.min(n - 1, Math.round(oy + (y + 0.5) * k)));
        if (turned) sy = n - 1 - sy;
        for (let x = 0; x < w; x++) {
            let sx = Math.max(0, Math.min(n - 1, Math.round((x + 0.5) * k)));
            if (turned) sx = n - 1 - sx;
            const s = (sy * n + sx) * 4, o = (y * w + x) * 3;
            c[o] = px[s]; c[o + 1] = px[s + 1]; c[o + 2] = px[s + 2];
        }
    }
    for (let i = 0; i < 3; i++) boxPass(c, w, h, BLUR);
    const out = new Uint8Array(w * h * 4);
    for (let i = 0, o = 0; i < c.length; i += 3, o += 4) {
        const r = c[i], g = c[i + 1], b = c[i + 2], l = 0.3 * r + 0.59 * g + 0.11 * b;
        const sat = (v) => Math.max(0, Math.min(255, (l + (v - l) * SATURATE) * DIM));
        out[o] = sat(r); out[o + 1] = sat(g); out[o + 2] = sat(b); out[o + 3] = 255;
    }
    return out;
}

/**
 * Apple Music's flowing background is the cover's colours swirling, not one blurred picture sliding: the colour
 * blobs. Nine patches of the cover (a 3 x 3 grid, each half the cover wide) are compared by their average colour and
 * the BLOB_N most different are kept (the first is the most colourful); each is blurred, lifted like the backdrop
 * (a little brighter) and faded to clear towards a soft round edge. RGBA bytes, BLOB_PX square, straight alpha.
 */
const BLOB_PX = 128, BLOB_N = 4;
function blobs(px, n) {
    const side = Math.round(n / 2), spots = [];
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
        const x0 = Math.round((n - side) * gx / 2), y0 = Math.round((n - side) * gy / 2);
        let r = 0, g = 0, b = 0, k = 0;
        for (let y = y0 + 4; y < y0 + side - 4; y += 4) for (let x = x0 + 4; x < x0 + side - 4; x += 4) { const i = (y * n + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; k++; }
        r /= k; g /= k; b /= k;
        spots.push({ x0, y0, c: [r, g, b], sat: Math.max(r, g, b) - Math.min(r, g, b) });
    }
    const dist = (a, b) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1], a.c[2] - b.c[2]);
    const picked = [spots.slice().sort((a, b) => b.sat - a.sat)[0]];
    while (picked.length < BLOB_N) {
        let best = null, bestD = -1;
        spots.forEach((sp) => { if (picked.indexOf(sp) >= 0) return; const d = Math.min.apply(null, picked.map((q) => dist(q, sp))); if (d > bestD) { bestD = d; best = sp; } });
        picked.push(best);
    }
    const B = BLOB_PX, k = side / B;
    return picked.map((sp) => {
        const c = new Float32Array(B * B * 3);
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
            const sx = Math.min(n - 1, Math.round(sp.x0 + (x + 0.5) * k)), sy = Math.min(n - 1, Math.round(sp.y0 + (y + 0.5) * k));
            const s = (sy * n + sx) * 4, o = (y * B + x) * 3;
            c[o] = px[s]; c[o + 1] = px[s + 1]; c[o + 2] = px[s + 2];
        }
        for (let i = 0; i < 3; i++) boxPass(c, B, B, 9);
        const out = new Uint8Array(B * B * 4), h = (B - 1) / 2;
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
            const o = (y * B + x) * 3, q = (y * B + x) * 4, r0 = c[o], g0 = c[o + 1], b0 = c[o + 2], l = 0.3 * r0 + 0.59 * g0 + 0.11 * b0;
            const v = (u) => Math.max(0, Math.min(255, (l + (u - l) * SATURATE * 1.15) * DIM * 1.25));
            const d = Math.min(1, Math.hypot(x - h, y - h) / h), f = 1 - d * d * (3 - 2 * d);   // no visible rim: fades from the middle out
            out[q] = v(r0); out[q + 1] = v(g0); out[q + 2] = v(b0); out[q + 3] = Math.round(255 * Math.pow(f, 1.4));
        }
        return out;
    });
}

class Artwork {
    /**
     * opts: { px: the cover's side (default ART_PX), blur: false to skip the page backdrops (ETA Bar draws its own),
     * dir: a folder for a disk cache of the downloaded JPEGs }.
     */
    constructor(request, log, decode, opts) {
        this.request = request;
        this.log = log;
        this.decode = decode || require('./jpeg_decoder');
        this.opts = Object.assign({ px: ART_PX, blur: true, dir: null, cache: CACHE }, opts);
        this.cache = new Map();      // key -> entry
        this.busy = new Set();
        this.want = { k: null, since: 0 };
        this.ver = 0;                // bumped whenever a cover becomes ready (the screen uploads it once)
        if (this.opts.dir) { try { require('fs').mkdirSync(this.opts.dir); } catch (e) { /* there */ } }
    }

    static key(track) { return norm(track.title) + '|' + norm(track.artist) + '|' + norm(track.album); }

    /** The entry for track; starts a lookup when there is none (or a failed one is old). */
    get(track) {
        if (!track || !track.title) return { state: 'none' };
        const k = Artwork.key(track), e = this.cache.get(k), now = Date.now();
        // offline, iTunes failed: once the car names its own cover file, try again at once
        const again = e && (e.state === 'error' || e.state === 'missing') && track.cover && e.cover0 !== track.cover;
        if (track.cover) this.sawCover = true;
        // the car rewrote its file after we read it (we caught the last song's picture): read it again
        if (e && e.state === 'ready' && e.src === 'car' && track.cover === e.carPath && now - (e.checkedAt || 0) > 1000 && !this.busy.has(k + '#car')) {
            e.checkedAt = now;
            try {
                if (require('fs').statSync(track.cover).mtime.getTime() > e.carMtime + 200) {
                    this.busy.add(k + '#car');
                    this._fromCar(track, this._file(k)).then((v) => { if (v) this._put(k, v); }, () => {}).then(() => this.busy.delete(k + '#car'));
                }
            } catch (x) { /* gone */ }
        }
        // a cover from iTunes or the disk while the car has its own file: the car's wins (it's what Apple Music shows)
        if (e && e.state === 'ready' && e.src !== 'car' && track.cover && e.carTried !== track.cover && !this.busy.has(k + '#car')) {
            e.carTried = track.cover;
            this.busy.add(k + '#car');
            this._fromCar(track, this._file(k)).then((v) => { if (v) this._put(k, v); }, () => {}).then(() => this.busy.delete(k + '#car'));
        }
        if (e && !again && !(e.state === 'error' && now - e.at > RETRY_MS) && !(e.state === 'missing' && now - e.at > MISSING_MS)) return e;
        if (this.want.k !== k) this.want = { k: k, since: now - (now - this.want.since >= SKIP_MS ? SETTLE_MS : 0) };
        // one lookup at a time, for the song that has stayed current: fast skips start nothing
        const settled = now - this.want.since >= SETTLE_MS || !!track.cover || (this.opts.dir && this._file(k) && require('fs').existsSync(this._file(k)));
        // the song that stays current may start beside one older lookup still on its way (at most two)
        const waitCar = this.sawCover && !track.cover && now - this.want.since < CAR_WAIT_MS;
        if (!this.busy.has(k) && this.busy.size < 2 && settled && !waitCar) {
            this.busy.add(k);
            this._load(track).then((v) => this._put(k, v), (err) => {
                this.log.warn('artwork: ' + (err && err.message));
                this._put(k, { state: 'error', at: Date.now(), cover0: track.cover });
            }).then(() => this.busy.delete(k));
        }
        return e || { state: 'loading' };
    }

    _put(k, v) {
        if (v.state === 'ready') v.ver = ++this.ver;
        this.cache.delete(k);
        this.cache.set(k, v);
        while (this.cache.size > this.opts.cache) this.cache.delete(this.cache.keys().next().value);
    }

    _file(k) { return this.opts.dir ? require('path').join(this.opts.dir, require('crypto').createHash('sha1').update('v2|' + k).digest('hex').slice(0, 16) + '.jpg') : null; }

    async _load(track) {
        const fs = require('fs'), f = this._file(Artwork.key(track)), t0 = Date.now();
        // decoded before: its pixels, no decode
        if (f) {
            try {
                const px = fs.readFileSync(f.replace(/\.jpg$/, '.' + this.opts.px + '.rgba'));
                if (px.length === this.opts.px * this.opts.px * 4) {
                    const v = this.fromPixels(new Uint8Array(px.buffer, px.byteOffset, px.length));
                    v.src = 'disk'; this.log.info('artwork: decoded cover from disk in ' + (Date.now() - t0) + ' ms');
                    return v;
                }
            } catch (e) { /* not kept */ }
        }
        // the car's own copy of the phone's artwork (offline; the file can come a moment after the metadata)
        const car = await this._fromCar(track, f);
        if (car) return car;
        // the homelab's pack keeps covers by title and artist only (no album): that file too
        const fAlt = this._file(norm(track.title) + '|' + norm(track.artist) + '|');
        if (f && !fs.existsSync(f) && fAlt && fs.existsSync(fAlt)) { try { const v = this.fromJpeg(fs.readFileSync(fAlt), f); v.src = 'disk'; this.log.info('artwork: from the pack in ' + (Date.now() - t0) + ' ms'); return v; } catch (e) { /* unreadable */ } }
        if (f) { try { const buf = fs.readFileSync(f); const v = this.fromJpeg(buf, f); v.src = 'disk'; this.log.info('artwork: from disk in ' + (Date.now() - t0) + ' ms'); return v; } catch (e) { /* not cached */ } }
        const term = [LyricsLib.baseTitle(track.title), String(track.artist || '').split(/,|&/)[0]].join(' ');
        const q = querystring.stringify({ term: term, media: 'music', entity: 'song', limit: 10 });
        const r = await this.request('GET', 'itunes.apple.com', '/search?' + q, { Accept: 'application/json' });
        if (r.status !== 200) throw new Error('iTunes search HTTP ' + r.status);
        let best = pick((JSON.parse(r.body.toString('utf8')) || {}).results, track);
        // the album known but no song on it found: look the album up itself, its cover is the one Apple Music shows
        if (track.album && !(best && norm(best.collectionName) === norm(track.album))) {
            const qa = querystring.stringify({ term: track.album + ' ' + String(track.artist || '').split(/,|&/)[0], media: 'music', entity: 'album', limit: 10 });
            try {
                const ra = await this.request('GET', 'itunes.apple.com', '/search?' + qa, { Accept: 'application/json' });
                const albums = ra.status === 200 ? ((JSON.parse(ra.body.toString('utf8')) || {}).results || []) : [];
                const a0 = norm(String(track.artist || '').split(/,|&| feat\.? | x /i)[0]);
                const hit = albums.find((x) => x && x.artworkUrl100 && norm(x.collectionName) === norm(track.album) &&
                    (!a0 || norm(x.artistName).indexOf(a0) >= 0 || a0.indexOf(norm(x.artistName)) >= 0));
                if (hit) best = hit;
            } catch (e) { /* the song's result stands */ }
        }
        if (!best) { this.log.info('artwork: none found for "' + track.title + '"'); return { state: 'missing', at: Date.now(), cover0: track.cover }; }
        const t1 = Date.now(), u = url.parse(sized(best.artworkUrl100, this.opts.px));
        const img = await this.request('GET', u.hostname, u.path, {});
        if (img.status !== 200) throw new Error('artwork HTTP ' + img.status);
        const t2 = Date.now(), v = this.fromJpeg(img.body, f);
        v.src = 'itunes';
        if (f) this._save(f, img.body);
        this.log.info('artwork: ready in ' + (Date.now() - t0) + ' ms (search ' + (t1 - t0) + ', image ' + (t2 - t1) + ', decode ' + (Date.now() - t2) + ')');
        return v;
    }

    /** The car's own cover file for track (track.cover), or null: tried for up to ~2.4 s while the car writes it. */
    async _fromCar(track, f) {
        const fs = require('fs'), t0 = Date.now();
        if (!(track.cover && /^\/tmp\/mediaramdisk/.test(track.cover) && /\.(jpe?g)$/i.test(track.cover))) return null;
        // the car reuses a few file names (cover_..._3.jpg): right after a skip the name can still hold the last song's
        // picture. A file older than this song (its first request, less 1.5 s) isn't this song's: wait for the new one.
        const since = (this.want && this.want.k === Artwork.key(track) ? this.want.since : Date.now()) - 1500;
        for (let i = 0; i < 8; i++) {
            try {
                let file = track.cover, st = null;
                try { st = fs.statSync(file); } catch (e) {
                    // the name in the metadata doesn't exist (often: the car writes the picture under another number):
                    // the newest picture in the same folder written since the song changed
                    const dir = require('path').dirname(file);
                    const pick = fs.readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n)).map((n) => ({ f: require('path').join(dir, n), t: fs.statSync(require('path').join(dir, n)).mtime.getTime() }))
                        .filter((x) => x.t >= since).sort((a, b) => b.t - a.t)[0];
                    if (!pick) throw e;
                    file = pick.f; st = fs.statSync(file);
                }
                if (st.mtime.getTime() < since) { if (i === 7) this.log.info('artwork: the car\'s file is still the last song\'s'); throw Object.assign(new Error('stale'), { code: 'STALE' }); }
                const buf = await new Promise((ok, no) => fs.readFile(file, (e, b) => (e ? no(e) : ok(b))));
                if (buf.length > 100) {
                    const v = this.fromJpeg(buf, f);
                    v.src = 'car'; v.carPath = track.cover; v.carMtime = st.mtime.getTime();
                    if (f) this._save(f, buf);
                    this.log.info('artwork: from the car in ' + (Date.now() - t0) + ' ms');
                    return v;
                }
            } catch (e) { if (i === 7 && e.code !== 'STALE') this.log.info('artwork: the car\'s file ' + (e.code || e.message)); }
            await new Promise((ok) => setTimeout(ok, 300));
        }
        return null;
    }

    _save(f, buf) {
        const fs = require('fs'), path = require('path');
        try {
            fs.writeFileSync(f, buf);
            const all = fs.readdirSync(this.opts.dir).filter((n) => /\.jpg$/.test(n));
            if (all.length > DISK_MAX) {
                all.map((n) => ({ n: n, t: fs.statSync(path.join(this.opts.dir, n)).mtimeMs })).sort((a, b) => a.t - b.t)
                    .slice(0, all.length - DISK_MAX).forEach((x) => fs.unlinkSync(path.join(this.opts.dir, x.n)));
            }
        } catch (e) { /* full disk: no cache */ }
    }

    /** The entry made from JPEG bytes (also for tests); f: the song's cover file, to keep the decoded pixels beside. */
    fromJpeg(buf, f) {
        const im = this.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 48 });
        const n = this.opts.px, sq = squareResample(im.data, im.width, im.height, n, Math.round(n * ART_R));
        if (f) this._saveRaw(f, sq.px);
        return this.fromPixels(sq.px, sq.avg);
    }

    /** The decoded pixels kept beside the song's .jpg (written in the background), the oldest let go past RAW_MAX_BYTES. */
    _saveRaw(f, px) {
        const fs = require('fs'), path = require('path'), out = f.replace(/\.jpg$/, '.' + this.opts.px + '.rgba');
        fs.writeFile(out, Buffer.from(px.buffer, px.byteOffset, px.length), (err) => {
            if (err) return;
            try {
                const all = fs.readdirSync(this.opts.dir).filter((n) => /\.rgba$/.test(n)).map((n) => { const st = fs.statSync(path.join(this.opts.dir, n)); return { n: n, t: st.mtimeMs, b: st.size }; })
                    .sort((a, b) => b.t - a.t);
                let sum = 0;
                all.forEach((x) => { sum += x.b; if (sum > RAW_MAX_BYTES) fs.unlinkSync(path.join(this.opts.dir, x.n)); });
            } catch (e) { /* next time */ }
        });
    }

    /** The entry made from the cover's pixels (opts.px square, RGBA). */
    fromPixels(px, avg) {
        const n = this.opts.px;
        if (!avg) { let r = 0, g = 0, b = 0, k = 0; for (let i = 0; i < px.length; i += 64) { r += px[i]; g += px[i + 1]; b += px[i + 2]; k++; } avg = [r / k, g / k, b / k].map(Math.round); }
        const sq = { px: px, avg: avg };
        const e = { state: 'ready', at: Date.now(), cover: sq.px, n: n, tint: sq.avg };
        if (this.opts.blur) { e.blur = backdrop(sq.px, n, BG_W, BG_H); e.blur2 = backdrop(sq.px, n, BG_W, BG_H, true); e.blobs = blobs(sq.px, n); }
        return e;
    }
}

module.exports = { Artwork, pick, sized, squareResample, backdrop, blobs, ART_PX, BG_W, BG_H, BLOB_PX, BLOB_N };
