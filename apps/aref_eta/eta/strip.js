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
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');

const LOOK = require('./look');
const ISL = require('./island');
const SLOT = require('./slot');
const IW = LOOK.IW, IH = LOOK.IH;         // the image; the rect on the cluster scales it (bilinear)
const PREVIEW_MS = 30000;
const MAP_WAIT_MS = 3000;            // longest the ETA waits for the cluster's map to come up
const DEF = { on: true, x: 968, y: 668, scale: 1 };   // x, y: the picture's centre on the cluster (px), where BMW's street name sits (measured on a G-series cluster photo); scale of IW x IH
// the island, on Waze on cluster's map target (1088 x 480, under the bezel's camera notch on a G22): its centre x and
// top y there. On the panel it covered BMW's own cluster widgets (music, trip computer: one cluster slot), and the
// panel's top ~110 px sit under the notch (Aref's photos, Nov 12: visible from panel y 144 = map y ~24)
const DEF_ISLAND = { x: 544, y: 24, scale: 1 };
const LIMIT_ISLAND = { x: [120, 968], y: [0, 380], scale: [0.5, 2] };
const LIMIT = { x: [200, 1720], y: [0, 700], scale: [0.5, 2] };
// the island's schedule (Settings "island_every"): how long it stays open each time it pops out
const HOLD_MS = 6000;
const STEP = { x: 20, y: 6, scale: 0.1 };
const STEP_ISLAND = { x: 30, y: 10 };      // on the map's picture

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
        this.map = { state: null, at: 0 }; this.pending = null;
        this.cfg.islandMap = Object.assign({}, DEF_ISLAND, this.cfg.islandMap);
        delete this.cfg.island;               // 1.3.0-1.3.2: panel coordinates
        this.island = null; this.isl = { active: false, lastPop: 0, arrival: null, img: null };
        this.style = Object.assign({}, LOOK.DEFAULT_STYLE); this.styleKey = undefined; this.image = null;
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
            this.layerStates = {};
            cr.on('layer', (ref, state, reason) => {
                const name = ref === this.ref ? 'strip' : (this.island && this.island.names()[ref]) || 'layer ' + ref;
                if (this.layerStates[name] !== state) this.note('cluster: ' + name + ' ' + state + (reason ? ' (' + reason + ')' : ''));
                this.layerStates[name] = state;
                if (ref === this.ref) { this.state.layer = state; this.state.reason = reason || ''; }
            });
            cr.on('target', (name, state, holder, reason) => {
                if (name === 'map') {        // Waze on cluster's map (CarPlay's map on the cluster): the ETA comes and goes with it
                    if (state !== this.map.state) this.note('cluster: map ' + state + (holder ? ' by ' + holder : ''));
                    this.map = { state: state, at: Date.now() };
                    if (state === 'shown' && this.pending) this.update(this.pending.route, this.pending.arrival);
                    return;
                }
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
            this.island = new ISL.Island(cr, this.note);
            this.island.create(this.cfg.islandMap, IW, IH, 'map', this.style.look);
            this.slot = new SLOT.Slot(cr, this.fonts, this.note, this.cfg.slot);
            this.slot.create();
            cr.connect();
        } catch (e) {
            this.state.client = 'failed: ' + e.message;
            this.note('cluster: start failed: ' + (e && e.stack || e));
        }
    }

    /** The look (look.js style: Settings). Redrawn at the next update; a change shows the preview. */
    setStyle(style) {
        const k = JSON.stringify(style);
        if (k === this.styleKey) return;
        const first = this.styleKey === undefined;
        this.style = style; this.styleKey = k;
        this.note('style ' + k);
        if (this.island) this.island.setLook(style.look);
        if (!first) this.preview();
    }

    /** Called on every route update and each second: route (route.js pick(), null: nothing to show), arrival text. */
    update(route, arrival, road) {
        if (this.style.preset === 'island') return this.updateIsland(route, arrival, road);
        if (this.isl.active || (this.island && this.island.open)) { this.isl.active = false; if (this.island) this.island.hide(); this.text = null; }
        if (this.streetText) { this.streetText = null; this.text = null; }
        const preview = Date.now() < this.previewUntil;
        const p = route ? LOOK.parts(route, arrival, this.style) : preview ? LOOK.parts(LOOK.SAMPLE_ROUTE, '6:42 PM', this.style) : null;
        const want = !!(this.cfg.on && p && (route || preview)) && this.onSchedule(!!(route || preview), arrival);
        const key = p ? JSON.stringify(p) + this.styleKey : null;
        try {
            if (key && key !== this.text) {
                this.text = key;
                this.image = LOOK.render(p, this.style, this.fonts);      // also the app screen's preview
                this.pixels = this.image.data;
                if (this.cr && this.ref) this.cr.pixels(this.ref, null, this.pixels);
            }
            if (!this.cr || !this.ref) return;
            // in step with the cluster's map: while it's coming up (acquiring, up to MAP_WAIT_MS), the ETA waits and
            // then fades in with it; the panel's own 250 ms fade plus a short rise make the entrance
            const mapComing = this.map.state === 'acquiring' && Date.now() - this.map.at < MAP_WAIT_MS;
            this.pending = want && !this.shown && mapComing ? { route: route, arrival: arrival } : null;
            if (this.pending) { setTimeout(() => { if (this.pending) this.update(this.pending.route, this.pending.arrival); }, MAP_WAIT_MS + 50); return; }
            if (want !== this.shown) {
                this.shown = want;
                this.cr.set(this.ref, { visible: want });
                if (want && this.cr.animate) {
                    try {
                        if (this.rise && this.cr.stop) this.cr.stop(this.ref, this.rise);      // one at a time (a layer plays at most 16)
                        this.rise = this.cr.animate(this.ref, { property: 'translate', keys: '0:0,14,0 320:0,0,0' });
                    } catch (e) { /* an older renderer: no rise */ }
                }
                this.note('cluster: ' + (want ? 'show ' + p.map((q) => q.v + (q.u ? ' ' + q.u : '')).join(' · ') : 'hide'));
            }
        } catch (e) { this.state.reason = 'draw: ' + e.message; }
    }

    /** The island preset: pops out of the camera on the schedule, shrinks back in between (island.js). */
    updateIsland(route, arrival, road) {
        const now = Date.now(), preview = now < this.previewUntil;
        const p = route ? LOOK.parts(route, arrival, this.style) : preview ? LOOK.parts(LOOK.SAMPLE_ROUTE, '6:42 PM', this.style) : null;
        // the island lives on the cluster map's picture: it shows while Waze on cluster has the map up
        const mapUp = this.map.state === 'shown';
        if (this.cfg.on && p && (route || preview) && !mapUp && !this.mapNoted) { this.mapNoted = true; this.note('island: waiting for the cluster map (Waze on cluster), map ' + (this.map.state || 'unknown')); }
        if (mapUp) this.mapNoted = false;
        const want = !!(this.cfg.on && p && (route || preview) && mapUp);
        try {
            // the bottom strip: the street name BMW blanks during a CarPlay route (Settings: Street name)
            const st = this.style.street !== false && route && road ? road : null;
            if (st !== this.streetText && this.cr && this.ref) {
                this.streetText = st;
                if (st) { this.pixels = LOOK.street(st, this.fonts).data; this.cr.pixels(this.ref, null, this.pixels); this.text = null; }
            }
            const wantStreet = !!(this.cfg.on && st);
            if (wantStreet !== this.shown && this.cr && this.ref) {
                this.shown = wantStreet; this.cr.set(this.ref, { visible: wantStreet });
                this.note('cluster: street name ' + (wantStreet ? '"' + st + '"' : 'off'));
            }
            const key = p ? 'i' + JSON.stringify(p) + this.styleKey : null;
            if (key === this.text && this.pixels && this.streetText) this.text = null;   // (the street name took the bottom layer)
            if (key && key !== this.text) {
                this.text = key;
                const img = LOOK.render(p, Object.assign({}, this.style, { look: this.style.look === 'plain' ? 'plain' : 'bare' }), this.fonts);
                this.image = ISL.preview(img, IW, IH, this.style.look);                   // the app screen's preview
                if (this.island) this.island.setContent(img);
            }
            const isl = this.isl, I = this.island;
            if (!I) return;
            if (!want) {
                if (isl.active) { isl.active = false; I.close(); this.note('island: close'); }
                return;
            }
            const every = this.style.every || 'stay';
            if (!isl.active) {                                            // a route (or the preview) begins: pop out
                isl.active = true; isl.lastPop = now; isl.arrival = arrival; I.pop();
                this.note('island: pop ' + p.map((q) => q.v + (q.u ? ' ' + q.u : '')).join(' · ') + ' (' + every + ')');
                return;
            }
            if (every === 'stay') { if (!I.open) { I.pop(); isl.lastPop = now; } return; }
            const sec = Number(every), hold = every === 'change' ? HOLD_MS + 2000 : Math.min(HOLD_MS, Math.max(3000, sec * 500));
            if (I.open) { if (now - isl.lastPop >= hold) I.close(); return; }
            const due = every === 'change' ? arrival !== isl.arrival : now - isl.lastPop >= sec * 1000;
            if (due) { isl.lastPop = now; isl.arrival = arrival; I.pop(); }
        } catch (e) { this.state.reason = 'island: ' + e.message; }
    }

    /** The sample route in the current look, for the app's screen. */
    sampleImage() {
        const p = LOOK.parts(LOOK.SAMPLE_ROUTE, '6:42 PM', this.style);
        if (this.style.preset !== 'island') return LOOK.render(p, this.style, this.fonts);
        return ISL.preview(LOOK.render(p, Object.assign({}, this.style, { look: this.style.look === 'plain' ? 'plain' : 'bare' }), this.fonts), IW, IH, this.style.look);
    }

    /** On the cluster now (either preset). */
    showing() { return !!(this.shown || (this.island && this.island.open) || this.isl.active); }

    /** Where the current preset sits: the bottom strip's place (cfg) or the island's (cfg.island). */
    spot() {
        if (this.moving === 'slot') return (this.cfg.slot = Object.assign({}, SLOT.DEF, this.cfg.slot));
        return this.style.preset === 'island' ? this.cfg.islandMap : this.cfg;
    }

    place() {
        try {
            const r = this.rect();
            if (this.cr && this.ref) this.cr.set(this.ref, { x: r.x, y: r.y, w: r.w, h: r.h });
            if (this.island) this.island.move(this.cfg.islandMap);
            if (this.slot) this.slot.move(this.cfg.slot);
        } catch (e) { /* next */ }
        this.save();
    }
    move(dx, dy) {
        const isl = this.style.preset === 'island' && this.moving !== 'slot', o = this.spot(), st = isl ? STEP_ISLAND : this.moving === 'slot' ? STEP_ISLAND : STEP, lim = isl ? LIMIT_ISLAND : LIMIT;
        o.x = clamp(o.x + dx * st.x, lim.x); o.y = clamp(o.y + dy * st.y, lim.y);
        this.note('placed ' + (this.moving === 'slot' ? 'second slot' : this.style.preset === 'island' ? 'island' : 'strip') + ' at x ' + o.x + ', y ' + o.y + ', ' + Math.round(o.scale * 100) + '%');
        this.place(); this.preview();
    }
    size(d) { const o = this.spot(); o.scale = clamp(Math.round((o.scale + d * STEP.scale) * 10) / 10, LIMIT.scale); this.place(); this.preview(); }
    reset() {
        if (this.moving === 'slot') this.cfg.slot = Object.assign({}, SLOT.DEF);
        else if (this.style.preset === 'island') this.cfg.islandMap = Object.assign({}, DEF_ISLAND);
        else this.cfg = Object.assign({}, DEF, { on: this.cfg.on, islandMap: this.cfg.islandMap });
        this.place(); this.preview();
    }
    toggle() { this.cfg.on = !this.cfg.on; this.save(); this.note('cluster ETA ' + (this.cfg.on ? 'on' : 'off')); }
    preview() {
        this.previewUntil = Date.now() + PREVIEW_MS;
        this.btm = null;                          // the bottom strip's schedule starts over: it shows now
        if (this.style.preset === 'island' && this.island && !this.island.open) { this.island.pop(); this.isl.active = true; this.isl.lastPop = Date.now(); }
    }

    /**
     * The bottom strip on Settings' schedule (as the island): always, or shown for up to HOLD_MS every 10 s .. 5 min,
     * or when the arrival time changes. Between showings the panel is released, so BMW's own cluster widgets (music,
     * trip computer: the same cluster slot) come back.
     */
    onSchedule(active, arrival) {
        const every = this.style.every || 'stay', now = Date.now();
        if (!active) { this.btm = null; return false; }
        if (every === 'stay') return true;
        const sec = Number(every), hold = every === 'change' ? HOLD_MS + 2000 : Math.min(HOLD_MS, Math.max(3000, sec * 500));
        const b = this.btm;
        if (!b) { this.btm = { last: now, arrival: arrival }; return true; }
        if (now - b.last < hold) return true;
        if (every === 'change' ? arrival !== b.arrival : now - b.last >= sec * 1000) { b.last = now; b.arrival = arrival; return true; }
        return false;
    }

    status() {
        const s = this.state;
        if (!this.cr) return s.client;
        if (!this.ready) return 'Cluster renderer: ' + s.client;
        const on = this.shown || (this.island && this.island.open) || this.isl.active;
        return (on ? 'On the cluster' : 'Hidden') + (s.layer ? ' - layer ' + s.layer : '') + (s.target ? ', panel ' + s.target : '') + (s.reason ? ' - ' + s.reason : '');
    }
}

module.exports = { Strip, DEF, IW, IH };
