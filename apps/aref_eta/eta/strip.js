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
// BMW's pop-up slots (cluster-render's README / conf, robertnisipeanu/idrive-apps): the cluster's 0x201 / 0x202 and the
// HUD's 0x321 (calls, status pop-ups such as heated steering: content 0x1000600) and 0x322 (media and list pop-ups,
// 0x1000251; pushed to the cluster as 0x1000351 in 0x202). Route guidance in them never counts: the service's own list.
const POPUP_SLOTS = ['201', '202', '321', '322'];
const GUIDANCE = ['1000200', '1000201', '1000210', '1000211', '1000300', '1000301', '1000310', '1000311', '1000312', '1000313', '1000314', '1000360'];
// Another app's cluster (a theme): ETA Bar comes back only after a status read shows it gone, and CLEAR_MS later.
// A drive mode change is the earliest warning: in a mode where another app drew before, ETA Bar steps aside at once;
// in a mode it hasn't seen yet (once any app has drawn), it waits MODE_GRACE_MS for the renderer to tell.
const CLEAR_MS = 1500, MODE_GRACE_MS = 2500, FAST_MS = 4000, FAST_POLL_MS = 250, STATUS_STALE_MS = 10000;
const POPUP_POLL_MS = 700, POPUP_HOLD_MS = 1300, POPUP_MAX_MS = 60000;   // a safety net: something up longer isn't a pop-up
const DESIGN = require('./design');
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

/** The picture at a quarter of its size, softened: the renderer stretches it back up (bilinear), so it reads as a blur. */
function softQuarter(src, w, h) {
    const qw = w / 4, qh = h / 4, q = Buffer.alloc(qw * qh * 4);
    for (let y = 0; y < qh; y++) for (let x = 0; x < qw; x++) for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += src[((y * 4 + dy) * w + x * 4 + dx) * 4 + c];
        q[(y * qw + x) * 4 + c] = sum >> 4;
    }
    return blurRGBA(q, qw, qh, 2);
}
/** A soft copy of an RGBA picture (w x h): box blur of radius r, twice each way. */
function blurRGBA(src, w, h, r) {
    let a = Float32Array.from(src), b = new Float32Array(a.length);
    const pass = (from, to, horiz) => {
        const n = horiz ? w : h, m = horiz ? h : w;
        for (let j = 0; j < m; j++) {
            for (let c = 0; c < 4; c++) {
                let sum = 0;
                const at = (i) => (horiz ? (j * w + i) : (i * w + j)) * 4 + c;
                for (let i = -r; i <= r; i++) sum += from[at(Math.max(0, Math.min(n - 1, i)))];
                for (let i = 0; i < n; i++) {
                    to[at(i)] = sum / (2 * r + 1);
                    sum += from[at(Math.min(n - 1, i + r + 1))] - from[at(Math.max(0, i - r))];
                }
            }
        }
    };
    for (let k = 0; k < 2; k++) { pass(a, b, true); pass(b, a, false); }
    const out = Buffer.alloc(src.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i]);
    return out;
}

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
            // Settings > Font: Apple (Inter) or BMW (Barlow Semi Condensed, OFL: close to the cluster's own type)
            // Barlow is loaded only when picked (two atlases less in memory for most drives)
            this.families = { apple: { bold: this.fonts.bold, med: this.fonts.med }, bmw: null };
            this.fontSrc = src;
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
            // BMW's own pop-ups (heated steering, seat heating, volume...): not Check Control messages, so only the
            // renderer's slot table shows them. While one is up, the ETA and the second slot step aside.
            cr.on('status', (text) => { try { this._onStatus(String(text || '')); } catch (e) { /* next */ } });
            // every 700 ms while anything could show; every 250 ms for 4 s after a drive mode change (a theme coming)
            let tick = 0;
            this.popTimer = setInterval(() => {
                const now = Date.now(), fast = now < (this.fastUntil || 0);
                if (!fast && (++tick % Math.round(POPUP_POLL_MS / FAST_POLL_MS)) !== 0) return;
                if (this.cr && this.cr.status && (fast || this.shown || (this.slot && this.slot.shown) || (this.design && this.design.shown) || this.pendingRoute || now < (this.hideUntil || 0) || this.foreign())) { try { this.cr.status(); } catch (e) { /* next */ } }
            }, FAST_POLL_MS);
            cr.on('refused', (op, ref, reason) => { this.note('cluster: refused ' + op + ': ' + reason); this.state.reason = 'refused: ' + reason; });
            cr.on('error', (e) => { this.state.client = 'error: ' + (e && e.message || e); });
            const r = this.rect();
            this.ref = cr.image({ target: 'panel', klass: 'content', z: 20, x: r.x, y: r.y, w: r.w, h: r.h, iw: IW, ih: IH,
                sampling: 'bilinear', fps: 2, visible: false });
            // a blurred copy under it: the strip arrives and leaves blurred, squeezing and widening (springIn / springOut)
            this.blurRef = cr.image({ target: 'panel', klass: 'content', z: 19, x: r.x, y: r.y, w: r.w, h: r.h, iw: IW / 4, ih: IH / 4,
                sampling: 'bilinear', fps: 2, visible: false });
            this.island = new ISL.Island(cr, this.note);
            this.island.create(this.cfg.islandMap, IW, IH, 'map', this.style.look);
            this.slot = new SLOT.Slot(cr, this.fonts, this.note, this.cfg.slot3, this.cfg.bgFit);
            this.slot.create();
            this.design = new DESIGN.Design(cr, this.ctx.dataDir, this.note);     // Cluster Studio's whole-cluster picture, under all of it
            this.design.create();
            cr.connect();
        } catch (e) {
            this.state.client = 'failed: ' + e.message;
            this.note('cluster: start failed: ' + (e && e.stack || e));
        }
    }

    /** Nothing on the cluster and nothing coming: the 1 s route check can skip. */
    idle() { return !this.shown && !this.pending && !(this.isl && this.isl.active) && Date.now() >= (this.previewUntil || 0); }

    /** The status text's slot rows: a pop-up slot with content shown (map 1) hides the ETA a little longer. */
    /**
     * Another app drawing on the cluster (a cluster theme, say, in whatever drive mode it shows): its layers on the
     * panel appear in the renderer's status. While one is shown, ETA Bar keeps all of its own off the cluster.
     */
    yielding() { return !(this.ctx && this.ctx.settings && this.ctx.settings.get('yield_to_apps') === false); }
    foreign() {
        if (!this.yielding()) return false;
        const now = Date.now();
        if (now < (this.modeHoldUntil || 0)) return true;
        if (!this.foreignOn) return false;
        if (now - (this.foreignReadAt || 0) > STATUS_STALE_MS) return false;     // no status reads: don't stay hidden forever
        return !this.foreignOffAt || now < this.foreignOffAt + CLEAR_MS;
    }
    _changed() { if (this.onYield) { try { this.onYield(); } catch (e) { /* next tick */ } } }
    /**
     * The drive mode changed (car data): another app's cluster may be coming or going. cfg.themeModes remembers, per
     * mode, whether another app drew on the panel there (learned from the renderer's status, never set by hand).
     */
    modeChanged(mode) {
        const was = this.mode;
        this.mode = mode; this.modeAt = Date.now();
        if (was === undefined || !this.yielding()) return;
        this.fastUntil = Date.now() + FAST_MS;
        const tm = this.cfg.themeModes || {}, known = Object.keys(tm).some((k) => tm[k]);
        if (!known) return;                                          // no other app has ever drawn here: nothing to wait for
        const hold = tm[mode] === true ? MODE_GRACE_MS + 1500 : tm[mode] === false ? 0 : MODE_GRACE_MS;
        if (hold) {
            this.modeHoldUntil = Date.now() + hold;
            this.note('drive mode ' + (was || '?') + ' -> ' + (mode || '?') + ': ' + (tm[mode] ? 'another app draws here, ETA Bar steps aside now' : 'waiting ' + (hold / 1000) + ' s for the cluster'));
            this._changed();
        } else this.note('drive mode ' + (was || '?') + ' -> ' + (mode || '?') + ': no other app here');
    }
    _learn(mode, drawn) {
        if (!mode) return;
        const tm = this.cfg.themeModes = this.cfg.themeModes || {};
        if (tm[mode] === drawn) return;
        tm[mode] = drawn; this.save();
        this.note('learned: ' + (drawn ? 'another app draws on the cluster in ' : 'no other app draws in ') + mode);
    }
    /**
     * Another app drawing on the cluster (a cluster theme, say, in whatever drive mode it shows): its layers on the
     * panel appear in the renderer's status, in any state but hidden (a theme builds a dozen layers while it comes up).
     * While one is there, ETA Bar keeps all of its own off the cluster.
     */
    _foreignFrom(text) {
        if (!this.yielding()) return;
        const apps = {}, now = Date.now();
        this.foreignReadAt = now;
        text.split('\n').forEach((line) => {
            const m = /^layer \d+ \w+ of (\S+) on (\w+), \w+ z -?\d+: (\w+)/.exec(line);
            if (m && m[2] === 'panel' && m[1] !== 'aref_eta' && m[3] !== 'hidden') apps[m[1].replace(/_\d+$/, '')] = true;
        });
        const names = Object.keys(apps).sort().join(', ');
        const settled = this.modeAt && now - this.modeAt > MODE_GRACE_MS + 500;
        const before = this.foreign();
        if (names) {
            this.foreignOn = true; this.foreignOffAt = 0;
            this.modeHoldUntil = 0;                                  // the renderer says so now: no need for the guess
            this._learn(this.mode, true);
        } else if (this.foreignOn) {
            if (!this.foreignOffAt) this.foreignOffAt = now;
            else if (now >= this.foreignOffAt + CLEAR_MS) { this.foreignOn = false; this.foreignOffAt = 0; }
        }
        if (!names && settled && !this.foreignOn) this._learn(this.mode, false);
        if (names && names !== (this.foreignNames || '')) this.note('another app on the cluster (' + names + '): ETA Bar steps aside');
        if (!this.foreignOn && this.foreignNames) { this.note('no other app on the cluster: ETA Bar comes back'); this.foreignNames = ''; this._changed(); return; }
        if (names || !this.foreignOn) this.foreignNames = names;
        if (this.foreign() !== before) this._changed();
    }

    _onStatus(text) {
        this._foreignFrom(text);
        const now = Date.now(), seen = {};
        if (!this.popSince || now - (this.lastStatus || 0) > 3000) this.popSince = {};   // polls paused: start fresh
        this.lastStatus = now;
        let pop = null;
        const sig = [];
        text.split('\n').forEach((line) => {
            const m = /slot 0x([0-9a-f]+) status \d+: (.*)/i.exec(line);
            if (!m) return;
            const slot = m[1].toLowerCase(), re = /0x([0-9a-f]+) class (\d+) map (\d)/gi;
            let r;
            while ((r = re.exec(m[2]))) {
                if (r[1] === '0' || r[3] !== '1') continue;
                if (!/^10004f[018]$/.test(r[1]) && slot !== '250') sig.push(slot + ':' + r[1]);
                if (POPUP_SLOTS.indexOf(slot) < 0 || GUIDANCE.indexOf(r[1].replace(/^0+/, '')) >= 0) continue;
                const k = slot + ':' + r[1];
                seen[k] = true;
                if (!this.popSince[k]) this.popSince[k] = now;
                // a pop-up is short; a slot busy longer (the HUD's turn arrows through a whole route) isn't one
                if (now - this.popSince[k] < POPUP_MAX_MS) pop = pop || ('0x' + slot + ' 0x' + r[1]);
            }
        });
        Object.keys(this.popSince).forEach((k) => { if (!seen[k]) delete this.popSince[k]; });
        // every change of what BMW shows in its own slots, for finding a pop-up that isn't caught
        const s2 = sig.sort().join(' ');
        if (s2 !== this.slotSig) { this.slotSig = s2; this.note('slots: ' + (s2 || 'none of BMW\'s')); }
        if (pop) {
            if (!(now < (this.hideUntil || 0))) this.note('BMW pop-up in slot ' + pop + ': the ETA steps aside');
            this.hideFor(POPUP_HOLD_MS);
        }
    }

    hideFor(ms) { this.hideUntil = Math.max(this.hideUntil || 0, Date.now() + ms); }   // the longer of two hides wins
    /** Apple or BMW type, for the ETA and the second slot (the same fonts object, changed in place). */
    setFont(name) {
        if (name === 'bmw' && this.families && !this.families.bmw && this.fontSrc) {
            const b = { bold: this.families.apple.bold, med: this.families.apple.med };
            try {
                if (fonts.register('eta_bw_bold', this.fontSrc.json('bw_bold.json'))) b.bold = 'eta_bw_bold';
                if (fonts.register('eta_bw_med', this.fontSrc.json('bw_med.json'))) b.med = 'eta_bw_med';
            } catch (e) { this.note('fonts: ' + e.message); }
            this.families.bmw = b;
        }
        const f = this.families && this.families[name];
        if (!f || this.fonts.bold === f.bold) return;
        this.fonts.bold = f.bold; this.fonts.med = f.med;
        this.text = null; if (this.slot) this.slot.key = null;
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
        // not over BMW's own strip: while the cluster map is off (BMW shows the odometer there at start) and for a few
        // seconds after a BMW Check Control message (hideFor)
        const mapOff = !preview && this.map.state && this.map.state !== 'shown';
        const want = !!(this.cfg.on && p && (route || preview)) && !mapOff && Date.now() >= (this.hideUntil || 0) && !this.foreign() &&
            this.onSchedule(!!(route || preview), arrival);
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
                if (want) this.springIn(); else this.springOut();
                this.note('cluster: ' + (want ? 'show ' + p.map((q) => q.v + (q.u ? ' ' + q.u : '')).join(' · ') : 'hide'));
            }
        } catch (e) { this.state.reason = 'draw: ' + e.message; }
    }

    /**
     * The bottom strip comes and goes as one piece, text and background together, like Dynamic Island: in, it grows
     * from 55 % with a little overshoot and rises; out, it pulls in slightly, then shrinks and drops away. The
     * renderer plays the keys itself; opacity steps ride along (an image layer's opacity is set, not animated).
     */
    _springStop() {
        (this.springTimers || []).forEach(clearTimeout); this.springTimers = [];
        (this.springAnims || []).forEach((x) => { try { this.cr.stop(x[0], x[1]); } catch (e) { /* */ } }); this.springAnims = [];
        if (this.rise && this.cr.stop) { try { this.cr.stop(this.ref, this.rise); } catch (e) { /* */ } this.rise = null; }
    }
    _springAt(ms, fn) { this.springTimers.push(setTimeout(() => { try { fn(); } catch (e) { this.state.reason = 'spring: ' + e.message; } }, ms)); }
    /** The same scale keys on the sharp and the blurred layer, so they move as one. */
    _springAnim(property, ks) {
        [this.ref, this.blurRef].forEach((ref) => { if (ref && this.cr.animate) this.springAnims.push([ref, this.cr.animate(ref, { property: property, keys: ks })]); });
    }
    _blurNow() { if (this.blurRef && this.pixels && this.blurOf !== this.pixels) { this.blurOf = this.pixels; this.cr.pixels(this.blurRef, null, softQuarter(this.pixels, IW, IH)); } }
    _op(ms, sharp, blur) {
        this._springAt(ms, () => {
            if (sharp !== null) this.cr.set(this.ref, { opacity: sharp });
            if (blur !== null && this.blurRef) this.cr.set(this.blurRef, { opacity: blur });
        });
    }
    springIn() {
        this._springStop();
        const E = ISL.ease, K = ISL.keys;
        try {
            this._blurNow();
            this.cr.set(this.ref, { opacity: 0, visible: true });
            if (this.blurRef) this.cr.set(this.blurRef, { opacity: 0, visible: true });
            // blurred and squeezed to 30 % wide, it widens past full with a spring and settles; then it sharpens
            this._springAnim('scale', K(0, 560, 18, (t) => { const k = E.outBack(t); return [0.3 + 0.7 * k, 0.8 + 0.2 * k, 1]; }));
            [[0, null, 0.5], [50, null, 1], [260, 0.35, null], [320, 0.75, null], [380, 1, 0.5], [440, null, 0]].forEach((x) => this._op(x[0], x[1], x[2]));
        } catch (e) { this.cr.set(this.ref, { visible: true, opacity: 1 }); }
    }
    springOut() {
        this._springStop();
        const E = ISL.ease, K = ISL.keys;
        try {
            this._blurNow();
            if (this.blurRef) this.cr.set(this.blurRef, { opacity: 0, visible: true });
            // the reverse: it blurs, widens a touch, squeezes to 30 % and fades
            [[0, null, 1], [40, 0.6, null], [90, 0.2, null], [130, 0, null], [300, null, 0.6], [360, null, 0.25], [410, null, 0]].forEach((x) => this._op(x[0], x[1], x[2]));
            this._springAnim('scale', '0:1,1,1 90:1.04,1.02,1 ' + K(90, 420, 12, (t) => { const k = E.inCubic(t); return [1.04 - 0.74 * k, 1.02 - 0.22 * k, 1]; }).split(' ').slice(1).join(' '));
            this._springAt(450, () => {
                this.cr.set(this.ref, { visible: false }); if (this.blurRef) this.cr.set(this.blurRef, { visible: false });
                this._springStop(); this.cr.set(this.ref, { opacity: 1 });
            });
        } catch (e) { this.cr.set(this.ref, { visible: false }); if (this.blurRef) this.cr.set(this.blurRef, { visible: false }); }
    }

    /** The island preset: pops out of the camera on the schedule, shrinks back in between (island.js). */
    updateIsland(route, arrival, road) {
        const now = Date.now(), preview = now < this.previewUntil;
        const p = route ? LOOK.parts(route, arrival, this.style) : preview ? LOOK.parts(LOOK.SAMPLE_ROUTE, '6:42 PM', this.style) : null;
        // the island lives on the cluster map's picture: it shows while Waze on cluster has the map up
        const mapUp = this.map.state === 'shown';
        if (this.cfg.on && p && (route || preview) && !mapUp && !this.mapNoted) { this.mapNoted = true; this.note('island: waiting for the cluster map (Waze on cluster), map ' + (this.map.state || 'unknown')); }
        if (mapUp) this.mapNoted = false;
        const want = !!(this.cfg.on && p && (route || preview) && mapUp && !this.foreign());
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
        if (this.moving === 'slot') return (this.cfg.slot3 = Object.assign({}, SLOT.DEF, this.cfg.slot3));
        return this.style.preset === 'island' ? this.cfg.islandMap : this.cfg;
    }

    place() {
        try {
            const r = this.rect();
            if (this.cr && this.ref) this.cr.set(this.ref, { x: r.x, y: r.y, w: r.w, h: r.h });
            if (this.cr && this.blurRef) this.cr.set(this.blurRef, { x: r.x, y: r.y, w: r.w, h: r.h });
            if (this.island) this.island.move(this.cfg.islandMap);
            if (this.slot) this.slot.move(this.cfg.slot3, this.cfg.bgFit);
        } catch (e) { /* next */ }
        this.save();
    }
    move(dx, dy) {
        if (this.moving === 'backdrop') {             // the music backdrop on its own: offset and size, saved
            const f = this.cfg.bgFit = Object.assign({ x: 0, y: 0, scale: 1 }, this.cfg.bgFit);
            f.x = Math.max(-300, Math.min(300, f.x + dx * 10)); f.y = Math.max(-300, Math.min(300, f.y + dy * 10));
            this.note('placed backdrop at ' + f.x + ', ' + f.y + ', ' + Math.round(f.scale * 100) + '%');
            this.place(); return;
        }
        const isl = this.style.preset === 'island' && this.moving !== 'slot', o = this.spot(), st = isl ? STEP_ISLAND : this.moving === 'slot' ? STEP_ISLAND : STEP, lim = isl ? LIMIT_ISLAND : LIMIT;
        o.x = clamp(o.x + dx * st.x, lim.x); o.y = clamp(o.y + dy * st.y, lim.y);
        this.note('placed ' + (this.moving === 'slot' ? 'second slot' : this.style.preset === 'island' ? 'island' : 'strip') + ' at x ' + o.x + ', y ' + o.y + ', ' + Math.round(o.scale * 100) + '%');
        this.place(); this.preview();
    }
    size(d) {
        if (this.moving === 'backdrop') {
            const f = this.cfg.bgFit = Object.assign({ x: 0, y: 0, scale: 1 }, this.cfg.bgFit);
            f.scale = Math.max(0.5, Math.min(1.5, Math.round((f.scale + d * 0.05) * 100) / 100));
            this.note('backdrop size ' + Math.round(f.scale * 100) + '%'); this.place(); return;
        }
        const o = this.spot(); o.scale = clamp(Math.round((o.scale + d * STEP.scale) * 10) / 10, LIMIT.scale); this.place(); this.preview(); }
    reset() {
        if (this.moving === 'backdrop') this.cfg.bgFit = { x: 0, y: 0, scale: 1 };
        else if (this.moving === 'slot') this.cfg.slot3 = Object.assign({}, SLOT.DEF);
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
