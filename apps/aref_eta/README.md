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

### Looks (1.2)

Designed to look like Apple made it: Inter (the open look-alike of SF Pro), Apple's dark-mode label colours and
system traffic colours, and Apple's materials. **Settings:**

- **Look:** Frosted glass (default: a smoky translucent platter the cluster shows through, a top sheen and a bright
  rim), Dark card (CarPlay's dark platter), Light glass (for daytime) or Plain text.
- **Layout:** one row (`6:42 arrival  23 min  14.2 mi`) or stacked like Apple Maps' ETA card.
- **Show** arrival, time left and distance each on or off; **traffic colours** on time left; **AM / PM**.

The layer can't read the cluster's picture under it, so the glass is a tint rather than a real blur. Each look is
drawn only when a number or a setting changes (a few ms), never per frame, so it adds no lag.
Previews: [cluster looks](../../docs/screenshots/aref_eta/cluster-looks.png) (clock and drive mode are stand-ins),
[app screen](../../docs/screenshots/aref_eta/app-glass.png).

Why it's drawn rather than sent to BMW's strip: BMW's strip shows an ETA only for BMW's own navigation. 0.2 to
0.4 tried CarPlay's street field and the guidance state (provider CarPlay, none and other); none changed it.

## Safety

It only reads the car's guidance services. It draws one small layer on the cluster through the Cluster
renderer, never over BMW's own cluster content (BMW's pop-ups and warnings win). It never talks to the engine or any other module. Ending the route resets the state.
