'use strict';
/**
 * design.js - a whole-cluster design from Cluster Studio (the homelab's /cluster page): one 1920 x 720 picture on the
 * panel target, under the ETA and the second slot (z 2). The homelab copies it to <data>/studio/design.rgba.gz
 * (raw RGBA, gzip) when the car is online; the areas that must stay BMW's (speedometer and tachometer rims, numbers
 * and needles, the digital speed, the bottom row and its warning lights, the edges) are already see-through in it.
 *
 * The file is checked every few seconds; a new one is uploaded once (about 5.5 MB to the cluster). Off, or no file:
 * the layer is hidden. Node 8. Never throws out.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 1920, H = 720;

class Design {
    constructor(cr, dataDir, note) {
        this.cr = cr; this.note = note;
        this.file = path.join(dataDir, 'studio', 'design.rgba.gz');
        this.ref = null; this.mtime = 0; this.loaded = false; this.shown = false; this.busy = false;
    }

    /** The layer: made only once a design file is there and the setting is on (5.5 MB of the renderer's memory). */
    create() {
        if (!this.cr || this.ref) return;
        if (!fs.existsSync(this.file)) return;
        try {
            this.ref = this.cr.image({ target: 'panel', klass: 'content', z: 2, x: 0, y: 0, w: W, h: H, iw: W, ih: H,
                sampling: 'bilinear', fps: 1, visible: false });
        } catch (e) { this.note('design: ' + e.message); }
    }

    /** on: Settings > Cluster design. Loads a new file, shows or hides the layer. */
    tick(on) {
        if (!this.ref && on) this.create();
        if (!this.ref || this.busy) return;
        let st = null;
        try { st = fs.statSync(this.file); } catch (e) { /* no design yet */ }
        if (st && st.mtime.getTime() !== this.mtime) {
            this.busy = true;
            const m = st.mtime.getTime();
            fs.readFile(this.file, (err, gz) => {
                if (err) { this.busy = false; return; }
                zlib.gunzip(gz, (e2, px) => {
                    this.busy = false;
                    this.mtime = m;
                    if (e2 || !px || px.length !== W * H * 4) { this.note('design: unreadable file (' + (e2 ? e2.message : (px ? px.length : 0) + ' bytes') + ')'); return; }
                    try { this.cr.pixels(this.ref, null, px); this.loaded = true; this.note('design: loaded (' + Math.round(gz.length / 1024) + ' KB)'); } catch (e) { this.note('design: ' + e.message); }
                    this.tick(on);
                });
            });
            return;
        }
        if (!st) this.loaded = false;
        const want = !!(on && this.loaded);
        if (want !== this.shown) {
            this.shown = want;
            try { this.cr.set(this.ref, { visible: want }); } catch (e) { /* next tick */ }
            this.note('design: ' + (want ? 'shown' : 'hidden'));
        }
    }
}

module.exports = { Design, W, H };
