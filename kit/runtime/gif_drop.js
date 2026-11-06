'use strict';
/**
 * gif_drop.js - a GIF from the phone to the car, for an app's home-screen widget (widget_anim.js), end-to-end
 * encrypted through a mailbox, as G's TV's Add source (apps/ng_tv/sources/tv_handoff.js). Node 8, no npm modules.
 *
 *   car                                  phone: the static page web/widget/ (gh-pages /widget/)        mailbox (ntfy.sh)
 *   topic + key (random) ---QR--->       <page>#v=1&s=<topic>.<key>&a=<app name>&w=<px>&h=<px>
 *   or a 6-digit code ---typed--->       <page> (no fragment): the code -> topic + key (PBKDF2)
 *                                        a GIF from the phone, Fill or Fit -> Send
 *                                        iv | AES-256-GCM(key, gif)            --PUT, an attachment--> <topic>
 *                                        AES-256-GCM(key, {t:'gif', s, url, size, sha256, fit, name}) --POST--> <topic>
 *   polls both topics (one request) <------------------------------------------------------------------
 *   downloads url: https on the mailbox's own host only, exactly `size` bytes, the SHA-256 the sealed
 *   message names, then decrypted (AES-GCM checks it again) and checked to be a GIF
 *   {t:'got'} --> phone: "the car has it"; the app prepares it and shows it, the driver taps Use or Cancel
 *   {t:'done', ok, error} --> phone: "On the widget" / "Not used: <why>"
 *
 * The QR code carries a random 256-bit key in its fragment (never sent to a server). The 6-digit code is the
 * fallback for a phone that cannot scan: topic and key come from the code through PBKDF2-SHA256 (100 000
 * rounds, salt "ng_widget/code/1"), as strong as a 6-digit number for the 10 minutes a code lives; what it
 * protects is a picture the driver sends on purpose and sees on the car before it is used. The mailbox
 * only ever holds ciphertext; ntfy.sh deletes attachments after a few hours.
 *
 * net: an object with request(method, href, headers, body, maxBody) -> { status, body } (apps/ng_tv/net/tv_net.js:
 * the uplink's DNS, the unit's TLS roots); cfg: { relay (the phone page, https), mailbox, title, w, h }.
 */
const crypto = require('crypto');
const URL = require('url').URL;

const AAD = Buffer.from('ng_widget/1');              // the sealed messages
const AAD_FILE = Buffer.from('ng_widget/1/gif');     // the sealed GIF (so a message can't pass for a file)
const LIFETIME = 10 * 60 * 1000;
const POLL_MS = 4000;                                // both topics in one request; ntfy.sh's anonymous limit refills one per 5 s after 60
const CODE_SALT = 'ng_widget/code/1';
const CODE_ROUNDS = 100000;
const MAX_GIF = 8 * 1024 * 1024;                     // the phone page's limit too (ntfy.sh takes 15 MB attachments)
const SEAL = 12 + 16;                                // iv and tag around the GIF
const TOPIC = /^[A-Za-z0-9_-]{16,64}$/;
const FITS = ['cover', 'contain'];

function b64u(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64u(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}
function mailboxOf(m) {
    let u;
    try { u = new URL(String(m || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !u.hostname || u.port || u.search || u.hash || u.username) return null;
    return { host: u.hostname, href: 'https://' + u.hostname + (u.pathname || '/').replace(/\/+$/, '') };
}
/** Six random digits (no modulo bias). */
function newCode(rand) {
    rand = rand || crypto.randomBytes;
    for (;;) {
        const n = rand(4).readUInt32BE(0);
        if (n < 4294000000) return String(n % 1000000 + 1000000).slice(1);
    }
}
/** code -> { topic, key } (what the phone page does with WebCrypto). */
function fromCode(code, cb) {
    crypto.pbkdf2(String(code), CODE_SALT, CODE_ROUNDS, 48, 'sha256', (err, b) => {
        if (err) { cb(err); return; }
        cb(null, { topic: 'ngwc_' + b64u(b.slice(0, 16)), key: b.slice(16, 48) });
    });
}
function seal(key, obj, iv) {
    iv = iv || crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return b64u(Buffer.concat([iv, ct, c.getAuthTag()]));
}
function open(key, s) {
    const b = fromB64u(String(s || '').trim());
    if (b.length < 12 + 16 + 2 || b.length > 8192) throw new Error('size');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.slice(0, 12));
    d.setAAD(AAD);
    d.setAuthTag(b.slice(b.length - 16));
    return JSON.parse(Buffer.concat([d.update(b.slice(12, b.length - 16)), d.final()]).toString('utf8'));
}
/** iv | ciphertext | tag (the phone's attachment) -> the GIF; throws when it was not sealed with key. */
function openFile(key, b) {
    if (b.length < SEAL + 6) throw new Error('size');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.slice(0, 12));
    d.setAAD(AAD_FILE);
    d.setAuthTag(b.slice(b.length - 16));
    return Buffer.concat([d.update(b.slice(12, b.length - 16)), d.final()]);
}
function sealFile(key, gif, iv) {
    iv = iv || crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(AAD_FILE);
    return Buffer.concat([iv, c.update(gif), c.final(), c.getAuthTag()]);
}
function messages(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
        line = line.trim();
        if (!line) return;
        try { const m = JSON.parse(line); if (m && m.event === 'message' && typeof m.message === 'string' && typeof m.id === 'string') out.push(m); } catch (e) { /* skip */ }
    });
    return out;
}
function cleanName(s) {
    return String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
}
/** The sealed message's attachment, checked: { url, size, sha } or a reason string. */
function checkFile(p, mailbox) {
    let u;
    try { u = new URL(String(p.url || '')); } catch (e) { return 'no link to the GIF'; }
    if (u.protocol !== 'https:' || u.hostname !== mailbox.host || u.port || u.username || u.password || u.pathname.indexOf('/file/') !== 0) return 'the GIF is not on the mailbox';
    const size = Number(p.size);
    if (!(size > SEAL && size <= MAX_GIF + SEAL && Math.floor(size) === size)) return 'the GIF is too big (at most ' + MAX_GIF / 1048576 + ' MB)';
    if (typeof p.sha256 !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.sha256)) return 'no checksum for the GIF';
    return { url: u.href, size, sha: p.sha256 };
}

/**
 * The car's side. phase: off | waiting | downloading | got | error. got: { gif, fit, name, viaCode } once the
 * phone's GIF is here (tick() resolves it once); message: a short line about the mailbox or the download.
 */
class GifDrop {
    constructor(net, log, cfg) {
        this.net = net; this.log = log; this.cfg = cfg || {};
        this.mailbox = mailboxOf(this.cfg.mailbox || 'https://ntfy.sh');
        this.s = null; this.phase = 'off'; this.message = ''; this.got = null; this.size = 0;
        this._next = 0; this._busy = false;
    }
    configured() { return /^https:\/\/[^/#?]+/.test(this.cfg.relay || '') && !!this.mailbox && !!(this.net && this.net.request); }
    active() { return this.phase === 'waiting' || this.phase === 'downloading'; }
    /** A new QR code and 6-digit code. */
    start(rand) {
        rand = rand || crypto.randomBytes;
        const topic = 'ngw_' + b64u(rand(16)), key = rand(32), code = newCode(rand);
        const q = ['v=1', 's=' + topic + '.' + b64u(key)];
        if (this.cfg.title) q.push('a=' + b64u(Buffer.from(String(this.cfg.title).slice(0, 40), 'utf8')));
        if (this.cfg.w && this.cfg.h) q.push('w=' + (this.cfg.w | 0), 'h=' + (this.cfg.h | 0));
        const s = { topic, key, code, url: this.cfg.relay + '#' + q.join('&'), started: Date.now(), since: 'all', seen: {}, codeTopic: '', codeKey: null };
        this.s = s; this.phase = 'waiting'; this.message = ''; this.got = null; this.size = 0; this._next = 0;
        fromCode(code, (err, d) => { if (!err && this.s === s) { s.codeTopic = d.topic; s.codeKey = d.key; } });
        this.log.info('gif drop: started');
        return s;
    }
    cancel() { this.s = null; this.phase = 'off'; this.message = ''; this.got = null; }
    expired() { return !!this.s && this.phase === 'waiting' && Date.now() - this.s.started > LIFETIME; }
    left() { return this.s ? Math.max(0, LIFETIME - (Date.now() - this.s.started)) : 0; }
    codeText() { return this.s ? this.s.code.slice(0, 3) + ' ' + this.s.code.slice(3) : ''; }

    /** Call often: polls every POLL_MS while waiting; resolves { gif, fit, name, viaCode } once, when it is here. */
    async tick() {
        if (this.phase !== 'waiting' || this._busy || Date.now() < this._next || !this.s) return null;
        this._busy = true; this._next = Date.now() + POLL_MS;
        const s = this.s;
        try {
            const topics = s.topic + (s.codeTopic ? ',' + s.codeTopic : '');
            const r = await this.net.request('GET', this.mailbox.href + '/' + topics + '/json?poll=1&since=' + encodeURIComponent(s.since), {}, null, 256 * 1024);
            if (s !== this.s) return null;
            if (r.status === 429) { this._next = Date.now() + 30000; this.message = 'Mailbox busy, waiting'; return null; }
            if (r.status !== 200) { this.message = 'Mailbox: HTTP ' + r.status; return null; }
            this.message = '';
            const list = messages(r.body.toString('utf8'));
            for (let i = 0; i < list.length; i++) {
                const m = list[i];
                if (s.seen[m.id]) continue;
                s.seen[m.id] = 1; s.since = m.id;
                const viaCode = m.topic === s.codeTopic && !!s.codeKey;
                const key = viaCode ? s.codeKey : s.key, topic = viaCode ? s.codeTopic : s.topic;
                let p;
                try { p = open(key, m.message); } catch (e) { continue; }          // not ours (the attachment's own note), or tampered
                if (!p || p.s !== topic || p.t !== 'gif' || p.from === 'car') continue;
                this.got = { topic, key, viaCode };                                  // where to answer, even when it fails
                const f = checkFile(p, this.mailbox);
                if (typeof f === 'string') { this._fail(f); return null; }
                return await this._fetch(s, f, p, viaCode);
            }
        } catch (e) {
            if (s === this.s && this.phase === 'waiting') this.message = 'No connection to the mailbox (' + (e.code || e.message) + ')';
        } finally { this._busy = false; }
        return null;
    }
    async _fetch(s, f, p, viaCode) {
        this.phase = 'downloading'; this.size = f.size; this.message = '';
        this.log.info('gif drop: the phone sent a GIF (' + Math.round(f.size / 1024) + ' KB, ' + (viaCode ? 'code' : 'QR') + ')');
        let r;
        try { r = await this.net.request('GET', f.url, {}, null, f.size + 1); } catch (e) {
            if (s === this.s) this._fail('could not download the GIF (' + (e.code || e.message) + ')');
            return null;
        }
        if (s !== this.s) return null;
        if (r.status !== 200) { this._fail('could not download the GIF (HTTP ' + r.status + ')'); return null; }
        const body = r.body;
        if (body.length !== f.size || b64u(crypto.createHash('sha256').update(body).digest()) !== f.sha) { this._fail('the GIF arrived damaged'); return null; }
        let gif;
        try { gif = openFile(this.got.key, body); } catch (e) { this._fail('the GIF could not be decrypted'); return null; }
        if (gif.length < 6 || gif.toString('latin1', 0, 4) !== 'GIF8') { this._fail('that file is not a GIF'); return null; }
        Object.assign(this.got, { gif, fit: FITS.indexOf(p.fit) >= 0 ? p.fit : 'cover', name: cleanName(p.name) });
        this.phase = 'got';
        this.ack({ t: 'got' });
        return this.got;
    }
    _fail(why) {
        this.log.warn('gif drop: ' + why);
        this.phase = 'error'; this.message = why;
        this.ack({ t: 'done', ok: false, error: why.charAt(0).toUpperCase() + why.slice(1) + '.' });
    }
    /** Tell the phone ({ t: 'got' } or { t: 'done', ok, error }). */
    ack(obj) {
        const g = this.got;
        if (!g || !this.net.request) return;
        obj.s = g.topic; obj.from = 'car';
        this.net.request('POST', this.mailbox.href + '/' + g.topic, { 'Content-Type': 'text/plain' }, seal(g.key, obj), 65536)
            .then(() => {}, (e) => this.log.warn('gif drop: could not tell the phone (' + (e.code || e.message) + ')'));
    }
}

module.exports = { GifDrop, seal, open, sealFile, openFile, fromCode, newCode, messages, b64u, fromB64u, checkFile, AAD, AAD_FILE, LIFETIME, CODE_SALT, CODE_ROUNDS, MAX_GIF };
