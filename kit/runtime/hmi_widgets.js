'use strict';
/**
 * hmi_widgets.js - how the HMI builds its home-screen widget layouts, read from the unit. Read-only: it
 * writes, mounts and restarts nothing. Node 8, no npm modules; also runs on its own:
 *
 *   node hmi_widgets.js                         every widget layout: which cells show a picture, and whether
 *                                               the HMI draws that picture through a mask (the dark edge)
 *   node hmi_widgets.js --template NAME         one layout's whole definition, its identifiers named
 *   [--hmi /usr/bin/HmiMain3D] [--roots /mnt/dataro/dataro1/hmi,/mnt/dataro/data/hmi]
 *
 * In an app: require('./kit/hmi_widgets').scan({ onProgress }) -> Promise<report> (see scan()).
 *
 * How the HMI works (the Store's mgu-render, js/hmi_template.js; a car session, docs/animated-widget.md):
 * HmiMain3D builds every page and widget from the *.pbw files (protobuf) under its hmi folder; every name in
 * them is an index into an identifier table compiled into the binary. On the car (P18, Nov 2026) the Drive
 * Recorder layout's _Big variant draws its picture (cell BackgroundImage1) through a child of type
 * LT_Label_WidgetBackgroundMask, whose render pass "shadow_content" is the dark edge: the mask and the
 * picture are one child. This looks for a layout that shows a writable picture through a plain image child.
 *
 * Memory: HmiMain3D (tens of MB) is never read whole: the identifier table is found with chunked scans and
 * read through a small page cache, and the scan yields to the event loop as it goes, so an app can run it.
 */
const fs = require('fs');
const path = require('path');

// (MGU_HMI_BIN / MGU_HMI_ROOTS: another binary and folders, for tests)
const DEFAULTS = {
    hmi: process.env.MGU_HMI_BIN || '/usr/bin/HmiMain3D',
    roots: process.env.MGU_HMI_ROOTS ? process.env.MGU_HMI_ROOTS.split(',') : ['/mnt/dataro/dataro1/hmi', '/mnt/dataro/data/hmi'],
    yieldMs: 15,
};
const ANCHOR = Buffer.from('\0eGfxIdWidgetType_eWidgetType_EmbeddedSurface\0', 'latin1');
const CHUNK = 4 * 1024 * 1024, PAGE = 64 * 1024, PAGES = 96;
const MAX_FILES = 5000, MAX_FILE = 4 * 1024 * 1024, MAX_DEPTH = 8;
// widget layouts worth a look: start / main-menu widgets and their size variants
const LAYOUT = /^eGfxIdWidgetType_LT_.*(Widget|OnlineApps|Startmenu|Sport)/i;
// a child's parameter that takes a picture, and a cell name that carries one
const IMAGE_PARAM = /Image|Graphic|Picture|Bitmap|Texture|Photo/i;
const MASK_TYPE = /Mask/i;

const later = () => new Promise((r) => setImmediate(r));
function ReadError(where, e) { const x = new Error(where + ': ' + (e.code || e.message)); x.code = e.code || 'READ'; x.where = where; return x; }

/* ---------- HmiMain3D, through a page cache ---------- */
class Paged {
    constructor(file) {
        try { this.fd = fs.openSync(file, 'r'); this.size = fs.fstatSync(this.fd).size; } catch (e) { throw ReadError(file, e); }
        this.pages = new Map();
    }
    close() { try { fs.closeSync(this.fd); } catch (e) { /* closed */ } }
    page(i) {
        let p = this.pages.get(i);
        if (p) { this.pages.delete(i); this.pages.set(i, p); return p; }
        p = Buffer.alloc(Math.min(PAGE, Math.max(0, this.size - i * PAGE)));
        fs.readSync(this.fd, p, 0, p.length, i * PAGE);
        this.pages.set(i, p);
        if (this.pages.size > PAGES) this.pages.delete(this.pages.keys().next().value);
        return p;
    }
    bytes(off, len) {
        if (off < 0 || off + len > this.size) return null;
        const first = Math.floor(off / PAGE), last = Math.floor((off + len - 1) / PAGE);
        if (first === last) { const p = this.page(first); return p.slice(off - first * PAGE, off - first * PAGE + len); }
        const out = Buffer.alloc(len);
        for (let i = first, o = 0; i <= last; i++) {
            const p = this.page(i), s = i === first ? off - first * PAGE : 0, e = Math.min(p.length, off + len - i * PAGE);
            p.copy(out, o, s, e); o += e - s;
        }
        return out;
    }
    u64(off) { const b = this.bytes(off, 8); return b ? b.readUInt32LE(0) + b.readUInt32LE(4) * 0x100000000 : -1; }
    /** Every offset where needle is, scanned in chunks (yielding between them). */
    async find(needle, yieldMs) {
        const out = [], buf = Buffer.alloc(CHUNK + needle.length);
        let t0 = Date.now();
        for (let base = 0; base < this.size; base += CHUNK) {
            const n = fs.readSync(this.fd, buf, 0, Math.min(buf.length, this.size - base), base);
            const view = buf.slice(0, n);
            for (let i = view.indexOf(needle); i >= 0 && i < CHUNK; i = view.indexOf(needle, i + 1)) out.push(base + i);
            if (Date.now() - t0 > yieldMs) { await later(); t0 = Date.now(); }
        }
        return out;
    }
}

/**
 * Identifier name -> number, from HmiMain3D's table of pointers to names (as mgu-render's hmi_template.js
 * reads it: ELF LOAD segments, the long run of consecutive pointers to "eGfxId..." strings that includes the
 * one to eGfxIdWidgetType_eWidgetType_EmbeddedSurface).
 */
async function identifiers(file, yieldMs) {
    const f = new Paged(file);
    try {
        const phoff = f.u64(0x20), hdr = f.bytes(0x36, 4);
        if (!hdr) throw new Error('not an ELF file');
        const phentsize = hdr.readUInt16LE(0), phnum = hdr.readUInt16LE(2), loads = [];
        for (let i = 0; i < phnum; i++) {
            const h = phoff + i * phentsize, ty = f.bytes(h, 4);
            if (ty && ty.readUInt32LE(0) === 1) loads.push({ off: f.u64(h + 8), vaddr: f.u64(h + 16), size: f.u64(h + 32) });
        }
        const toOff = (va) => { const l = loads.find((s) => va >= s.vaddr && va < s.vaddr + s.size); return l ? va - l.vaddr + l.off : -1; };
        const toVaddr = (off) => { const l = loads.find((s) => off >= s.off && off < s.off + s.size); return l ? off - l.off + l.vaddr : -1; };
        const nameAt = (ptrOff) => {
            if (ptrOff < 0 || ptrOff + 8 > f.size) return null;
            const off = toOff(f.u64(ptrOff));
            if (off < 0) return null;
            const b = f.bytes(off, Math.min(1024, f.size - off));
            if (!b || b.toString('latin1', 0, 6) !== 'eGfxId') return null;
            const end = b.indexOf(0);
            return end > 0 ? b.toString('latin1', 0, end) : null;
        };
        const anchors = await f.find(ANCHOR, yieldMs);
        let best = new Map();
        for (const a of anchors) {
            const va = toVaddr(a + 1);
            if (va < 0) continue;
            const ptr = Buffer.alloc(8);
            ptr.writeUInt32LE(va % 0x100000000, 0); ptr.writeUInt32LE(Math.floor(va / 0x100000000), 4);
            for (const e of await f.find(ptr, yieldMs)) {
                if (e % 8) continue;
                let start = e;
                while (nameAt(start - 8)) start -= 8;
                const ids = new Map();
                for (let off = start, name; (name = nameAt(off)); off += 8) { if (!ids.has(name)) ids.set(name, (off - start) / 8 + 1); }
                if (ids.size > best.size) best = ids;
                await later();
            }
        }
        if (best.size < 1000) throw new Error('no identifier table in ' + file);
        return best;
    } finally { f.close(); }
}

/* ---------- protobuf, read without a schema ---------- */
function varint(b, o) {
    let n = 0, mul = 1, i = o;
    for (;;) {
        if (i >= b.length || i - o > 9) return null;
        const c = b[i++];
        n += (c & 0x7f) * mul; mul *= 128;
        if (!(c & 0x80)) return { n, end: i };
    }
}
/** The fields of b (a message), or null if b does not read as one to its last byte. */
function fields(b) {
    const out = [];
    let o = 0;
    while (o < b.length) {
        const k = varint(b, o);
        if (!k || k.n < 8) return null;
        const f = Math.floor(k.n / 8), wt = k.n % 8;
        o = k.end;
        if (wt === 0) { const v = varint(b, o); if (!v) return null; out.push({ f, wt, v: v.n }); o = v.end; }
        else if (wt === 1) { if (o + 8 > b.length) return null; out.push({ f, wt, raw: b.slice(o, o + 8) }); o += 8; }
        else if (wt === 5) { if (o + 4 > b.length) return null; out.push({ f, wt, raw: b.slice(o, o + 4) }); o += 4; }
        else if (wt === 2) {
            const l = varint(b, o);
            if (!l || l.end + l.n > b.length) return null;
            out.push({ f, wt, raw: b.slice(l.end, l.end + l.n) }); o = l.end + l.n;
        } else return null;
    }
    return out;
}
const printable = (b) => b.length > 0 && b.length <= 200 && Array.prototype.every.call(b, (c) => c >= 0x20 && c < 0x7f);

class Namer {
    constructor(ids) { this.byNum = new Map(); ids.forEach((n, name) => { if (!this.byNum.has(n)) this.byNum.set(n, name); }); this.ids = ids; }
    name(n) { return this.byNum.get(n) || null; }
    /** An identifier reference ({1: n}, as hmi_template.js writes them): its name, else null. */
    ref(b) { const x = fields(b); return x && x.length === 1 && x[0].f === 1 && x[0].wt === 0 ? this.name(x[0].v) : null; }
}
const short = (name) => (name ? name.replace(/^eGfxId(WidgetType_|Widget_|Parameter_)?/, '') : '?');

/** The tree of message b, one line a field, identifiers named (numbers that may be identifiers marked "?"). */
function tree(b, nm, indent, out, depth) {
    const x = fields(b);
    if (!x) { out.push(indent + '(not a message: ' + b.length + ' bytes)'); return out; }
    x.forEach((y) => {
        const p = indent + y.f + ': ';
        if (y.wt === 0) { const n = nm.name(y.v); out.push(p + y.v + (n && y.v > 8 ? '   (#' + short(n) + '?)' : '')); return; }
        if (y.wt === 5) { out.push(p + 'f32 ' + +y.raw.readFloatLE(0).toFixed(4) + ' / u32 ' + y.raw.readUInt32LE(0)); return; }
        if (y.wt === 1) { out.push(p + 'f64 ' + y.raw.readDoubleLE(0)); return; }
        const r = nm.ref(y.raw);
        if (r) { out.push(p + '@' + short(r)); return; }
        const sub = fields(y.raw);
        if (sub && sub.length && !(printable(y.raw) && y.raw.length > 3) && depth < 40) { out.push(p + '{'); tree(y.raw, nm, indent + '  ', out, depth + 1); out.push(indent + '}'); }
        else if (printable(y.raw)) out.push(p + JSON.stringify(y.raw.toString('latin1')));
        else out.push(p + 'bytes ' + y.raw.toString('hex').slice(0, 96) + (y.raw.length > 48 ? '... (' + y.raw.length + ')' : ''));
    });
    return out;
}

/** Every widget definition in a .pbw file: [{ name, raw }] (top-level field 1, its own field 1 the name). */
function definitions(buf, nm) {
    const top = fields(buf);
    if (!top) return [];
    return top.filter((x) => x.f === 1 && x.wt === 2).map((x) => {
        const y = fields(x.raw), head = y && y.find((z) => z.f === 1 && z.wt === 2);
        return { name: head ? nm.ref(head.raw) : null, raw: x.raw };
    }).filter((d) => d.name);
}

/** A definition's child widgets: [{ name, type, params: [{ param, bound } | { param, set: true }] }]. */
function children(raw, nm) {
    return (fields(raw) || []).filter((x) => x.f === 3 && x.wt === 2).map((x) => {
        const c = fields(x.raw) || [];
        const one = (f) => { const y = c.find((z) => z.f === f && z.wt === 2); return y ? nm.ref(y.raw) : null; };
        const params = c.filter((z) => z.f === 3 && z.wt === 2).map((z) => {
            const pf = fields(z.raw) || [], pn = pf.find((q) => q.f === 1 && q.wt === 2), pv = pf.find((q) => q.f === 2 && q.wt === 2);
            const param = pn ? nm.ref(pn.raw) : null;
            if (!pv) return { param };
            const vf = fields(pv.raw) || [], src = vf.find((q) => q.f === 1 && q.wt === 2), bound = src ? nm.ref(src.raw) : null;
            return bound ? { param, bound } : { param, set: true };
        });
        return { name: one(1), type: one(2), params };
    });
}

/**
 * Why a read found no widget files. Permission denied is said in one sentence (the app user cannot read
 * the HMI folders on the car; nothing here changes that). denied entries look like "path (EACCES)".
 */
function readFailure(denied, roots) {
    const list = denied || [];
    const perm = list.filter((d) => /\(EACCES\)|\(EPERM\)|EACCES|EPERM/.test(d));
    if (perm.length) return "G's Dash can't read the HMI widget folders (permission denied). Nothing was changed. The layouts can't be listed from the app.";
    return 'no widget files readable under ' + (roots || []).join(' or ') + (list.length ? ' (' + list.slice(0, 3).join(', ') + ')' : '');
}

/** The *.pbw files under root (depth-limited), and the folders it could not read. */
function pbwFiles(root, out, denied) {
    const walk = (d, depth) => {
        let list;
        try { list = fs.readdirSync(d); } catch (e) { if (e.code !== 'ENOENT') denied.push(d + ' (' + e.code + ')'); return; }
        list.forEach((n) => {
            if (out.length >= MAX_FILES) return;
            const p = path.join(d, n);
            let st;
            try { st = fs.statSync(p); } catch (e) { return; }
            if (st.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1);
            else if (st.isFile() && /\.pbw$/i.test(n) && st.size <= MAX_FILE) out.push(p);
        });
    };
    walk(root, 0);
    return out;
}

/**
 * Where a layout's cells reach a picture: { cell: [{ via: [child, ...], type, mask }] }. A child bound to a
 * layout that is itself defined (the Drive Recorder layout picks its _Big / _Small this way) is followed, so
 * the picture child at the end is the one reported. mask: its type is a mask (the dark edge), else plain.
 */
function pictures(name, defs, nm, depth, seen) {
    const out = {}, d = defs.get(name);
    if (!d || depth > 4 || seen.has(name)) return out;
    seen = new Set(seen).add(name);
    const masked = (type) => MASK_TYPE.test(type || '') || (defs.has(type) && defs.get(type).raw.indexOf('shadow_content') >= 0);
    children(d.raw, nm).forEach((c) => {
        c.params.filter((p) => p.bound && p.param).forEach((p) => {
            const add = (e) => { (out[p.bound] = out[p.bound] || []).push(e); };
            // a child that is itself a layout (its children take its cells): follow the cell into it; one that
            // does not use this cell shows no picture with it. Any other child taking a picture is the picture.
            const composite = !!c.type && defs.has(c.type) && children(defs.get(c.type).raw, nm).some((g) => g.params.some((q) => q.bound));
            if (composite) {
                const sub = pictures(c.type, defs, nm, depth + 1, seen);
                (sub[p.param] || []).forEach((e) => add({ via: [short(c.name)].concat(e.via), type: e.type, mask: e.mask }));
            } else if (IMAGE_PARAM.test(p.param) && !/Visible/.test(p.param)) add({ via: [short(c.name)], type: short(c.type), mask: masked(c.type) });
        });
    });
    return out;
}

/**
 * Read the unit. opts: { hmi, roots, onProgress(text), yieldMs }. Resolves { ok, error, ids, files, denied,
 * definitions, layouts: [{ name, file, cells: { cell: [{ via, type, mask }] }, verdict }], ms }, verdict one of
 * 'plain' (a picture cell, no mask), 'mask' (every picture through a mask), 'none' (no picture cell). Never rejects.
 */
async function scan(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {}), t0 = Date.now();
    const say = (s) => { if (o.onProgress) { try { o.onProgress(s); } catch (e) { /* the caller's */ } } };
    const r = { ok: false, error: '', hmi: o.hmi, ids: 0, files: 0, denied: [], definitions: 0, layouts: [], ms: 0 };
    try {
        // the car refuses these folders (EACCES) before any file is read: say so and stop, without opening
        // HmiMain3D or walking further. A root that does not exist is the same stop, with the plain reason.
        const readable = [];
        (o.roots || []).forEach((root) => {
            let code = '';
            try { fs.readdirSync(root); } catch (e) { code = e.code || 'ERR'; }
            if (code) r.denied.push(root + ' (' + code + ')'); else readable.push(root);
        });
        if (!readable.length) {
            r.error = readFailure(r.denied, o.roots);
            r.ms = Date.now() - t0;
            return r;
        }
        o.roots = readable;
        say('Reading ' + o.hmi + '...');
        const ids = await identifiers(o.hmi, o.yieldMs), nm = new Namer(ids);
        r.ids = ids.size;
        say('Reading the widget files...');
        const files = [];
        o.roots.forEach((root) => pbwFiles(root, files, r.denied));
        r.files = files.length;
        if (!files.length) throw new Error(readFailure(r.denied, o.roots));
        const defs = new Map();
        let tick = Date.now();
        for (const file of files) {
            let buf;
            try { buf = fs.readFileSync(file); } catch (e) { r.denied.push(file + ' (' + e.code + ')'); continue; }
            definitions(buf, nm).forEach((d) => { if (!defs.has(d.name)) defs.set(d.name, { file, raw: Buffer.from(d.raw) }); });
            if (Date.now() - tick > o.yieldMs) { await later(); tick = Date.now(); }
        }
        r.definitions = defs.size;
        say('Looking at ' + defs.size + ' definitions...');
        for (const name of defs.keys()) {
            if (!LAYOUT.test(name)) continue;
            const cells = pictures(name, defs, nm, 0, new Set()), list = Object.keys(cells).map((k) => cells[k]).reduce((a, b) => a.concat(b), []);
            r.layouts.push({ name: short(name), file: defs.get(name).file, cells: Object.keys(cells).reduce((m, k) => { m[short(k)] = cells[k]; return m; }, {}),
                verdict: !list.length ? 'none' : list.some((e) => !e.mask) ? 'plain' : 'mask' });
            if (Date.now() - tick > o.yieldMs) { await later(); tick = Date.now(); }
        }
        const rank = { plain: 0, mask: 1, none: 2 };
        r.layouts.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.name.localeCompare(b.name));
        r.ok = true;
        r._defs = defs; r._nm = nm;
    } catch (e) {
        const code = e && (e.code || '');
        const perm = code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(String(e && e.message || e));
        r.error = perm ? readFailure(r.denied.concat([(e.where || e.message || 'HMI') + ' (' + (code || 'EACCES') + ')']), o.roots) : (e && e.message || String(e));
    }
    r.ms = Date.now() - t0;
    return r;
}

/** The report as text (what the app saves and the command line prints). */
function text(r) {
    const L = [];
    L.push('hmi_widgets: ' + (r.ok ? 'ok' : 'FAILED: ' + r.error) + ', ' + r.ids + ' identifiers in ' + r.hmi + ', ' + r.files + ' widget files, ' + r.definitions + ' definitions, ' + (r.ms / 1000).toFixed(1) + ' s');
    if (r.denied.length) L.push('could not read: ' + r.denied.slice(0, 10).join(', ') + (r.denied.length > 10 ? ' (+' + (r.denied.length - 10) + ')' : ''));
    L.push('');
    L.push('verdict  layout  (file)');
    L.push('  cell -> child path : picture type [MASK = drawn with the dark edge]');
    r.layouts.forEach((l) => {
        L.push((l.verdict === 'plain' ? 'PLAIN  ' : l.verdict === 'mask' ? 'mask   ' : '-      ') + l.name + '  (' + l.file + ')');
        Object.keys(l.cells).forEach((c) => l.cells[c].forEach((e) => L.push('    ' + c + ' -> ' + e.via.join(' / ') + ' : ' + e.type + (e.mask ? '  MASK' : ''))));
    });
    return L.join('\n') + '\n';
}

if (require.main === module) {
    const opt = { hmi: DEFAULTS.hmi, roots: DEFAULTS.roots.join(','), template: '' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
        const k = args[i].replace(/^--/, '');
        if (!(k in opt) || i + 1 >= args.length) { console.error('usage: node hmi_widgets.js [--template NAME] [--hmi FILE] [--roots DIR,DIR]'); process.exit(2); }
        opt[k] = args[i + 1];
    }
    scan({ hmi: opt.hmi, roots: opt.roots.split(',').filter(Boolean), onProgress: (s) => process.stderr.write(s + '\n') }).then((r) => {
        if (!opt.template) { process.stdout.write(text(r)); process.exit(r.ok ? 0 : 3); }
        if (!r.ok) { process.stderr.write(text(r)); process.exit(3); }
        const want = 'eGfxIdWidgetType_' + opt.template.replace(/^eGfxIdWidgetType_/, ''), d = r._defs.get(want);
        if (!d) { process.stdout.write('template ' + want + ': no file defines it\n'); process.exit(1); }
        const L = ['template ' + want + ': ' + d.file + ', ' + d.raw.length + ' bytes', '', '== children'];
        children(d.raw, r._nm).forEach((c) => {
            L.push('- ' + short(c.name) + '   ' + short(c.type));
            c.params.forEach((p) => L.push('    ' + short(p.param) + (p.bound ? '  <- ' + short(p.bound) : p.set ? '  = (a value)' : '')));
        });
        L.push('', '== the whole definition');
        tree(d.raw, r._nm, '', L, 0);
        process.stdout.write(L.join('\n') + '\n');
        process.exit(0);
    });
}

module.exports = { scan, text, readFailure, identifiers, fields, definitions, children, pictures, tree, Namer, DEFAULTS };
