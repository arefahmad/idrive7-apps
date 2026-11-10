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

## The test buttons

During a CarPlay route the car already holds the phone's ETA in BMW's guidance data, but the guidance state
stays `INACTIVE` and the strip stays empty. **Test: ETA on** tells the guidance service that the CarPlay route
is `ACTIVE`; **Test: off** sets it back. Start an Apple Maps route, tap **Test: ETA on**, and look at the strip.

Tried and ruled out (0.2): writing the ETA into CarPlay's street field. The car takes it, but the strip
doesn't show it.

## Safety

It calls one method, the guidance service's `setGuidanceState` on the head unit, and only when you tap a test
button. It never talks to the engine or any other module. Ending the route resets the state.
