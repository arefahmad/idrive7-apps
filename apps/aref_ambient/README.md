# Cabin Light

Aref's ambient lighting app: any colour on the ambient light, animations, a look for each driving mode, door and
turn-signal lights, night dimming, and **Music**: the light moves with the song's beat.

It starts from [Ambient config](https://github.com/cauliflowermossgrape/idrive7-apps/tree/main/apps/ambient_config)
by cauliflowermossgrape (MIT, see LICENSE): his light driver (the body controller's LIN light modules through the
head unit's diagnostic link), looks and tabs are his. It is built with his kit (`kit-cmg/`, see its README).

**Install:** remove Ambient config (or any other ambient light app) first. Only one app can write the lights: the
head unit's gateway takes one request at a time, and two apps get each other's refused.

## Music

The car doesn't give apps the sound, so the beats come from the owner's homelab: `beat_map.py` analyses each song
once (onset strength, tempo by autocorrelation, beats by dynamic programming, checked against librosa and a click
track) and copies `beats/<song key>.json` into this app's data folder. The song and where it is come from the car's
media player (Car Lyrics' `nowplaying.js` and `lyrics.js`, copied in).

A light write takes about 200 ms and only one goes at a time, so the writes are timed to the beats (each sent that
much early): on each beat the light comes up, half a beat later it goes back down. When a beat is long enough for
four writes both sides light together; faster songs take turns, left on one beat and right on the next.

Settings → **Music**: Off, Pulse on the beat (default), or Pulse driving, flash when parked.

- **Driving:** a soft pulse, never under 55 % of your look's brightness, no colour changes.
- **Parked** (with "flash when parked"): full flashes and the colour turning each bar.

No beat map for a song (not analysed yet, or no homelab): the look stays as it is.
