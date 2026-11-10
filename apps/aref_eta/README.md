# ETA Bar

Puts Apple Maps' arrival time where a Waze route's ETA shows today: the cluster's bottom strip, between the
clock and the drive mode.

Version 0.2.0 · iDrive 7 · package `aref_eta` · [all apps and how to install](../../README.md)

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

## Test strip

Start a route, open ETA Bar and tap **Test strip**. It writes the arrival time, time left and distance left
(for example "5:26 PM · 21 min · 15 mi") once into CarPlay's street field (`currentRoad`), the field the
bottom strip shows. Look at the strip: if the ETA shows there, the next version keeps it there for the whole
route. The nav app writes its street back at the next turn, and ending the route clears the field.

## Safety

It writes one field, CarPlay's street text on the head unit, and only when you tap **Test strip**. It never
writes to the engine or any other module, and it calls no method.
