'use strict';
/**
 * widget_anim.js - an animation (anim.js: a GIF made into frames) as an app's home-screen widget, at the
 * best frame rate the unit allows. For any app with an app.json "startWidget" (G's Dash, G's Music, ...).
 * Node 8, no npm modules.
 *
 *   const { AnimatedWidget } = require('./kit/widget_anim');
 *   const aw = new AnimatedWidget(ctx, {
 *       file: path.join(ctx.dataDir, 'widget_anim.bin'),   // where the animation is kept (anim.js Store)
 *       draw: (inst, playing) => canvas | null,             // the app's own picture while no animation plays
 *   });                                                     // (and its text cells, e.g. the small widget's title)
 *   aw.start();                                             // in place of ctx.widget.loop(...)
 *   aw.enable(on);                                          // the animation, or the app's own picture
 *   await aw.replace(await anim.prepare(gif, { w, h, fit }), { name });   // keep a new one and play it
 *   aw.remove(); aw.status(); aw.frame(Date.now());         // forget it; what plays and how; a preview frame
 *
 * Two ways to the widget, picked again whenever something changes:
 *   stream  Option A (docs/animated-widget.md): this build's widget uses the stream widget template that the
 *           Store's renderer has mgu-renderd-hmi mount into the HMI (kit/tools/build.py, startWidget.stream)
 *           and the renderer has the widget's stream surface (renderd.js widget mode). Every frame goes to
 *           the GPU once; a frame change is then one small draw message, and HmiMain3D composites the
 *           surface inside the widget itself: display rate, no vignette, it scrolls with the home screen,
 *           stays under popups, and a tap still opens the app. The template's own picture under the
 *           stream is set transparent meanwhile.
 *   hmi     everywhere else: every frame is written once as a PNG with a resource handle (Widget.assets);
 *           a frame change is a single setValue of that handle (Widget.showAsset), at most HMI_FPS a second
 *           with one call to the HMI in flight per widget, so a slow HMI drops frames instead of falling
 *           behind; the frame sent is always the one due at that moment, so the loop keeps its pace.
 * A layout with startWidget.imageSmall (G's Dash's BasicWidget) gets the picture on the small size too.
 * Otherwise only big widgets do: the Drive Recorder small size shows no pictures on this firmware. A
 * stream template replaces the layout, so the small cell is not used then. A widget the HMI says is
 * hidden gets one every few seconds, so none is left blank by a visibility event that went missing.
 */
/** Placed widgets that receive a picture. sw is app.json startWidget (with built.stream when the build used it). */
function pictureInstances(list, sw) {
    sw = sw || {};
    if (sw.imageSmall && !(sw.built && sw.built.stream)) return list || [];
    return (list || []).filter((i) => i.big);
}
const fs = require('fs');
const { RenderClient } = require('./renderd');
const record = require('./record');
const { Store, Clip } = require('./anim');
const { Canvas } = require('./canvas');

const IMG_BASE = 0x570000;          // record.setImage ids: IMG_BASE + frame (apps use small ids)
const HMI_FPS = 12;                 // the HMI path's frames a second at most
const HIDDEN_MS = 5000;             // a placed widget the HMI calls hidden: a frame at most this often
const DRAW_MS = 1000;               // the app's draw() for its text cells, per widget, while the animation plays
const IDLE_MS = 1000;               // the app's own picture: drawn this often (unchanged pixels are not sent again)
const GPU_RETRY_MS = 5 * 60 * 1000; // a renderer with no widget surface: asked again after this
const GPU_WAIT_MS = 10000;          // no renderer socket: looked for again after this
const GPU_CONNECT_MS = 2000;        // a widget connection just made: HMI pictures only if it is not up by then
const ASSET_RETRY_MS = 30000;       // the HMI refused the frames' resources: tried again after this
const CACHE_MS = 15000;             // decoded frames let go this long after the GPU and the preview stop using them
const FPS_WINDOW_MS = 3000;

/** The marker file (build.py stream_widget_offered's) still names template `layout` as the stream widget. */
function offered(stream, layout) {
    try {
        return JSON.parse(fs.readFileSync(process.env.MGU_HMI_TEMPLATES || (stream && stream.marker), 'utf8')).streamWidget === layout;
    } catch (e) { return false; }
}

class AnimatedWidget {
    constructor(ctx, opts) {
        this.w = ctx.widget; this.log = ctx.log; this.spec = ctx.spec || {};
        this.o = opts || {};
        const sw = this.spec.startWidget || {};
        this.built = sw.built || { layout: sw.layout || '', stream: false };
        // built with the stream template, and the renderer that mounts it has gone since: the HMI has no such
        // template any more, so the widget cannot draw until the app is installed again (build.py picks the stock one)
        this.templateGone = !!this.built.stream && !offered(sw.stream, this.built.layout);
        if (this.templateGone) this.log.warn('widget: built for the stream widget template ' + this.built.layout + ', which this unit no longer offers - install the app again');
        this.store = new Store(this.o.file);
        this.clip = null; this.meta = null; this.gen = 0;
        this.on = this.o.enabled !== false;
        this.assets = null; this.assetsGen = -1; this.assetsBusy = false; this.assetsFailAt = 0;
        this.gpu = null; this.gpuWhy = ''; this.gpuRetryAt = 0; this.gpuSince = 0;
        this.streamIdx = -1; this.streamAt = 0; this.streamFrames = 0; this.under = {};
        this.shown = {}; this.drawn = {};
        this.samples = []; this.fps = 0;
        this.path = 'off'; this.useAt = 0; this.rec = null; this.clear = null;
        this.timer = null; this.running = false; this.again = false; this.started = false;
        this._load();
        if (this.w && this.w.onChange) this.w.onChange(() => { this.shown = {}; this.drawn = {}; this.under = {}; this.kick(); });
    }

    /* ----- what the app calls ----- */
    start() { if (!this.started) { this.started = true; this.kick(); } return this; }
    has() { return !!this.clip; }
    /** Play the animation (true) or show the app's own picture (false). */
    enable(on) {
        on = !!on;
        if (on === this.on) return;
        this.on = on;
        this.log.info('widget animation ' + (on ? 'on' : 'off'));
        this.shown = {}; this.under = {};
        this.kick();
    }
    /** Keep prepared (anim.prepare's result) in place of the current animation and play it. */
    replace(prepared, extra) {
        const meta = this.store.save(prepared, extra);
        this._set(meta, prepared.frames);
        this.log.info('widget animation: ' + (meta.name || 'a GIF') + ', ' + prepared.frames.length + ' frames ' + meta.w + 'x' + meta.h +
            ' (' + meta.fit + '), ' + Math.round(prepared.duration) + ' ms loop, ' + Math.round(meta.sizes.reduce((a, n) => a + n, 0) / 1024) + ' KB');
        return meta;
    }
    remove() { this.store.remove(); this._set(null, null); this.log.info('widget animation removed'); }
    /** For a preview: the frame due at t { index, rgba, w, h }, or null. */
    frame(t) {
        if (!this.clip) return null;
        const i = this.clip.at(t);
        this.useAt = Date.now();
        return { index: i, rgba: this.clip.rgba(i), w: this.clip.w, h: this.clip.h, gen: this.gen };
    }
    /** ms until frame(t) changes (a preview's next draw). */
    wait(t) { return this.clip ? this.clip.wait(t) : 1000; }
    /**
     * { has, on, playing, path ('stream' | 'hmi' | 'off'), fps, frames, w, h, duration, name, fit,
     *   template ('stream' | 'stock'), note (a line for the app's page) }
     */
    status() {
        const c = this.clip, m = this.meta || {};
        return {
            has: !!c, on: this.on, playing: this.path !== 'off', path: this.path, fps: this.fps,
            frames: c ? c.count : 0, w: c ? c.w : 0, h: c ? c.h : 0, duration: c ? c.duration : 0, name: m.name || '', fit: m.fit || '',
            source: m.source || null, template: this.built.stream ? 'stream' : 'stock', templateGone: this.templateGone, note: this._note(),
        };
    }
    kick() {
        if (!this.started) return;
        if (this.running) { this.again = true; return; }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this._tick(), 0);
    }

    /* ----- inside ----- */
    _load() {
        let a = null;
        try { a = this.store.load(); } catch (e) {
            this.log.warn('widget animation: ' + e.message + ' - the file is removed');
            try { this.store.remove(); } catch (x) { /* read-only */ }
        }
        this._set(a ? a.meta : null, a ? a.frames : null);
        if (a) this.log.info('widget animation: ' + (a.meta.name || 'a GIF') + ', ' + a.frames.length + ' frames ' + a.meta.w + 'x' + a.meta.h);
    }
    _set(meta, frames) {
        this._stopGpu(); this._releaseAssets(); this._dropImages();
        if (this.clip) this.clip.drop();
        this.gen++;
        this.meta = meta;
        this.clip = frames && frames.length ? new Clip(frames, meta.w, meta.h) : null;
        this.shown = {}; this.under = {}; this.rec = null;
        this.kick();
    }
    _note() {
        if (this.templateGone) return 'the widget\'s stream template is gone: install the app again';
        if (!this.clip) return '';
        if (this.path === 'stream') return 'Drawn by the renderer inside the widget';
        const hmi = 'HMI pictures, up to ' + HMI_FPS + ' fps';
        if (!this.built.stream) return hmi + ' (stock widget template)';
        return hmi + (this.gpuWhy ? ' (' + this.gpuWhy + ')' : '');
    }
    _setPath(p) {
        if (p === this.path) return;
        this.path = p;
        this.log.info('widget animation: ' + (p === 'off' ? 'stopped' : p === 'stream' ? 'drawn by the renderer in the widget (stream template)' : this._note()));
        this.samples = []; this.fps = 0;
    }
    async _tick() {
        this.timer = null;
        if (this.running) { this.again = true; return; }
        this.running = true;
        let next = IDLE_MS;
        try { next = await this._step(Date.now()); } catch (e) { this.log.error('widget animation', e); }
        this.running = false;
        if (this.again) { this.again = false; next = 0; }
        if (!this.timer) this.timer = setTimeout(() => this._tick(), Math.max(0, Math.min(IDLE_MS, next)));
    }
    async _draw(inst, playing) {
        try { return this.o.draw ? await this.o.draw(inst, playing) : null; } catch (e) { this.log.error('widget draw', e); return null; }
    }
    _step(now) {
        const list = this.w && this.w.ready ? this.w.instances() : [];
        this._trim(now);
        if (!list.length) { this._idle(); return IDLE_MS; }
        if (!(this.on && this.clip)) return this._own(list);
        // the app's own cells (the small widget's title ...) about once a second each
        const cells = list.filter((i) => !(now - (this.drawn[i.spawnId] || 0) < DRAW_MS));
        cells.forEach((i) => { this.drawn[i.spawnId] = now; });
        return Promise.all(cells.map((i) => this._draw(i, true))).then(() => {
            const pics = pictureInstances(list, this.spec.startWidget);
            this._rate(now);
            if (this.gpu && this.gpu.ready) {
                // the stream is up: the HMI's copies of the frames are not needed (made again if it goes)
                this._releaseAssets();
                this._setPath('stream');
                return this._stream(pics, now);
            }
            this._gpuEnsure(now);
            if (this.gpu && now - this.gpuSince < GPU_CONNECT_MS) return 100;     // connecting: wait for it a moment
            this._setPath('hmi');
            return this._hmi(pics, now);
        });
    }
    /**
     * No animation (or off): the app's own picture, as Widget.loop does. Coming from the animation, the picture
     * is in place before its frames (or the stream) are let go, so the widget never shows a released frame.
     */
    async _own(list) {
        const pushes = [];
        for (const i of list) {
            const cv = await this._draw(i, false);
            if (cv) pushes.push(this.w.image(i.spawnId, cv));
        }
        if (this.path !== 'off' || this.assets || this.gpu) await Promise.all(pushes).catch(() => {});
        this._idle();
        return IDLE_MS;
    }
    _idle() { this._stopGpu(); this._releaseAssets(); this._setPath('off'); }

    /* the stream (Option A) */
    _gpuEnsure(now) {
        if (this.gpu || !this.built.stream || now < this.gpuRetryAt) return;
        if (!RenderClient.available()) { this.gpuWhy = 'the renderer is not running'; this.gpuRetryAt = now + GPU_WAIT_MS; return; }
        const g = this.gpu = new RenderClient(this.spec.id, this.log, { native: true, mode: 'widget' });
        this.gpuSince = now;
        g.on('ready', () => {
            if (this.gpu !== g || !this.clip) return;
            g.place({ x: 0, y: 0, w: this.clip.w, h: this.clip.h, scale: 1, ox: 0, oy: 0 });
            this.gpuWhy = ''; this.streamIdx = -1; this.under = {};
            this.kick();
        });
        g.on('unsupported', () => {
            if (this.gpu !== g) return;
            this.gpuWhy = 'the renderer has no widget surface';
            this._stopGpu();
            this.gpuRetryAt = Date.now() + GPU_RETRY_MS;
            this.kick();
        });
        // gone (the renderer restarted): HMI pictures until it is back (the client connects again by itself)
        g.on('close', () => { if (this.gpu === g) { this.shown = {}; this.under = {}; this.gpuWhy = 'the renderer went away'; this.gpuSince = 0; this.kick(); } });
        g.connect();
    }
    _stopGpu() {
        if (this.gpu) { const g = this.gpu; this.gpu = null; try { g.show(false); g.close(); } catch (e) { /* closed */ } }
        this.streamIdx = -1; this.under = {};
    }
    _stream(pics, now) {
        const g = this.gpu, c = this.clip;
        // the template's own picture under the stream: transparent, or it would show through the GIF's clear parts
        if (!this.clear || this.clear.w !== c.w || this.clear.h !== c.h) this.clear = new Canvas(c.w, c.h);
        pics.forEach((i) => { if (this.under[i.spawnId] !== this.gen) { this.under[i.spawnId] = this.gen; this.w.image(i.spawnId, this.clear); } });
        const shown = pics.some((i) => i.visible);
        g.show(shown);
        if (!shown) return IDLE_MS;
        const idx = c.at(now);
        if ((idx !== this.streamIdx || now - this.streamAt >= 1000) && g.placement) {
            this.useAt = now;
            const id = IMG_BASE + idx;
            if (!record.imageById.has(id)) record.setImage(id, c.w, c.h, c.rgba(idx));
            const r = this.rec && this.rec.w === c.w && this.rec.h === c.h ? this.rec : (this.rec = new record.Recorder(c.w, c.h));
            r.reset().clear([0, 0, 0, 0]).image(id, 0, 0, c.w, c.h);
            // (frame() is the socket's write(): false only means it is buffered, the frame still goes)
            g.frame(r);
            if (idx !== this.streamIdx) this.streamFrames++;
            this.streamIdx = idx; this.streamAt = now;
        }
        return c.wait(now);
    }
    _dropImages() {
        if (this.clip) for (let i = 0; i < this.clip.count; i++) record.dropImage(IMG_BASE + i);
    }
    /** Decoded frames nobody uses any more (no stream, no preview for a while): let go. */
    _trim(now) {
        if (this.clip && this.clip.cache.length && !(this.gpu && this.gpu.ready) && now - this.useAt > CACHE_MS) { this._dropImages(); this.clip.drop(); }
    }

    /* the HMI's picture cell */
    _hmi(pics, now) {
        const c = this.clip;
        if (!(this.assets && this.assetsGen === this.gen)) { this._ensureAssets(now); return 250; }
        const idx = c.at(now);
        pics.forEach((i) => {
            const s = this.shown[i.spawnId];
            if (s && (s.idx === idx || !i.visible) && now - s.at < HIDDEN_MS) return;
            this.shown[i.spawnId] = { idx, at: now };
            this.w.showAsset(i.spawnId, this.assets.handles[idx]);
        });
        return Math.max(1000 / HMI_FPS, c.wait(now));
    }
    _ensureAssets(now) {
        if (this.assetsBusy || now - this.assetsFailAt < ASSET_RETRY_MS) return;
        const gen = this.gen, c = this.clip, t0 = Date.now();
        this.assetsBusy = true;
        this.w.assets(c.frames.map((f) => f.png), 'aw' + gen).then((set) => {
            if (gen !== this.gen || !this.on) { this.w.releaseAssets(set); return; }
            this.assets = set; this.assetsGen = gen;
            this.log.info('widget animation: ' + set.files.length + ' frames handed to the HMI in ' + (Date.now() - t0) + ' ms');
        }, (e) => {
            this.assetsFailAt = Date.now();
            this.log.warn('widget animation: the HMI did not take the frames (' + (e && e.message || e) + '), trying again in ' + ASSET_RETRY_MS / 1000 + ' s');
        }).then(() => { this.assetsBusy = false; this.kick(); });
    }
    _releaseAssets() {
        if (this.assets) { this.w.releaseAssets(this.assets); this.assets = null; this.assetsGen = -1; }
    }

    /** Frames a second that reached a widget, over the last few seconds. */
    _rate(now) {
        const n = this.streamFrames + (this.w.assetsShown || 0);
        this.samples.push([now, n]);
        while (this.samples.length > 2 && now - this.samples[0][0] > FPS_WINDOW_MS) this.samples.shift();
        const a = this.samples[0], dt = now - a[0];
        this.fps = dt >= 500 ? Math.round((n - a[1]) * 10000 / dt) / 10 : this.fps;
        if (!this.logAt || now - this.logAt > 60000) {
            if (this.logAt) this.log.info('widget animation: ' + this.path + ', ' + this.fps + ' fps');
            this.logAt = now;
        }
    }
}

module.exports = { AnimatedWidget, pictureInstances, HMI_FPS, IMG_BASE };
