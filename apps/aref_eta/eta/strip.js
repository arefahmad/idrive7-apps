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
 * only when the text changes (about once a minute), so it costs the cluster link nearly nothing.
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

const IW = 720, IH = 80;                  // the image; the rect on the cluster scales it (bilinear)
const PREVIEW_MS = 30000;
const DEF = { on: true, x: 960, y: 682, scale: 1 };   // x, y: the text's centre on the cluster (px); scale of IW x IH
const LIMIT = { x: [200, 1720], y: [40, 700], scale: [0.5, 2] };
const STEP = { x: 20, y: 6, scale: 0.1 };

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

    /** The picture: the text in white with a soft dark edge, centred, on a transparent background. */
    draw(text) {
        const cv = new Canvas(IW, IH);
        cv.clear([0, 0, 0, 0]);
        const L = { font: 'bold', literal: true, align: 'center' };
        const size = 40, y = IH / 2 + size * 0.36;
        [[-2, 0], [2, 0], [0, -2], [0, 2]].forEach((d) => cv.text(text, IW / 2 + d[0], y + d[1], size, [0, 0, 0, 150], L));
        cv.text(text, IW / 2, y, size, [255, 255, 255, 255], L);
        return Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    }

    /** Called every tick: text (null: nothing to show). */
    update(text) {
        if (!this.cr || !this.ref) return;
        const preview = Date.now() < this.previewUntil;
        const t = preview && !text ? '6:42 PM  ·  23 min  ·  14.2 mi' : text;
        const want = !!(this.cfg.on && t && (text || preview));
        try {
            if (t && t !== this.text) {
                this.text = t; this.pixels = this.draw(t);
                this.cr.pixels(this.ref, null, this.pixels);
            }
            if (want !== this.shown) {
                this.shown = want;
                this.cr.set(this.ref, { visible: want });
                this.note('cluster: ' + (want ? 'show "' + t + '"' : 'hide'));
            }
        } catch (e) { this.state.reason = 'draw: ' + e.message; }
    }

    place() { try { const r = this.rect(); if (this.cr && this.ref) this.cr.set(this.ref, { x: r.x, y: r.y, w: r.w, h: r.h }); } catch (e) { /* next */ } this.save(); }
    move(dx, dy) { this.cfg.x = clamp(this.cfg.x + dx * STEP.x, LIMIT.x); this.cfg.y = clamp(this.cfg.y + dy * STEP.y, LIMIT.y); this.place(); this.preview(); }
    size(d) { this.cfg.scale = clamp(Math.round((this.cfg.scale + d * STEP.scale) * 10) / 10, LIMIT.scale); this.place(); this.preview(); }
    reset() { this.cfg = Object.assign({}, DEF, { on: this.cfg.on }); this.place(); this.preview(); }
    toggle() { this.cfg.on = !this.cfg.on; this.save(); this.note('cluster ETA ' + (this.cfg.on ? 'on' : 'off')); }
    preview() { this.previewUntil = Date.now() + PREVIEW_MS; }

    status() {
        const s = this.state;
        if (!this.cr) return s.client;
        if (!this.ready) return 'Cluster renderer: ' + s.client;
        return (this.shown ? 'On the cluster' : 'Hidden') + (s.layer ? ' - layer ' + s.layer : '') + (s.target ? ', panel ' + s.target : '') + (s.reason ? ' - ' + s.reason : '');
    }
}

module.exports = { Strip, DEF, IW, IH };
