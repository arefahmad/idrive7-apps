# idrive7-apps

Apps for BMW head units with **iDrive 7** (MGU), installed and updated from the car through
[robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store). They run in the head unit's own
app platform and show up in *All apps* next to BMW's.

Each app solves one problem owners of modified or enthusiast-driven cars run into, and each one is
**read-only toward the car**: it listens to signals the car already sends or reads data, and never writes,
codes, clears or controls anything.

## The apps

| | App | What it's for |
|---|---|---|
| <img src="apps/aref_carcare/icon.png" width="40" alt=""> | **[Car Care](apps/aref_carcare/README.md)** | Your own service intervals (oil every 3,000 mi, plugs, coils, fluids, filters) by the car's odometer, kept apart from BMW's CBS. For owners who do their own oil changes but keep BMW's free services on a maintenance plan. |
| <img src="apps/aref_drivelog/icon.png" width="40" alt=""> | **[Drive Log](apps/aref_drivelog/README.md)** | Every drive recorded in the background: distance, top speed, 0-60 mph, peak g and temperatures. Calibrates itself against a Dragy, then shows a Dragy-adjusted 0-60 without one. |
| <img src="apps/aref_faultwatch/icon.png" width="40" alt=""> | **[Fault Watch](apps/aref_faultwatch/README.md)** | Background fault-memory scans and a timeline of what changed, each with the speed, gear, rpm and temperature at the time. For tracking down intermittent faults. |
| <img src="apps/aref_carlyrics/icon.png" width="40" alt=""> | **[Car Lyrics](apps/aref_carlyrics/README.md)** | Synced lyrics for Apple Music over CarPlay, Bluetooth or USB, no Spotify needed. Experimental. |
| <img src="apps/aref_explorer/icon.png" width="40" alt=""> | **[Car Explorer](apps/aref_explorer/README.md)** | Finds the head unit's services behind a feature (ambient light, route guidance, GPS, climate...) and reports what each offers. For anyone asking "can an app do X on my car?" |

## Roadmap

What is planned and what it waits on: [ROADMAP.md](ROADMAP.md).

## Common to every app

- **Home-screen widget:** each app has one, added to the iDrive home screen like BMW's own widgets.
- **Settings** in BMW's own style: the Settings button opens a BMW-style list over the app with the GPU
  renderer, or the HMI's own settings screen without it.

## Status

> [!NOTE]
> These apps are new and **not yet tested on a car**. Each is built on the same kit and signals as apps
> that run on cars today (G's Dash, M Vitals, Live Data, Fault Scanner), and each app's page says what it
> relies on. Reports from your car are welcome: open an issue with the app's log (in its data folder) or
> a photo of its screen.

## Requirements

- A BMW with an **iDrive 7** head unit (MGU), with root access and
  [mgu-store](https://github.com/robertnisipeanu/mgu-store) installed.
- Car Lyrics only: internet for the head unit through the Store's uplink (Wi-Fi or a phone hotspot).

## Install

1. In the Store: **Settings > Add source**, type `arefahmad/idrive7-apps`, and pick **Branch main**.
2. Pick an app and tap **Install**. The head unit builds it from this repository.
3. Restart the head unit once (Store **Settings > Restart head unit**). Fault Watch and Drive Log start
   with the car from then on.

Updates appear in the Store. To remove an app, remove it in the Store; its data goes with it.

## Safety principles

- **Read-only toward the car.** No app here writes to a control unit, changes coding, clears faults or
  controls anything. Fault Watch sends one diagnostic request, `19 02` (read fault memory), the same one
  BMW's testers use.
- **Centre screen only.** None of these apps draws over the instrument cluster or the HUD.
- **No accounts and no cloud.** Data stays in each app's data folder on the head unit. Car Lyrics talks to
  LRCLIB for lyrics and nothing else.

## For developers

- `apps/<id>/`: one app: `app.json` (manifest, screens, settings), `main.js`, `icon.png`, its modules in
  folders, and its `README.md`.
- `kit/`: the MGU App Kit from [nickgcode/idrive7-apps](https://github.com/nickgcode/idrive7-apps), itself
  from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT,
  `kit/LICENSE.nickgcode`, `kit/LICENSE.idrive7-apps`), with `diag.js` and `ecus.js` added from
  cauliflowermossgrape's kit, and one line in `kit/tools/build.py` that copies app.json's
  `"mguAppStartType"` (autostart) into the package.
- `test/`: plain-Node tests for each app's logic, not installed: `for f in test/*.test.js; do node $f; done`.
- `tools/screens.js`: renders every app's screens on a PC with made-up data into `apps/<id>/screenshots/`
  (`node tools/screens.js`), through the same recorder the car uses.
- The car runs **Node 8**: no `?.`, `??`, object spread, `import`, class fields or optional catch binding.
- Bump an app's `version` in `app.json` on every change that alters what it installs (its own files or
  `kit/`).
- Never commit `oap-sdk/` or a built package (`dist/`). No BMW code or SDK is in this repository.

## Credits

Built on the work of [cauliflowermossgrape](https://github.com/cauliflowermossgrape/idrive7-apps) (the kit
and the diagnostic link), [nickgcode](https://github.com/nickgcode/idrive7-apps) (the kit as used here and
the lyrics client) and [robertnisipeanu](https://github.com/robertnisipeanu/mgu-store) (the Store).

## Disclaimer

Unofficial. Not made, endorsed or supported by BMW or by the Store's author. Use at your own risk.

## License

MIT (`LICENSE`). Bundled third-party code keeps its own licence (`kit/`, `apps/aref_carlyrics/LICENSE`).
