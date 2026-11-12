'use strict';
/**
 * look.js - the cluster ETA's picture, in the style of Apple's CarPlay: Inter (the open look-alike of SF Pro),
 * Apple's dark-mode label colours and system traffic colours, and Apple's materials for the background.
 *
 *   parts(r, arrivalText, style)  -> [{ v, u, c }] the values to show, or null
 *   render(parts, style, fonts)   -> { w, h, data } RGBA (straight alpha), w x h = IW x IH
 *
 * style: { look, layout, traffic, ampm, arrival, minutes, distance }
 *   look    plain  text straight on the strip, with a soft shadow
 *           card   CarPlay's dark platter: solid #1C1C1E-ish, rounded, a hairline rim and a drop shadow
 *           glass  frosted glass: a translucent smoky tint the cluster's map shows through, a top sheen,
 *                  a bright rim and a drop shadow (the layer can't read the map under it, so no real blur)
 *           light  Apple's light material: white glass, dark text (for daytime)
 *   layout  row      6:42 arrival   23 min   14.2 mi
 *           stacked  Apple Maps' ETA card: the values in a row, their labels small underneath
 *
 * Drawn only when the numbers or the style change, never per frame. Node 8.
 */
const { Canvas } = require('./kit/canvas');

const IW = 800, IH = 112;
const LOOKS = ['plain', 'card', 'glass', 'light'];
const LAYOUTS = ['row', 'stacked'];
const DEFAULT_STYLE = { look: 'glass', layout: 'row', traffic: true, ampm: false, arrival: true, minutes: true, distance: true };

// Apple's dark-mode colours: label, secondaryLabel; light-mode label / secondaryLabel; system green / orange / red
const DARK = { v: [255, 255, 255, 255], u: [152, 152, 159, 255] };
const LIGHT = { v: [0, 0, 0, 255], u: [96, 96, 102, 255] };
const TRAFFIC = {
    dark: { green: [48, 209, 88, 255], yellow: [255, 159, 10, 255], red: [255, 69, 58, 255] },
    light: { green: [36, 160, 66, 255], yellow: [222, 128, 0, 255], red: [225, 40, 30, 255] },
};
const SAMPLE_ROUTE = { travelSec: 23 * 60, traffic: 'green', dist: '14.2', unit: 'mi' };

/** The values to show, Apple Maps' way. r: route.js pick(); arrival: 'h:mm AM' text or null. */
function parts(r, arrival, style) {
    if (!r) return null;
    const s = Object.assign({}, DEFAULT_STYLE, style);
    const out = [];
    if (s.arrival && arrival) {
        const m = /^(\d+:\d\d)\s*([AP]M)?$/.exec(arrival);
        out.push(m && s.ampm && m[2] ? { v: m[1], u: m[2], k: 'arrival', label: 'arrival' } : { v: m ? m[1] : arrival, u: 'arrival', k: 'arrival', label: 'arrival' });
    }
    if (s.minutes && (r.travelSec || r.travelSec === 0)) {
        const m = Math.max(0, Math.round(r.travelSec / 60));
        const c = s.traffic ? r.traffic : null;
        out.push(m < 60 ? { v: String(m), u: 'min', c: c, k: 'min', label: 'min' }
            : { v: Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60), u: 'hr', c: c, k: 'min', label: 'hr' });
    }
    if (s.distance && r.dist) out.push({ v: r.dist, u: r.unit || '', k: 'dist', label: r.unit || '' });
    return out.length ? out : null;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Signed distance from (px, py) to a rounded rect (negative inside). */
function rrDist(px, py, x, y, w, h, r) {
    const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r), qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
    return Math.min(Math.max(qx, qy), 0) + Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0)) - r;
}
/** A soft drop shadow under a rounded rect: alpha falls off over blur px, offset dy down. One pass. */
function shadow(cv, x, y, w, h, r, blur, dy, alpha) {
    const x0 = Math.max(0, Math.floor(x - blur)), x1 = Math.min(cv.w, Math.ceil(x + w + blur));
    const y0 = Math.max(0, Math.floor(y + dy - blur)), y1 = Math.min(cv.h, Math.ceil(y + h + dy + blur));
    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            const d = rrDist(px + 0.5, py + 0.5, x, y + dy, w, h, r);
            if (d >= blur) continue;
            const t = clamp01(1 - (d + blur * 0.35) / (blur * 1.35));
            const a = alpha * t * t * (3 - 2 * t);
            if (a > 0.004) cv._blend(px, py, [0, 0, 0, 255], a);
        }
    }
}

/** Measure each part: value width, unit / label width. */
function measure(cv, ps, layout, F) {
    return ps.map((p) => ({
        p: p,
        vw: cv.textWidth(p.v, F.vs, { font: F.bold, literal: true }),
        uw: layout === 'stacked' ? cv.textWidth(p.label || p.u, F.ls, { font: F.med, literal: true }) : (p.u ? cv.textWidth(p.u, F.us, { font: F.med, literal: true }) : 0),
    }));
}

function render(ps, style, fontNames) {
    const s = Object.assign({}, DEFAULT_STYLE, style);
    const fn = fontNames || { bold: 'bold', med: 'label' };
    const cv = new Canvas(IW, IH);
    cv.clear([0, 0, 0, 0]);
    if (!ps || !ps.length) return { w: IW, h: IH, data: Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length) };
    const stacked = s.layout === 'stacked';
    const F = { bold: fn.bold, med: fn.med, vs: 40, us: 26, ls: 21 };
    const light = s.look === 'light';
    const col = light ? LIGHT : DARK, tc = TRAFFIC[light ? 'light' : 'dark'];
    const V = { font: F.bold, literal: true }, U = { font: F.med, literal: true };

    // content size
    const m = measure(cv, ps, s.layout, F);
    const GAP = 8, SEP = stacked ? 46 : 32;
    const colW = (q) => (stacked ? Math.max(q.vw, q.uw) : q.vw + (q.uw ? GAP + q.uw : 0));
    let cw = m.reduce((a, q) => a + colW(q), 0) + SEP * Math.max(0, m.length - 1);
    const ch = stacked ? 56 : 40;                       // values (+ the label line)

    // the platter: generous padding, Apple's continuous-looking corner
    const padX = stacked ? 40 : 36, padY = stacked ? 18 : 20;
    const pw = Math.min(IW - 24, Math.round(cw + padX * 2)), ph = Math.round(ch + padY * 2);
    const px = Math.round((IW - pw) / 2), py = Math.round((IH - ph) / 2) - 2;
    const rad = Math.min(ph / 2, 26);
    if (s.look === 'card') {
        shadow(cv, px, py, pw, ph, rad, 14, 4, 0.55);
        cv.card(px, py, pw, ph, rad, [[0, [44, 44, 48, 250]], [1, [30, 30, 33, 250]]]);
        cv.strokeRoundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, rad, 1, [255, 255, 255, 26]);
    } else if (s.look === 'glass') {
        shadow(cv, px, py, pw, ph, rad, 16, 5, 0.45);
        // a smoky tint the map shows through, lighter at the top like light caught in frosted glass
        cv.card(px, py, pw, ph, rad, [[0, [86, 88, 96, 150]], [0.5, [52, 54, 60, 135]], [1, [40, 41, 46, 150]]]);
        cv.card(px + 1, py + 1, pw - 2, Math.round(ph * 0.48), rad - 1, [[0, [255, 255, 255, 34]], [1, [255, 255, 255, 0]]]);
        cv.strokeRoundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, rad, 1.2, [255, 255, 255, 60]);
    } else if (s.look === 'light') {
        shadow(cv, px, py, pw, ph, rad, 14, 4, 0.40);
        cv.card(px, py, pw, ph, rad, [[0, [252, 252, 253, 235]], [1, [236, 236, 240, 228]]]);
        cv.strokeRoundRect(px + 0.5, py + 0.5, pw - 1, ph - 1, rad, 1, [255, 255, 255, 140]);
    }

    // the text, centred in the platter
    let x = Math.round((IW - cw) / 2);
    const plain = s.look === 'plain';
    if (stacked) {
        const vb = py + padY + 30, lb = vb + 26;
        m.forEach((q) => {
            const w = colW(q), c = (q.p.c && tc[q.p.c]) || col.v;
            if (plain) cv.text(q.p.v, x + (w - q.vw) / 2, vb + 2, F.vs, [0, 0, 0, 120], V);
            cv.text(q.p.v, x + (w - q.vw) / 2, vb, F.vs, c, V);
            cv.text(q.p.label || q.p.u, x + (w - q.uw) / 2, lb, F.ls, col.u, U);
            x += w + SEP;
        });
    } else {
        const base = py + padY + 40 - 5;
        m.forEach((q) => {
            const c = (q.p.c && tc[q.p.c]) || col.v;
            if (plain) cv.text(q.p.v, x, base + 2, F.vs, [0, 0, 0, 120], V);
            cv.text(q.p.v, x, base, F.vs, c, V);
            x += q.vw;
            if (q.uw) {
                x += GAP;
                if (plain) cv.text(q.p.u, x, base + 2, F.us, [0, 0, 0, 120], U);
                cv.text(q.p.u, x, base, F.us, col.u, U);
                x += q.uw;
            }
            x += SEP;
        });
    }
    return { w: IW, h: IH, data: Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length) };
}

module.exports = { IW, IH, LOOKS, LAYOUTS, DEFAULT_STYLE, SAMPLE_ROUTE, parts, render };
