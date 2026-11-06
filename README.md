# idrive7-apps

Apps for BMW iDrive 7 (MGU) head units, installed through the
[mgu-store](https://github.com/robertnisipeanu/mgu-store). The Store builds each app on the head unit
from this repository.

## Apps

### Car Lyrics (`aref_carlyrics`), experimental

Synced lyrics for whatever the car is playing: Apple Music over CarPlay, Bluetooth or USB. No Spotify
and no phone app. The track comes from the head unit itself, and the lyrics from
[LRCLIB](https://lrclib.net).

- **Main screen:** the song, the artist, a progress line and the lyrics, with the current line large and
  the ones around it fading.
- **Song just started:** syncs the lyrics when the car doesn't report a playback position.
- **Lyrics timing** (Settings): moves the lyrics earlier or later, up to 3 s.
- **Probe screen:** every value the car reports from the CarPlay and media interfaces, the interfaces in
  the car's catalog that look like media, and the subscriptions. **Save report** writes it all to
  `carlyrics-probe.txt` in the app's data folder (it is also written every minute).

**Status:** which interface and field carry the CarPlay track on iDrive 7 isn't documented anywhere.
Version 0.1 subscribes to every field of `CarPlayManager` and `MediaPlayer` and picks the track out by
name. If the main screen stays on "Play a song on your phone", the Probe screen and its report show what
to declare in the next version.

**Safety:** read-only toward the car. It subscribes to and reads fields; it never calls a method or
writes a value. It draws only on the centre screen.

### Fault Watch (`aref_faultwatch`)

Reads every control unit's fault memory in the background, every 10 minutes while the car is on, and
keeps a timeline of what changed.

- **Timeline:** new faults, faults that turn active, faults that clear. Each entry has the time and the
  drive at that moment: speed, gear, rpm, oil temperature, drive mode. This is for intermittent problems
  (a headlight dropping, the bass cutting out): it shows when they happen and in what conditions.
- **Current faults:** what the last scan found, per control unit.
- **Settings:** scan every 5, 10, 15 or 30 minutes; mph and F or km/h and C.

Faults show as codes with the control unit's name. Look a code up in ProTool or ISTA for its text.

**Safety:** read-only. The only request it sends is UDS `19 02` (read fault memory), to all units at once,
as BMW's testers and the Fault Scanner do. It never clears a fault and never writes anything. It starts
with the car.

### Drive Log (`aref_drivelog`)

Records every drive in the background and keeps its numbers.

- **This drive:** distance, time moving, top speed, best 0-60 mph, peak rpm, the most acceleration,
  braking and cornering g, and the highest oil and coolant temperatures. Shows the last drive when parked.
- **History:** every drive kept (up to 300), newest first.
- **Save CSV:** writes `drives.csv` to the app's data folder.

A drive starts when the car moves and ends after 30 s in P or 5 minutes standing still. The 0-60 time uses
the car's own wheel speed, not GPS. **Safety:** read-only; it only listens to the car's driving signals. It
starts with the car.

## Install

1. In the Store: **Settings > Add source**, type `arefahmad/idrive7-apps`, then pick **Branch main**.
2. Pick an app in the Store and tap **Install**. Restart the head unit if the Store asks. Fault Watch and
   Drive Log start with the car from the next restart on.
3. For Car Lyrics, give the car internet (Store **Settings > Wi-Fi**, or a phone hotspot): the lyrics come
   from LRCLIB.

## For developers

- `apps/<id>/`: one app (`app.json`, `main.js`, `icon.png`, its modules in folders).
- `kit/`: the MGU App Kit from [nickgcode/idrive7-apps](https://github.com/nickgcode/idrive7-apps), itself
  from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT,
  `kit/LICENSE.nickgcode`, `kit/LICENSE.idrive7-apps`), with `diag.js` and `ecus.js` added from
  cauliflowermossgrape's kit, and one line in `kit/tools/build.py` that copies app.json's
  `"mguAppStartType"` (autostart) into the package.
- `test/`: plain-Node tests, not installed: `node test/carlyrics.test.js`, `node test/faultwatch_drivelog.test.js`.
- The car runs Node 8: no `?.`, `??`, object spread, `import`, class fields or optional catch binding.
- Bump an app's `version` in `app.json` on every change you want cars to update to.
- Never commit `oap-sdk/` or a built package (`dist/`). No BMW code or SDK is in this repository.

## Disclaimer

Unofficial. Not made, endorsed or supported by BMW or by the Store's author. Use at your own risk.

## License

MIT (`LICENSE`). Bundled third-party code keeps its own licence (`kit/`, `apps/aref_carlyrics/LICENSE`).
