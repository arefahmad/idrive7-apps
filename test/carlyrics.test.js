'use strict';
// Plain-Node tests for Car Lyrics' track finder and lyrics parsing (not installed on the car).
//   node test/carlyrics.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '..', 'apps', 'aref_carlyrics');
const NP = require(path.join(APP, 'car', 'nowplaying.js'));
const L = require(path.join(APP, 'stage', 'lyrics.js'));
// app modules require each other as './name' (installed side by side on the car)
const Module = require('module');
const resolve0 = Module._resolveFilename;
const FLAT = { './lyrics': path.join(APP, 'stage', 'lyrics.js'), './jpeg_decoder': path.join(APP, 'vendor', 'jpeg_decoder.js') };
Module._resolveFilename = function (req) { return FLAT[req] || resolve0.apply(this, arguments); };
const ART = require(path.join(APP, 'art', 'artwork.js'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a struct with title, artist, album and duration (s)', () => {
    const t = NP.trackIn('nowPlayingInfo', { songTitle: 'Blinding Lights', artistName: 'The Weeknd', albumTitle: 'After Hours', duration: 200 });
    assert.strictEqual(t.title, 'Blinding Lights');
    assert.strictEqual(t.artist, 'The Weeknd');
    assert.strictEqual(t.album, 'After Hours');
    assert.strictEqual(t.duration, 200000);
});

test('nested metadata, duration in ms, position in ms', () => {
    const t = NP.trackIn('mediaInfo', { meta: { title: 'Song', artist: 'Artist' }, playback: { totalDuration: 215000, position: 12000 } });
    assert.strictEqual(t.title, 'Song');
    assert.strictEqual(t.duration, 215000);
    assert.strictEqual(t.position, 12000);
});

test('a plain string field named like a title', () => {
    const t = NP.trackIn('currentTitle', 'Only Title');
    assert.strictEqual(t.title, 'Only Title');
    assert.strictEqual(t.artist, '');
});

test('album and station names are not titles', () => {
    assert.strictEqual(NP.trackIn('x', { albumTitle: 'An Album', stationName: 'WXYZ' }), null);
    assert.strictEqual(NP.trackIn('appTitle', 'CarPlay'), null);
});

test('instances from arrays, objects and strings', () => {
    assert.deepStrictEqual(NP.instancesOf({ instances: ['A', 'B'] }, ['A']), ['A', 'B']);
    assert.deepStrictEqual(NP.instancesOf({ instances: { X: 1 } }, ['Y']), ['X', 'Y']);
    assert.deepStrictEqual(NP.instancesOf({ instances: '*' }, ['CarPlayManagerInst1']), ['CarPlayManagerInst1']);
    assert.deepStrictEqual(NP.fieldsOf({ fields: { a: {}, b: {} } }), ['a', 'b']);
});

test('NowPlaying picks the best track among every field and follows a position field', async () => {
    const signals = {
        loadConfig: () => ({ instances: ['Inst1'], fields: { appState: {}, nowPlaying: {}, playbackPosition: {} } }),
        watch: async (iface, inst, handlers) => {
            handlers.appState({ title: 'CarPlay' });          // not a song: "title" alone, no artist
            handlers.nowPlaying({ title: 'Levitating', artist: 'Dua Lipa', duration: 203 });
            handlers.playbackPosition(42);
            return { available: true, error: null };
        },
    };
    const log = { info() {}, warn() {}, error() {} };
    const np = new NP.NowPlaying(signals, log, [{ iface: 'de.bmw.x.CarPlayManager', instances: [] }]);
    await np.start();
    const t = np.track();
    assert.strictEqual(t.title, 'Levitating');
    assert.strictEqual(t.artist, 'Dua Lipa');
    assert.strictEqual(t.duration, 203000);
    assert.strictEqual(t.position, 42000);
    assert.ok(np.values().length >= 3);
    np.stop();
});

test('the catalog search finds media interfaces first', () => {
    const f = path.join(os.tmpdir(), 'carlyrics-catalog.json');
    fs.writeFileSync(f, JSON.stringify({ interfaces: {
        'de.bmw.infotainment.vehicle.Vehicle2': { attributes: { statusCarSpeed2: {} } },
        'de.bmw.infotainment.hmi.Something': { attributes: { windowTitle: {} } },
        'de.bmw.infotainment.a4a.carplay.CarPlayManager': { attributes: { nowPlayingMetadata: {}, artistName: {} } },
    } }));
    const r = NP.scanCatalog(f);
    assert.strictEqual(r.error, '');
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.hits[0].iface, 'de.bmw.infotainment.a4a.carplay.CarPlayManager');
    assert.ok(r.hits.length === 2);
    assert.ok(NP.scanCatalog('/nonexistent').error);
});

test('positions in seconds or ms against the duration', () => {
    assert.strictEqual(NP.posMs(42, 203000), 42000);
    assert.strictEqual(NP.posMs(150000, 203000), 150000);
    assert.strictEqual(NP.trackIn('x', { title: 'A', artist: 'B', duration: 200, position: 30 }).position, 30000);
});

test('BMW-style metadata lists, item time, and previous/next items skipped', async () => {
    const t = NP.trackIn('currentItemMetadata', [{ type: 'TITLE', value: 'Real Song' }, { type: 'ARTIST', value: 'Real Artist' }, { type: 'ALBUM', value: 'LP' }]);
    assert.strictEqual(t.title, 'Real Song');
    assert.strictEqual(t.artist, 'Real Artist');
    assert.strictEqual(t.album, 'LP');
    const signals = {
        loadConfig: () => ({ instances: ['AndroidAutoProjected', 'CarPlayProjected'], fields: { nextItemMetadata: {}, currentItemMetadata: {}, currentItemTime: {} } }),
        watch: async (iface, inst, h) => {
            if (inst === 'CarPlayProjected') {
                h.nextItemMetadata([{ type: 'TITLE', value: 'Next One' }, { type: 'ARTIST', value: 'Someone' }]);
                h.currentItemMetadata([{ type: 'TITLE', value: 'Now Song' }, { type: 'ARTIST', value: 'Now Artist' }]);
                h.currentItemTime({ elapsed: 30, total: 200 });
            }
            return { available: true };
        },
    };
    const np = new NP.NowPlaying(signals, { info() {}, warn() {}, error() {} }, [{ iface: 'x.MediaPlayer', instances: [] }]);
    await np.start();
    const tr = np.track();
    np.stop();
    assert.strictEqual(tr.title, 'Now Song');
    assert.strictEqual(tr.position, 30000);
    assert.strictEqual(tr.duration, 200000);
    assert.deepStrictEqual(NP.instancesOf({ instances: ['Usb1', 'AndroidAutoProjected', 'Bluetooth1', 'CarPlayProjected'] }), ['AndroidAutoProjected', 'CarPlayProjected', 'Bluetooth1', 'Usb1']);
});

test('CarPlayMedia metadata as a real iDrive 7 sends it (key, value.stringValue)', async () => {
    const meta = [
        { key: 'GENRE', value: { stringValue: 'R&B/Soul' } },
        { key: 'ARTIST', value: { stringValue: 'The Weeknd' } },
        { key: 'ALBUM', value: { stringValue: 'Trilogy' } },
        { key: 'TITLE', value: { stringValue: 'The Party & The After Party' } },
        { key: 'COVER_FILE', value: { stringValue: '' } },
    ];
    const signals = {
        loadConfig: () => ({ instances: ['AndroidAutoProjected', 'CarPlayMedia'], fields: { currentItemMetadata: {}, currentItemTime: {}, playerState: {} } }),
        watch: async (iface, inst, h) => {
            if (inst === 'CarPlayMedia') {
                h.currentItemMetadata(meta);
                h.currentItemTime({ elapsed: 74237, total: 459707 });
                h.playerState('PLAYER_STATE_PLAY');
            }
            return { available: true };
        },
    };
    const np = new NP.NowPlaying(signals, { info() {}, warn() {}, error() {} }, [{ iface: 'x.MediaPlayer', instances: [] }]);
    await np.start();
    const tr = np.track();
    np.stop();
    assert.strictEqual(tr.title, 'The Party & The After Party');
    assert.strictEqual(tr.artist, 'The Weeknd');
    assert.strictEqual(tr.album, 'Trilogy');
    assert.strictEqual(tr.duration, 459707);
    assert.strictEqual(tr.position, 74237);
});

test('the time in the song is currentItemTime.elapsed, never currentItemPosition (a place in the playlist)', async () => {
    const meta = [{ key: 'TITLE', value: { stringValue: 'Song' } }, { key: 'ARTIST', value: { stringValue: 'Artist' } }];
    let h = null;
    const signals = {
        loadConfig: () => ({ instances: ['CarPlayMedia'], fields: { currentItemPosition: {}, currentItemMetadata: {}, currentItemTime: {}, playerState: {}, playbackSpeed: {} } }),
        watch: async (iface, inst, handlers) => { h = handlers; return { available: true }; },
    };
    const np = new NP.NowPlaying(signals, { info() {}, warn() {}, error() {} }, [{ iface: 'x.MediaPlayer', instances: [] }]);
    await np.start();
    np.stop();
    // the order the car sent them in: the list place first
    h.currentItemPosition({ position: 0, totalNumber: 0 });
    h.currentItemMetadata(meta);
    h.currentItemTime({ elapsed: 89258, total: 459707 });
    h.playerState('PLAYER_STATE_PLAY');
    h.playbackSpeed(1000);
    let t = np.track();
    assert.strictEqual(t.position, 89258);
    assert.strictEqual(t.duration, 459707);
    assert.strictEqual(t.playing, true);
    h.playerState('PLAYER_STATE_PAUSE');
    t = np.track();
    assert.strictEqual(t.playing, false);
    // the generic finder (a source without MediaPlayer's fields) skips list places too
    const np2 = new NP.NowPlaying(signals, { info() {}, warn() {}, error() {} }, []);
    np2._put('x.Other', '1', 'nowPlaying', { title: 'A', artist: 'B' });
    np2._put('x.Other', '1', 'currentItemPosition', { position: 3, totalNumber: 9 });
    np2._put('x.Other', '1', 'trackTime', { elapsed: 42000, total: 200000 });
    assert.strictEqual(np2.track().position, 42000);
});

test('a playing source wins over a stopped one with older metadata', async () => {
    const np = new NP.NowPlaying({}, { info() {}, warn() {}, error() {} }, []);
    np._put('x.MediaPlayer', 'Usb1', 'currentItemMetadata', [{ key: 'TITLE', value: { stringValue: 'Old USB song' } }]);
    np._put('x.MediaPlayer', 'Usb1', 'playerState', 'PLAYER_STATE_STOP');
    np._put('x.MediaPlayer', 'CarPlayMedia', 'currentItemMetadata', [{ key: 'TITLE', value: { stringValue: 'Now' } }]);
    np._put('x.MediaPlayer', 'CarPlayMedia', 'playerState', 'PLAYER_STATE_PLAY');
    assert.strictEqual(np.track().title, 'Now');
});

test('artwork: the right iTunes result, its 600 px link, and a cover and backdrop from a JPEG', () => {
    const results = [
        { trackName: 'Money Longer (Remix)', artistName: 'Someone Else', artworkUrl100: 'https://x/a/100x100bb.jpg' },
        { trackName: 'Money Longer', artistName: 'Lil Uzi Vert', collectionName: 'Lil Uzi Vert vs. the World', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/source/100x100bb.jpg' },
    ];
    const best = ART.pick(results, { title: 'Money Longer', artist: 'Lil Uzi Vert' });
    assert.strictEqual(best.artistName, 'Lil Uzi Vert');
    assert.strictEqual(ART.sized(best.artworkUrl100, 600), 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/source/600x600bb.jpg');
    assert.strictEqual(ART.pick(results, { title: 'Other Song', artist: 'Nobody Here' }), null);
    const a = new ART.Artwork(null, { info() {}, warn() {} });
    const e = a.fromJpeg(fs.readFileSync(path.join(__dirname, 'fixtures', 'cover.jpg')));
    assert.strictEqual(e.state, 'ready');
    assert.strictEqual(e.cover.length, ART.ART_PX * ART.ART_PX * 4);
    assert.strictEqual(e.blur.length, ART.BG_W * ART.BG_H * 4);
    assert.strictEqual(e.cover[3], 0);                                   // a rounded corner is see-through
    const mid = (ART.ART_PX / 2 * ART.ART_PX + ART.ART_PX / 2) * 4;
    assert.strictEqual(e.cover[mid + 3], 255);
    // the backdrop is dark enough for white text, and blue on the left, red on the right as the cover
    const L0 = (ART.BG_H / 2 * ART.BG_W + 4) * 4, R0 = (ART.BG_H / 2 * ART.BG_W + ART.BG_W - 5) * 4;
    assert.ok(e.blur[L0 + 2] > e.blur[L0] && e.blur[R0] > e.blur[R0 + 2]);
    assert.ok(Math.max(e.blur[L0 + 2], e.blur[R0]) < 200);
});

test('artwork lookup goes through iTunes and caches the result', async () => {
    const jpg = fs.readFileSync(path.join(__dirname, 'fixtures', 'cover.jpg')), calls = [];
    const request = (m, host, p) => {
        calls.push(host + p);
        if (host === 'itunes.apple.com') return Promise.resolve({ status: 200, body: Buffer.from(JSON.stringify({ results: [{ trackName: 'Night Drive', artistName: 'Sample Artist', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/x/100x100bb.jpg' }] })) });
        return Promise.resolve({ status: 200, body: jpg });
    };
    const a = new ART.Artwork(request, { info() {}, warn() {} });
    assert.strictEqual(a.get({ title: 'Night Drive', artist: 'Sample Artist' }).state, 'loading');
    await new Promise((r) => setTimeout(r, 200));
    const e = a.get({ title: 'Night Drive', artist: 'Sample Artist' });
    assert.strictEqual(e.state, 'ready');
    assert.strictEqual(e.ver, 1);
    assert.deepStrictEqual(calls, ['itunes.apple.com/search?term=Night%20Drive%20Sample%20Artist&media=music&entity=song&limit=10', 'is1-ssl.mzstatic.com/image/x/600x600bb.jpg']);
});

test('LRC parsing and the line at a time', () => {
    const lines = L.parseLrc('[00:01.00]First\n[00:05.50]Second\n[00:10.00]Third');
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(L.lineAt(lines, 6000), 1);
    assert.strictEqual(L.lineAt(lines, 500), -1);
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok', name); } catch (e) { console.log('FAIL', name, '\n', e.stack); process.exitCode = 1; }
    }
    console.log(process.exitCode ? 'some tests failed' : tests.length + ' tests passed');
})();
