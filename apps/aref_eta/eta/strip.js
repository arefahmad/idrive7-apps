'use strict';
/**
 * strip.js - Apple Maps' arrival time drawn on the instrument cluster, in the blank space of the bottom strip
 * (between the clock and the drive mode), through the separately installed "Cluster renderer" tool
 * (cluster-render, robertnisipeanu/idrive-apps, from the Store).
 *
 * Why drawn: BMW's own strip shows a route's ETA only for BMW's navigation. During a CarPlay route it goes blank,
 * and nothing in the car's guidance services changes that (0.2-0.4 tried the street field and the guidance state).
 *
 * One small "image" layer on the "panel" target (the whole cluster, 1920 x 720, scene 0x010004f8 of its own, the
 * target M Track and G's Dash's full-screen test draw on), class "content", never exclusive, never contending: BMW's
 * own cluster content in that slot always wins, and the rest of the panel stays transparent. The image is redrawn
 * the moment the route's numbers change (each update the phone sends, a reroute too) and only then: a 720 x 80
 * picture a few times a minute, so it costs the cluster link nearly nothing.
 *
 * Shown only while CarPlay guides and the car has the route's arrival data (that's when BMW's strip is blank),
 * or for PREVIEW_MS after Preview. Hidden otherwise: the service releases the panel after its linger.
 *
 * Node 8. Never throws out: every call is caught.
 */
const fs = require('fs');
const path = require('path');
const CR = require('./kit/cluster_render');
const { Canvas } = require('./kit/canvas');
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');

const IW = 720, IH = 80;                  // the image; the rect on the cluster scales it (bilinear)
const PREVIEW_MS = 30000;
const DEF = { on: true, x: 968, y: 668, scale: 1, look: 'plain' };   // x, y: the text's centre on the cluster (px), where BMW's street name sits (measured on a G-series cluster photo); scale of IW x IH
const LIMIT = { x: [200, 1720], y: [40, 700], scale: [0.5, 2] };
const STEP = { x: 20, y: 6, scale: 0.1 };

const LOOKS = ['plain', 'card'];
// Apple's dark-mode label colours: white, secondary gray, and the system green / orange / red for traffic
const WHITE = [255, 255, 255, 255], GRAY = [142, 142, 147, 255];
const TRAFFIC = { green: [48, 209, 88, 255], yellow: [255, 159, 10, 255], red: [255, 69, 58, 255] };
const SAMPLE = [{ v: '6:42', u: 'arrival' }, { v: '23', u: 'min', c: 'green' }, { v: '14.2', u: 'mi' }];

/**
 * The trip as the strip's parts, Apple Maps' way: arrival 6:42 (no AM / PM), time left 23 min or 1:05 hr,
 * distance 14.2 mi. r: route.js pick(); arrival(r): 'h:mm AM' text or null.
 */
function parts(r, arrival) {
    if (!r) return null;
    const out = [];
    const a = arrival && arrival.replace(/\s*[AP]M$/, '');
    if (a) out.push({ v: a, u: 'arrival' });
    if (r.travelSec || r.travelSec === 0) {
        const m = Math.max(0, Math.round(r.travelSec / 60));
        out.push(m < 60 ? { v: String(m), u: 'min', c: r.traffic } : { v: Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60), u: 'hr', c: r.traffic });
    }
    if (r.dist) out.push({ v: r.dist, u: r.unit || '' });
    return out.length ? out : null;
}

function clamp(v, r) { return Math.max(r[0], Math.min(r[1], v)); }

class Strip {
    /** ctx: the app's; note(line): writes to the app's logs. */
    constructor(ctx, note) {
        this.ctx = ctx; this.log = ctx.log; this.note = note;
        this.file = path.join(ctx.dataDir, 'strip.json');
        this.cfg = Object.assign({}, DEF);
        try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first run */ }
        this.cr = null; this.ref = null; this.ready = false;
        this.text = null; this.shown = false; this.previewUntil = 0;
        this.state = { client: 'starting', layer: '', target: '', reason: '' };
        // Inter (OFL), the open look-alike of Apple's SF Pro (Car Lyrics' atlases): data/fonts -> fonts.pack
        this.fonts = { bold: 'bold', med: 'label' };
        try {
            const dirs = [path.join(__dirname, 'fonts'), path.join(__dirname, 'data', 'fonts'), path.join(__dirname, '..', 'data', 'fonts')];
            const dir = dirs.find((d) => fs.existsSync(d + '.pack') || fs.existsSync(d)) || dirs[0];
            const src = pack.open(dir);
            if (fonts.register('eta_bold', src.json('cl_bold.json'))) this.fonts.bold = 'eta_bold';
            if (fonts.register('eta_med', src.json('cl_med.json'))) this.fonts.med = 'eta_med';
        } catch (e) { this.note('fonts: ' + e.message); }
    }

    save() { try { fs.writeFileSync(this.file, JSON.stringify(this.cfg)); } catch (e) { /* full disk: kept for this run */ } }

    rect() {
        const s = this.cfg.scale, w = Math.round(IW * s), h = Math.round(IH * s);
        return { x: Math.round(this.cfg.x - w / 2), y: Math.round(this.cfg.y - h / 2), w: w, h: h };
    }

    start() {
        const c = CR.loadClient();
        if (c.error) { this.state.client = c.text; this.note('cluster: ' + c.text); return; }
        try {
            const cr = this.cr = new c.ClusterRender('aref_eta', c.sock);
            cr.on('ready', () => {
                this.ready = true; this.state.client = 'connected';
                this.note('cluster: connected');
                if (this.ref && this.pixels) { try { cr.pixels(this.ref, null, this.pixels); } catch (e) { /* next draw */ } }
            });
            cr.on('disconnected', () => { this.ready = false; this.state.client = 'reconnecting'; });
            cr.on('layer', (ref, state, reason) => {
                if (ref !== this.ref) return;
                if (state !== this.state.layer) this.note('cluster: layer ' + state + (reason ? ' (' + reason + ')' : ''));
                this.state.layer = state; this.state.reason = reason || '';
            });
            cr.on('target', (name, state, holder, reason) => {
                if (name !== 'panel') return;
                const s = state + (holder ? ' by ' + holder : '') + (reason ? ' (' + reason + ')' : '');
                if (s !== this.state.target) this.note('cluster: panel ' + s);
                this.state.target = s;
            });
            cr.on('refused', (op, ref, reason) => { this.note('cluster: refused ' + op + ': ' + reason); this.state.reason = 'refused: ' + reason; });
            cr.on('error', (e) => { this.state.client = 'error: ' + (e && e.message || e); });
            const r = this.rect();
            this.ref = cr.image({ target: 'panel', klass: 'content', z: 20, x: r.x, y: r.y, w: r.w, h: r.h, iw: IW, ih: IH,
                sampling: 'bilinear', fps: 2, visible: false });
            cr.connect();
        } catch (e) {
            this.state.client = 'failed: ' + e.message;
            this.note('cluster: start failed: ' + (e && e.stack || e));
        }
    }

    /**
     * The picture, in Apple Maps' CarPlay style: each value in Inter Bold (white; the minutes in Apple's traffic
     * colours when the car says), its unit after it in Inter Medium, Apple's secondary gray; the row centred.
     * look 'card': on a dark rounded card, as CarPlay's dashboard cards; 'plain': straight on the strip.
     */
    draw(parts) {
        const cv = new Canvas(IW, IH);
        cv.clear([0, 0, 0, 0]);
        const V = { font: this.fonts.bold, literal: true }, U = { font: this.fonts.med, literal: true };
        const VS = 42, US = 28, GAP = 9, SEP = 34;
        const row = parts.map((p) => ({ p: p, vw: cv.textWidth(p.v, VS, V), uw: p.u ? cv.textWidth(p.u, US, U) : 0 }));
        const w = row.reduce((a, r) => a + r.vw + (r.uw ? GAP + r.uw : 0), 0) + SEP * Math.max(0, row.length - 1);
        const base = IH / 2 + VS * 0.36;
        if (this.cfg.look === 'card') {
            const pw = Math.min(IW - 4, w + 60), ph = 66;
            cv.roundRect((IW - pw) / 2, (IH - ph) / 2, pw, ph, ph / 2, [28, 28, 30, 225]);
        }
        let x = (IW - w) / 2;
        row.forEach((r) => {
            const c = TRAFFIC[r.p.c] || WHITE;
            cv.text(r.p.v, x, base + 2, VS, [0, 0, 0, 110], V);       // a soft shadow, for BMW's own strip shading
            cv.text(r.p.v, x, base, VS, c, V);
            x += r.vw;
            if (r.uw) { x += GAP; cv.text(r.p.u, x, base, US, GRAY, U); x += r.uw; }
            x += SEP;
        });
        return Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    }

    /** Called every tick: parts [{ v, u, c }] (null: nothing to show). */
    update(parts) {
        if (!this.cr || !this.ref) return;
        const preview = Date.now() < this.previewUntil;
        const p = preview && !parts ? SAMPLE : parts;
        const want = !!(this.cfg.on && p && (parts || preview));
        try {
            const key = p ? JSON.stringify(p) + this.cfg.look : null;
            if (key && key !== this.text) {
                this.text = key; this.pixels = this.draw(p);
                this.cr.pixels(this.ref, null, this.pixels);
            }
            if (want !== this.shown) {
                this.shown = want;
                this.cr.set(this.ref, { visible: want });
                this.note('cluster: ' + (want ? 'show ' + p.map((q) => q.v + (q.u ? ' ' + q.u : '')).join(' · ') : 'hide'));
            }
        } catch (e) { this.state.reason = 'draw: ' + e.message; }
    }

    setLook(look) { if (LOOKS.indexOf(look) >= 0 && look !== this.cfg.look) { this.cfg.look = look; this.save(); this.preview(); } }

    place() { try { const r = this.rect(); if (this.cr && this.ref) this.cr.set(this.ref, { x: r.x, y: r.y, w: r.w, h: r.h }); } catch (e) { /* next */ } this.save(); }
    move(dx, dy) { this.cfg.x = clamp(this.cfg.x + dx * STEP.x, LIMIT.x); this.cfg.y = clamp(this.cfg.y + dy * STEP.y, LIMIT.y); this.place(); this.preview(); }
    size(d) { this.cfg.scale = clamp(Math.round((this.cfg.scale + d * STEP.scale) * 10) / 10, LIMIT.scale); this.place(); this.preview(); }
    reset() { this.cfg = Object.assign({}, DEF, { on: this.cfg.on, look: this.cfg.look }); this.place(); this.preview(); }
    toggle() { this.cfg.on = !this.cfg.on; this.save(); this.note('cluster ETA ' + (this.cfg.on ? 'on' : 'off')); }
    preview() { this.previewUntil = Date.now() + PREVIEW_MS; }

    status() {
        const s = this.state;
        if (!this.cr) return s.client;
        if (!this.ready) return 'Cluster renderer: ' + s.client;
        return (this.shown ? 'On the cluster' : 'Hidden') + (s.layer ? ' - layer ' + s.layer : '') + (s.target ? ', panel ' + s.target : '') + (s.reason ? ' - ' + s.reason : '');
    }
}

module.exports = { Strip, DEF, IW, IH, LOOKS, parts };
