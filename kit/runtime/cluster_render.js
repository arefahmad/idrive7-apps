'use strict';
/**
 * cluster_render.js - the separately installed "Cluster renderer" tool (cluster-render,
 * robertnisipeanu/idrive-apps, from the Store) as every app finds it, and its status text read the
 * same way everywhere: G's Dash's cluster logo (and through it its cluster dials, HUD and full-screen
 * test), G's Music's cluster view and G's TV's cluster / HUD picture.
 *
 * The tool's own Node client (MPL-2.0) is part of no app: loadClient() loads it at run time from where
 * the tool installs it (/var/opt/cluster-render/current), and only a root-owned file nobody else may
 * write. NG_CR_CLIENT / NG_CR_SOCK point the tests at a stand-in.
 *
 * Node 8: no ?., ?? or object spread.
 */
const fs = require('fs');
const path = require('path');

const CLIENT = process.env.NG_CR_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const SOCK = process.env.NG_CR_SOCK || '/dev/shm/cluster-render/render.sock';
const TESTING = !!(process.env.NG_CR_CLIENT || process.env.NG_CR_SOCK);
const MAP = 'map';                // the cluster's centre map area (the service's default target)
const FRESH_MS = 2000;            // a waiting layer whose frames moved this recently is still drawing

/** loadClient()'s reasons in the apps' usual words (an app may pass its own) */
const TEXTS = {
    noclient: 'Cluster renderer client missing - update the tool',
    missing: 'Cluster renderer not installed (Store)',
    untrusted: 'Cluster renderer client not trusted',
};

/* ----- the client ----- */

/** A root-owned file nobody else may write, in a directory with the same properties. */
function trusted(file) {
    try {
        const real = fs.realpathSync(file);
        const st = fs.statSync(real), dir = fs.statSync(path.dirname(real));
        return st.isFile() && st.uid === 0 && !(st.mode & 0o022) && dir.uid === 0 && !(dir.mode & 0o022);
    } catch (e) { return false; }
}

const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

/**
 * The tool's client { ClusterRender, sock }, or { error, text } why not:
 *   missing: neither the client nor the socket (the tool isn't installed)
 *   noclient: the socket but no client file (an old or broken install)
 *   untrusted: not a root-owned file only root can write
 *   load: it threw or isn't the expected module
 * opts: client / sock / testing (tests). texts: the app's own words for TEXTS' reasons.
 */
function loadClient(opts, texts) {
    const o = opts || {}, t = Object.assign({}, TEXTS, texts);
    const file = o.client || CLIENT, sock = o.sock || SOCK, testing = o.testing !== undefined ? o.testing : TESTING;
    if (!exists(file)) {
        return exists(sock) ? { error: 'noclient', text: t.noclient } : { error: 'missing', text: t.missing };
    }
    if (!testing && !trusted(file)) return { error: 'untrusted', text: t.untrusted };
    try {
        const m = require(file);
        if (!m || typeof m.ClusterRender !== 'function') return { error: 'load', text: 'Cluster renderer client not recognised' };
        return { ClusterRender: m.ClusterRender, sock: o.sock || process.env.NG_CR_SOCK || m.DEFAULT_PATH || SOCK };
    } catch (e) {
        return { error: 'load', text: 'Cluster renderer client failed to load', detail: e.message };
    }
}

/* ----- the map's layers, from the status text ----- */

/**
 * The other apps' layers on the target (the map) in a status text: [{ id, kind, app, klass, z, state, frames }].
 * frames: the layer's own counter from its stats line (video "N sent", image "N writes"), -1 if none.
 */
function mapLayers(text, ownApp, target) {
    const tg = target || MAP;
    const out = [];
    let last = null;
    String(text || '').split('\n').forEach((line) => {
        if (last && /^\s/.test(line)) {
            const f = /^\s+(\d+) (sent|writes)\b/.exec(line);
            if (f) last.frames = +f[1];
            return;
        }
        last = null;
        const m = /^layer (\d+) (\w+) of (\S+) on (\w+), (\w+) z (-?\d+): (\w+)/.exec(line);
        if (!m || m[4] !== tg || m[3] === ownApp) return;
        last = { id: +m[1], kind: m[2], app: m[3], klass: m[5], z: +m[6], state: m[7], frames: -1 };
        out.push(last);
    });
    return out;
}

/** Our own layers on the target (the map) in the status text: [{ id, state }]. */
function ownLayers(text, ownApp, target) {
    const tg = target || MAP;
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        const m = /^layer (\d+) \w+ of (\S+) on (\w+), \w+ z -?\d+: (\w+)/.exec(line);
        if (m && m[3] === tg && m[2] === ownApp) out.push({ id: +m[1], state: m[4] });
    });
    return out;
}

/**
 * Whether a layer from mapLayers is drawing: shown (a video one with a frame sent), or waiting /
 * suspended with its frame counter advancing (within FRESH_MS). seen: { key -> { frames, at } } from
 * earlier polls, updated here; now: ms.
 */
function drawing(l, seen, now) {
    const key = l.app + '#' + l.id, was = seen[key];
    let at = was ? was.at : -1e15;
    if (l.frames > 0 && (!was || l.frames !== was.frames)) at = now;   // first seen with frames, or moved
    seen[key] = { frames: l.frames, at };
    if (l.state === 'shown') return !(l.kind === 'video' && l.frames === 0);
    if (l.state === 'waiting' || l.state === 'suspended') return now - at < FRESH_MS;
    return false;                                                        // stalled, hidden, error
}

/* ----- route guidance ----- */

/**
 * A guidance signal's value -> true (guiding), false, or null (not understood). guidingState: the enum
 * GuidingState (INACTIVE 0, CALCULATING_ROUTE 1, ACTIVE 2), by number or name; projectedGuidanceActive:
 * a Bool. A struct is searched for its first such member.
 */
function guideValue(src, v) {
    if (v && typeof v === 'object') {
        const k = Object.keys(v).find((x) => typeof v[x] === 'number' || typeof v[x] === 'boolean' || typeof v[x] === 'string');
        return k === undefined ? null : guideValue(src, v[k]);
    }
    if (src === 'nav') {
        if (typeof v === 'number') return v === 2;
        if (typeof v === 'string') return /^(\d+|[A-Z_]+)$/i.test(v) ? (v === '2' || /^active$/i.test(v)) : null;
        return null;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^(true|1)$/i.test(v) ? true : /^(false|0)$/i.test(v) ? false : null;
    return null;
}

module.exports = { CLIENT, SOCK, TESTING, MAP, FRESH_MS, TEXTS, trusted, exists, loadClient, mapLayers, ownLayers, drawing, guideValue };
