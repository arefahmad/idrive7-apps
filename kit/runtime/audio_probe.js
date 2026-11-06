'use strict';
/**
 * audio_probe.js - what the unit offers an app for sound, read on the car. Read-only: it reads files and, at
 * most, waits to see whether a media-player instance answers; it never calls a method, so nothing that plays
 * is touched. Node 8, no npm modules.
 *
 *   const AP = require('./kit/audio_probe');
 *   AP.configs()                 -> what BMW's app manager (oap-mainapp), the interface catalog and mediaapp say
 *   AP.own()                     -> what this app's install generated for it (the media-player interface, its ACL)
 *   await AP.reach('OapGenericMedia', 6000) -> { ok, available, error }: does that media-player instance answer
 *   AP.text({ configs, own, reach }) -> the report as text
 *
 * Why: BMW's own Spotify is a native media service on a fixed list of sources; oap-mainapp names generic media
 * players for apps (mediaPlayerEntertainmentHu = "OapGenericMedia", and overlay / interrupt ones). Whether an
 * app may use one, and how, decides whether G's TV can play sound the car's own way (docs/animated-widget.md has
 * the HMI side; dev repo docs/learnings has the car session).
 * Every path can be pointed elsewhere with MGU_AUDIO_ROOT (a folder standing in for /, for tests).
 */
const fs = require('fs');
const path = require('path');

const MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const CC = 'org.genivi.am.commandinterface.CommandControl';
const ROOT = process.env.MGU_AUDIO_ROOT || '/';
const at = (p) => path.join(ROOT, p);
const FILES = {
    base: at('usr/lib/oap-mainapp/config/base.json'),
    srcGen: at('usr/lib/oap-mainapp/src-gen'),
    catalog: at('etc/oap/someip/someip-interfaces.json'),
    mediaapp: [at('etc/mediaconfig/mediaapp_config_hu.xml')],
    variant: at('etc/mediaconfig/mediaapp_variant_select.xml'),
};
const APP_ROOT = process.env.MGU_APP_ROOT || path.resolve(__dirname, '..', '..', '..');

function read(file) {
    try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; } catch (e) { return { ok: false, error: e.code || e.message }; }
}
const short = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '...' : s; };
/** Every key (at any depth) whose name matches re: [[dotted path, value]]. */
function keysLike(obj, re, pre, out) {
    out = out || [];
    if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => {
        const p = pre ? pre + '.' + k : k;
        if (re.test(k)) out.push([p, obj[k]]);
        else keysLike(obj[k], re, p, out);
    });
    return out;
}
/** An interface definition (the shape oap-mainapp's src-gen and an app's someipInterfaces use): its names. */
function shape(def) {
    if (!def || typeof def !== 'object') return null;
    const names = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);
    return { instances: def.instances || null, methods: names(def.methods), fields: names(def.attributes || def.fields), events: names(def.broadcasts || def.events) };
}

/** What oap-mainapp, the interface catalog and mediaapp say about sound. */
function configs() {
    const r = { files: {} };
    // oap-mainapp's own config: the media players it names for apps
    const b = read(FILES.base);
    r.files.base = b.ok ? 'ok' : b.error;
    if (b.ok) {
        try { r.mediaPlayer = keysLike(JSON.parse(b.text), /^mediaPlayer/i).map((e) => [e[0], e[1]]); } catch (e) {
            r.mediaPlayer = (b.text.match(/"mediaPlayer[A-Za-z]*"\s*:\s*("[^"]*"|\{[^}]*\})/g) || []).map((m) => [m.split(':')[0].replace(/"/g, '').trim(), m.slice(m.indexOf(':') + 1).trim()]);
        }
    }
    // the interface definitions oap-mainapp carries
    [[MP, 'mediaPlayerDef'], [CC, 'commandControlDef']].forEach((x) => {
        const f = read(path.join(FILES.srcGen, x[0].replace(/\./g, '_') + '.json'));
        r.files[x[1]] = f.ok ? 'ok' : f.error;
        if (f.ok) { try { r[x[1]] = shape(JSON.parse(f.text)); } catch (e) { r[x[1]] = { error: 'not JSON' }; } }
    });
    // the unit's interface catalog, which MainApp installs an app's SOME/IP manifest against
    const c = read(FILES.catalog);
    r.files.catalog = c.ok ? 'ok' : c.error;
    if (c.ok) {
        r.catalogHasOapGeneric = /OapGeneric/.test(c.text);
        try {
            const db = JSON.parse(c.text), e = db.interfaces && db.interfaces[MP];
            r.catalogMediaPlayer = e ? short(e, 600) : 'not in the catalog';
        } catch (e) { r.catalogMediaPlayer = 'catalog not JSON'; }
    }
    // mediaapp: the Media menu's sources (and which of its configs this unit picks)
    const v = read(FILES.variant);
    r.files.variant = v.ok ? 'ok' : v.error;
    const picked = v.ok ? (v.text.match(/mediaapp_config_[A-Za-z0-9_]+\.xml/g) || []) : [];
    const files = FILES.mediaapp.concat(picked.map((n) => at('etc/mediaconfig/' + n))).filter((f, i, a) => a.indexOf(f) === i);
    r.sources = [];
    files.forEach((f) => {
        const x = read(f);
        r.files[path.basename(f)] = x.ok ? 'ok' : x.error;
        if (!x.ok) return;
        const re = /<source\s+name="([^"]+)"[\s\S]*?<\/source>/g;
        for (let m = re.exec(x.text); m; m = re.exec(x.text)) {
            const g = (tag) => { const y = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(m[0]); return y ? y[1].trim() : ''; };
            if (!r.sources.some((s) => s.name === m[1])) r.sources.push({ name: m[1], media: g('MediaSourceInst'), am: g('AmSourceInst'), file: path.basename(f) });
        }
    });
    return r;
}

/** What this app's install generated: the media-player interface (if the catalog had it) and its ACL lines. */
function own() {
    const dir = path.join(APP_ROOT, 'someipInterfaces'), r = { dir };
    const f = read(path.join(dir, MP.replace(/\./g, '_') + '.json'));
    r.mediaPlayer = f.ok ? (() => { try { return shape(JSON.parse(f.text)); } catch (e) { return { error: 'not JSON' }; } })() : null;
    r.mediaPlayerFile = f.ok ? 'ok' : f.error;
    const a = read(path.join(dir, 'acl.json'));
    r.acl = a.ok ? 'ok' : a.error;
    if (a.ok) {
        try {
            const acl = JSON.parse(a.text), mine = (list) => (list || []).filter((e) => /mediaplayer/i.test(JSON.stringify(e))).map((e) => short(e, 300));
            r.aclRequests = mine(acl.requests); r.aclOffers = mine(acl.offers);
        } catch (e) { r.aclRequests = ['acl.json not JSON']; }
    }
    return r;
}

/**
 * Does media-player instance `instance` answer? Builds a proxy from this app's own interface config and only
 * waits for the provider's availability (no method is called). { ok, available, error }.
 */
async function reach(instance, ms, signals) {
    const S = signals || require('./signals');
    if (!S.hasNative()) return { ok: false, available: false, error: 'no SOME/IP here' };
    let p;
    try { p = await S.proxy(MP, instance); } catch (e) { return { ok: false, available: false, error: String(e.message || e) }; }
    let available = false;
    await S.onAvailable(p, (a) => { available = available || a; }).catch(() => {});
    const until = Date.now() + (ms || 6000);
    while (!available && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    try { if (p.shutdown) await p.shutdown(); } catch (e) { /* gone */ }
    return { ok: true, available, error: '' };
}

function text(r) {
    const L = [], c = r.configs, o = r.own;
    if (c) {
        L.push('== files: ' + Object.keys(c.files).map((k) => k + ' ' + c.files[k]).join(', '));
        L.push('== oap-mainapp media players (config/base.json)');
        (c.mediaPlayer || []).forEach((e) => L.push('  ' + e[0] + ' = ' + short(e[1], 400)));
        if (c.mediaPlayerDef) L.push('== MediaPlayer interface: instances ' + short(c.mediaPlayerDef.instances, 600), '  methods: ' + c.mediaPlayerDef.methods.join(', '), '  fields: ' + c.mediaPlayerDef.fields.join(', '));
        if (c.commandControlDef) L.push('== CommandControl interface: methods: ' + c.commandControlDef.methods.join(', '));
        if (c.catalogMediaPlayer !== undefined) L.push('== catalog: MediaPlayer ' + c.catalogMediaPlayer, '  "OapGeneric" anywhere in the catalog: ' + (c.catalogHasOapGeneric ? 'yes' : 'no'));
        L.push('== mediaapp sources (' + (c.sources || []).length + ')');
        (c.sources || []).forEach((s) => L.push('  ' + s.name + ': media ' + (s.media || '-') + ', am ' + (s.am || '-') + '  (' + s.file + ')'));
    }
    if (o) {
        L.push('== this app\'s install: MediaPlayer config ' + o.mediaPlayerFile + (o.mediaPlayer ? ', instances ' + short(o.mediaPlayer.instances, 400) + ', methods ' + (o.mediaPlayer.methods || []).length : ''));
        L.push('  acl.json ' + o.acl + (o.aclRequests ? ': requests ' + (o.aclRequests.join(' | ') || 'none') : ''));
    }
    if (r.reach) L.push('== OapGenericMedia answers: ' + (r.reach.ok ? (r.reach.available ? 'yes' : 'no (built, nobody answered)') : 'no proxy: ' + r.reach.error));
    return L.join('\n') + '\n';
}

module.exports = { configs, own, reach, text, MP, CC, FILES };
