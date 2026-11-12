# ETA Bar

Puts Apple Maps' arrival time where a Waze route's ETA shows today: the cluster's bottom strip, between the
clock and the drive mode.

Version 0.3.0 · iDrive 7 · package `aref_eta` · [all apps and how to install](../../README.md)

> [!NOTE]
> **0.1 is a probe.** It shows and logs what the car's guidance services report while a route runs. The
> next version uses that to fill the strip.

## How it works

The cluster fills its bottom strip from the head unit's guidance data: CarPlay's `ProjectedModeGuiding`
service (`waypoints`: arrival time, time and distance left, traffic; `currentRoad`: the street) and BMW's
own `Guidance` service. Waze sends its ETA there through CarPlay, and Google Maps sends the street. Apple
Maps seems to leave them empty on iDrive 7.

This version watches those fields and CarPlay's guidance flags and writes every change to `eta-probe.log`
in the app's data folder:

- **Screen:** whether the ETA is on the cluster, a live preview of it in your chosen look, and the trip (arrival, time left, distance).
- **Diagnostics:** every raw value the car's guidance services report (tap again for the next page; Done goes back).
- **Home-screen widget:** the arrival time and what's left.

## The ETA on the cluster (1.0)

During an Apple Maps route on CarPlay, ETA Bar draws the arrival time, time left and distance left on the
instrument cluster, in the blank space of the bottom strip between the clock and the drive mode. It hides when
the route ends, so BMW's street name comes back.

It needs the **Cluster renderer** tool from the Store (Waze on cluster installs it too).

- **On / Off:** turns it on or off. It's on by default.
- **Preview:** shows a sample ETA for 30 seconds, with or without a route.
- **Up, Down, Left, Right, Bigger, Smaller:** place it. Each tap shows the preview. The place is saved.
- **Reset:** goes back to the default place, where BMW shows the street name.

### Updates

The ETA redraws the moment the phone sends new route numbers (about every second while Apple Maps guides), so a
wrong turn shows Apple Maps' new arrival, minutes and miles as soon as it reroutes. If the phone stops sending the
route (CarPlay's guidance metadata goes off), the ETA hides instead of showing old numbers.

### In step with the cluster's map (1.2.1)

When Waze on cluster (CarPlay's map on the cluster) is coming up, the ETA waits for it (up to 3 s) and appears
with it: the cluster's own 250 ms fade plus a short rise. A route the phone has finished but not cleared (0 ft,
nothing left) no longer flashes up. After a head-unit restart the car starts apps about 15 s after its own
tools, so the ETA can only come that much after the map; on a normal start ETA Bar is already running.

### Presets (1.3)

**Settings > Where:**

- **Bottom strip** (default): in the strip's blank space, where BMW shows the street name.
- **Island at the top:** a black pill under the driver attention camera that drops out of it and widens like
  iPhone's Dynamic Island, shows the ETA, then shrinks back in. **Settings > Island pops out:** once and stays,
  every 10 s / 30 s / minute / 5 minutes (open for up to 6 s each time), or when the arrival time changes.
  The motion is played by the cluster renderer itself (translate and scale keys on four small layers: the pill's
  two ends, a stretched middle and the text), so a pop sends a few small messages and no pictures.
  Preview: [island.gif](../../docs/screenshots/aref_eta/island.gif).

Up, Down, Left, Right, Bigger, Smaller and Reset move the preset that's chosen; each keeps its own place.

### Looks (bottom strip, 1.3)

Only what the cluster itself shows: its black and a hairline rim like its own dividers. **Black** (default),
**Smoked** (the same black, see-through), **Outline** (rim only) or **Plain text**. Inter (the open look-alike of
SF Pro), Apple's label colours; time left is green (orange / red when the car reports delays; CarPlay routes
usually come without a traffic status, which reads as on time). One row or stacked like Apple Maps' ETA card;
arrival, time left and distance each on or off; AM / PM.
[Previews](../../docs/screenshots/aref_eta/cluster-looks.png) (clock and drive mode are stand-ins).

Why it's drawn rather than sent to BMW's strip: BMW's strip shows an ETA only for BMW's own navigation. 0.2 to
0.4 tried CarPlay's street field and the guidance state (provider CarPlay, none and other); none changed it.

## Safety

It only reads the car's guidance services. It draws one small layer on the cluster through the Cluster
renderer, never over BMW's own cluster content (BMW's pop-ups and warnings win). It never talks to the engine or any other module. Ending the route resets the state.
