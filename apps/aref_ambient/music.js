'use strict';
/**
 * music.js - Cabin Light's Music mode: the ambient light moves with the song's beat.
 *
 * The car doesn't hand apps the sound, so the beats come from the owner's homelab (beat_map.py): for each song, the
 * beat times, how hard each one hits (0-1), the bar starts and the loud / quiet stretches, copied into this app's
 * data folder as beats/<key>.json (key: Car Lyrics' lyrics key, title + main artist). The song and where it is come
 * from the car's media player (Car Lyrics' nowplaying.js), followed with a clock between the car's updates.
 *
 * level(t) -> null (no beat map, paused, Music off) or { k, hue } for the moment t (ms epoch): k = the brightness
 * factor (0-1) for the light at that moment, hue = degrees to turn the colour by (parked flashes change colour each
 * bar). Driving: a soft pulse, never under 55 % of the look's brightness and no colour change. Parked: full flashes.
 * A light write takes ~200 ms through the head unit's gateway: lights.js asks for the moment its frame lands.
 *
 *   const m = new Music({ signals, log, dataDir, settings, moving: () => bool|null }); m.start();
 *   m.level(Date.now() + 300)      m.state() -> { song, bpm, beats, playing } for the screen
 */
const fs = require('fs');
const path = require('path');
const NP = require('./nowplaying');
const LyricsLib = require('./lyrics');

const IFACES = [
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
    { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
    { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instances: [] },
    { iface: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', instances: [] },
];
const NUDGE = 0.3, SNAP_MS = 1500, HOLD_MS = 4000;   // the song clock (as Car Lyrics')
const DECAY_DRIVE = 260, DECAY_PARK = 200;           // ms for a beat's light to fall back
const FLOOR_DRIVE = 0.55, FLOOR_PARK = 0.06;         // the dimmest the light gets between beats

class Music {
    constructor(o) {
        this.signals = o.signals; this.log = o.log; this.settings = o.settings; this.moving = o.moving || (() => null);
        this.dir = path.join(o.dataDir || '/tmp', 'beats');
        this.np = null; this.cur = null; this.clk = null; this.map = null; this.mapKey = null;
    }

    start() {
        this.np = new NP.NowPlaying(this.signals, this.log, IFACES);
        this.np.onChange(() => { try { this._follow(); } catch (e) { this.log.warn('music: ' + e.message); } });
        return this.np.start().catch((e) => this.log.warn('music: now playing: ' + e.message));
    }

    on() { return (this.settings.get('music') || 'off') !== 'off'; }

    _follow() {
        const t = this.np.track();
        if (!t) return;
        const key = t.title + '|' + t.artist;
        if (!this.cur || this.cur.key !== key) {
            this.cur = { key, title: t.title, artist: t.artist };
            this.clk = null;
            this._load();
        }
        const playing = t.direct ? !!t.playing : true;
        this.cur.playing = playing;
        if (t.position === null || t.position === undefined) return;
        const at = t.positionAt || Date.now();
        const c = this.clk;
        if (!c) { this.clk = { pos: t.position, at, playing, last: t.position }; return; }
        if (t.position === c.last && playing === c.playing) return;
        const pred = this._clockAt(at), gap = t.position - pred;
        c.pos = !playing || !c.playing || Math.abs(gap) > SNAP_MS ? t.position : pred + gap * NUDGE;
        c.at = at; c.playing = playing; c.last = t.position;
    }

    _clockAt(t) { const c = this.clk; return c.pos + (c.playing ? Math.min(t - c.at, HOLD_MS) : 0); }

    /** the song's beat map from the data folder (the homelab copies new ones in: looked for again each minute) */
    _load() {
        const key = LyricsLib.Lyrics.diskKey({ title: this.cur.title, artist: this.cur.artist });
        this.mapKey = key; this.map = null; this.loadedAt = Date.now();
        try {
            const m = JSON.parse(fs.readFileSync(path.join(this.dir, key + '.json'), 'utf8'));
            if (m && Array.isArray(m.beats) && m.beats.length > 8) {
                // very fast tempos (a beat tracker often counts double): every other beat, so the lights don't race
                const every = m.bpm > 140 ? 2 : 1;
                this.map = { bpm: m.bpm / every, beats: m.beats.filter((_, i) => i % every === 0), hit: (m.hit || []).filter((_, i) => i % every === 0),
                    bar: (m.bar || []).filter((_, i) => i % every === 0), loud: m.loud || [] };
                let n = 0;
                this.map.bars = this.map.beats.map((_, i) => (n += this.map.bar[i] ? 1 : 0));   // bars started by each beat
                this.log.info('music: "' + this.cur.title + '" ' + this.map.bpm + ' BPM, ' + this.map.beats.length + ' beats');
            } else this.log.info('music: no beat map for "' + this.cur.title + '" yet');
        } catch (e) { this.log.info('music: no beat map for "' + this.cur.title + '" yet'); }
    }

    /** the light at moment t (ms epoch): { k, hue } or null */
    level(t) {
        if (!this.on() || !this.cur || !this.clk || !this.cur.playing) return null;
        if (!this.map) { if (Date.now() - (this.loadedAt || 0) > 60000) this._load(); return null; }
        const pos = this._clockAt(t), b = this.map.beats;
        // the last beat at or before pos (binary search)
        let lo = 0, hi = b.length - 1;
        if (pos < b[0] || pos > b[hi] + 2000) return null;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= pos) lo = mid; else hi = mid - 1; }
        const dt = pos - b[lo], hit = this.map.hit[lo] == null ? 0.7 : this.map.hit[lo];
        const sec = this.map.loud.find((s) => pos >= s[0] && pos < s[1]);
        const loud = sec ? 0.4 + 0.6 * sec[2] : 1;                       // quiet stretches: gentler
        const parked = this.moving() === false && this.settings.get('music') === 'flash';
        const decay = Math.exp(-dt / (parked ? DECAY_PARK : DECAY_DRIVE));
        const floor = parked ? FLOOR_PARK : FLOOR_DRIVE;
        const k = floor + (1 - floor) * Math.min(1, hit * loud * 1.15) * decay;
        // parked: the colour turns 40 degrees each bar
        const bars = this.map.bars[lo] || 0;
        return { k: Math.max(0, Math.min(1, k)), hue: parked ? (bars * 40) % 360 : 0 };
    }

    /**
     * The light changes for the beats between two moments (ms epoch), for a writer that takes writeMs a write and
     * does one at a time: [{ at (epoch: when it should show), bus (0, 1, or null: both), k (0-1), hue }]. Each beat:
     * the light up at the beat, back down half a beat later. A beat long enough for four writes: both sides; else
     * the sides take turns (left on one beat, right on the next), so every beat still shows.
     */
    plan(from, to, writeMs) {
        if (!this.on() || !this.cur || !this.clk || !this.cur.playing || !this.map) return [];
        const p0 = this._clockAt(from), off = from - p0;          // song ms -> epoch: + off
        const b = this.map.beats, out = [], period = 60000 / this.map.bpm;
        const both = period >= 4 * writeMs;
        const parked = this.moving() === false && this.settings.get('music') === 'flash';
        const floor = parked ? FLOOR_PARK : FLOOR_DRIVE;
        for (let i = 0; i < b.length; i++) {
            const at = b[i] + off;
            if (at < from - 50) continue;
            if (at > to) break;
            const hit = this.map.hit[i] == null ? 0.7 : this.map.hit[i];
            const sec = this.map.loud.find((x) => b[i] >= x[0] && b[i] < x[1]);
            const loud = sec ? 0.4 + 0.6 * sec[2] : 1;
            const k = floor + (1 - floor) * Math.min(1, hit * loud * 1.15);
            const hue = parked ? ((this.map.bars[i] || 0) * 40) % 360 : 0;
            const bus = both ? null : i % 2;
            out.push({ at: at, bus: bus, k: k, hue: hue, beat: i });
            out.push({ at: at + period * 0.5, bus: bus, k: floor, hue: hue, beat: i, down: true });
        }
        return out;
    }

    state() {
        return { song: this.cur ? this.cur.title + ' - ' + this.cur.artist : null, bpm: this.map ? this.map.bpm : null,
            beats: this.map ? this.map.beats.length : 0, playing: !!(this.cur && this.cur.playing), on: this.on() };
    }
}

module.exports = { Music };
