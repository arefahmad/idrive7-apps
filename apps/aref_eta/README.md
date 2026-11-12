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

- **Screen:** the arrival time, time left, distance left and traffic it would show, and every raw value.
- **Mark in log:** writes a marker line (tap it when you start or end a route, to find it in the log).
- **Home-screen widget:** the arrival time and what's left.

## The ETA on the cluster (1.0)

During an Apple Maps route on CarPlay, ETA Bar draws the arrival time, time left and distance left on the
instrument cluster, in the blank space of the bottom strip between the clock and the drive mode. It hides when
the route ends, so BMW's street name comes back.

It needs the **Cluster renderer** tool from the Store (Waze on cluster installs it too).

- **Cluster ETA on/off:** turns it on or off. It's on by default.
- **Preview on cluster:** shows a sample ETA for 30 seconds, with or without a route.
- **Move up / down / left / right, Bigger, Smaller:** place it. Each tap shows the preview. The place is saved.
- **Reset place:** goes back to the default place, where BMW shows the street name.

### Look (1.1)

Apple Maps' style: `6:42 arrival   23 min   14.2 mi`. Values in Inter Bold (the open look-alike of Apple's SF Pro,
the same atlases as Car Lyrics), units in Apple's secondary gray, and the minutes in Apple's traffic colours
(green, orange, red) when the car reports traffic. Over an hour shows as `1:12 hr`. **Settings > Cluster look**
picks plain text (default) or a dark rounded card like CarPlay's dashboard cards.
Preview: [docs/screenshots/aref_eta/cluster-looks.png](../../docs/screenshots/aref_eta/cluster-looks.png)
(the clock and drive mode there are stand-ins).

Why it's drawn rather than sent to BMW's strip: BMW's strip shows an ETA only for BMW's own navigation. 0.2 to
0.4 tried CarPlay's street field and the guidance state (provider CarPlay, none and other); none changed it.

## Safety

It only reads the car's guidance services. It draws one small layer on the cluster through the Cluster
renderer, never over BMW's own cluster content (BMW's pop-ups and warnings win). It never talks to the engine or any other module. Ending the route resets the state.
