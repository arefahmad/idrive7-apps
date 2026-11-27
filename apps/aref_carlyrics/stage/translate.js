'use strict';
/**
 * translate.js - live lyrics translation, like Apple Music's, for songs not in English.
 *
 * When a song with synced lyrics starts and its lines aren't mostly English (and the lyrics file has no translation
 * yet), the lines go to the owner's homelab (POST /api/lyrics/translate, its own translate-only key), which has
 * Claude translate the song and hands lines back as they're written: polled every 1.5 s, the first ones in ~2-3 s,
 * the song in ~10-15 s. Each line gets l.tr (English) and l.ro (pronunciation in Latin letters, for non-Latin
 * scripts); the result is saved into the song's lyrics file on disk, so it's there offline next time.
 *
 * Config: <data>/translate.json { host, path, key }, copied here by the homelab. No file: nothing is sent.
 * Node 8. Never throws out.
 */
const fs = require('fs');
const path = require('path');

const POLL_MS = 1500, GIVE_UP_MS = 90000, RETRY_MS = 10 * 60 * 1000, DISK_RECHECK_MS = 30000;
const ENGLISH = new Set(("the a an and i you me my your it is are was be to of in on for with that this what we he she they " +
    "not no do dont don't im i'm can just like love know all so but oh yeah baby when if up down").split(' '));
const SCRIPTS = /[֐-ࣿЀ-ӿͰ-Ͽ぀-ヿ一-鿿가-힯]/;

/** Mostly not English: any non-Latin letters, or under a quarter of the words are common English ones. */
function foreign(texts) {
    const all = texts.join(' ');
    if (SCRIPTS.test(all)) return true;
    const words = all.toLowerCase().match(/[a-z']+/g) || [];
    if (words.length < 8) return false;
    return words.filter((w) => ENGLISH.has(w)).length / words.length < 0.25;
}

class Translator {
    /** request(method, host, path, headers, body) -> Promise<{status, body}>; dir: the lyrics folder (diskKey files) */
    constructor(request, log, dataDir, lyricsDir, diskKey) {
        this.request = request; this.log = log; this.lyricsDir = lyricsDir; this.diskKey = diskKey;
        this.cfgFile = path.join(dataDir, 'translate.json');
        this.done = new WeakSet();       // lines arrays already handled
        this.failed = new Map();         // song key -> when it last failed
        this.busy = null;
        this.ver = 0;                    // bumped when lines get translations (the screen lays out again)
        this.diskAt = new Map();         // song key -> when its file was last looked at
    }

    cfg() {
        try { const c = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8')); return c && c.host && c.key ? c : null; } catch (e) { return null; }
    }

    /** Called each frame with the playing song and its lyrics entry: starts a translation when one is due. */
    want(track, entry, online) {
        if (!entry || entry.state !== 'synced' || !entry.lines || this.done.has(entry.lines) || this.busy) return;
        const lines = entry.lines.filter((l) => l.text);
        if (!lines.length || lines.some((l) => l.tr || l.ro)) { this.done.add(entry.lines); return; }   // from the file already
        if (!foreign(lines.map((l) => l.text))) { this.done.add(entry.lines); return; }
        const key = track.title + '|' + track.artist;
        // the homelab may have copied a translated file in since these lyrics were read: that first, no network
        if (Date.now() - (this.diskAt.get(key) || 0) > DISK_RECHECK_MS) {
            this.diskAt.set(key, Date.now());
            if (this._fromDisk(track, entry)) { this.done.add(entry.lines); return; }
        }
        if (Date.now() - (this.failed.get(key) || 0) < RETRY_MS || !online) return;
        const c = this.cfg();
        if (!c) return;                 // no key here yet (the homelab copies it in): looked at again next time
        this.busy = this._run(c, track, entry, lines, key).catch((e) => { this.failed.set(key, Date.now()); this.log.warn('translate: ' + e.message); })
            .then(() => { this.busy = null; });
    }

    async _run(c, track, entry, lines, key) {
        const body = JSON.stringify({ title: track.title, artist: track.artist, lines: lines.map((l) => ({ t: l.t, text: l.text })) });
        const t0 = Date.now();
        let r = null, first = 0;
        while (Date.now() - t0 < GIVE_UP_MS) {
            const res = await this.request('POST', c.host, c.path || '/api/lyrics/translate', { 'Content-Type': 'application/json', 'X-Lyrics-Key': c.key }, body);
            if (res.status !== 200) throw new Error('homelab HTTP ' + res.status);
            r = JSON.parse(res.body.toString('utf8'));
            const n = this._apply(entry, r);
            if (n && !first) { first = Date.now() - t0; this.log.info('translate: first lines after ' + first + ' ms (' + (r.language || '?') + ')'); }
            if (r.done) break;
            await new Promise((ok) => setTimeout(ok, POLL_MS));
        }
        this.done.add(entry.lines);
        if (!r || !r.done) throw new Error('not finished in ' + GIVE_UP_MS / 1000 + ' s');
        const n = Object.keys(r.translation || {}).length;
        this.log.info('translate: "' + track.title + '" ' + (r.language || '?') + ', ' + n + ' lines in ' + (Date.now() - t0) + ' ms');
        if (n || Object.keys(r.romanization || {}).length) this._save(track, r);
    }

    /** the song's lyrics file on disk, if it has a translation now: put on the lines (true) */
    _fromDisk(track, entry) {
        try {
            const rec = JSON.parse(fs.readFileSync(path.join(this.lyricsDir, this.diskKey(track) + '.json'), 'utf8'));
            if (!rec || !(rec.translation && Object.keys(rec.translation).length) && !(rec.romanization && Object.keys(rec.romanization).length)) return false;
            const n = this._apply(entry, { translation: rec.translation, romanization: rec.romanization });
            const ro = entry.lines.filter((l) => l.ro).length;
            this.log.info('translate: "' + track.title + '" from its file (' + n + ' lines, ' + ro + ' pronounced)');
            // a file whose translation is for another version (other line times) matches no line: asked for live instead
            return n > 0 || ro > 0;
        } catch (e) { return false; }
    }

    /** puts what's arrived on the lines; returns how many lines have a translation */
    _apply(entry, r) {
        const tr = r.translation || {}, ro = r.romanization || {};
        let n = 0, changed = false;
        entry.lines.forEach((l) => {
            const k = String(l.t);
            if (tr[k] && l.tr !== tr[k]) { if (!l.tr) l.trAt = Date.now(); l.tr = tr[k]; changed = true; }   // trAt: it fades in
            if (ro[k] && l.ro !== ro[k]) { l.ro = ro[k]; changed = true; }
            if (l.tr) n++;
        });
        if (changed) this.ver++;
        return n;
    }

    /** into the song's lyrics file, as the homelab's pack has it: offline next time */
    _save(track, r) {
        if (!this.lyricsDir) return;
        try {
            const f = path.join(this.lyricsDir, this.diskKey(track) + '.json');
            const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
            rec.translation = r.translation || {}; rec.romanization = r.romanization || {}; rec.translationLanguage = r.language || '';
            fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f);   // (renamed over: works on a read-only copy too)
        } catch (e) { this.log.warn('translate: not saved: ' + e.message); }
    }
}

module.exports = { Translator, foreign };
