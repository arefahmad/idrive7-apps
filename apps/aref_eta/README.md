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

What 0.3 showed: telling the car "CarPlay route active" hides the street, exactly like a real Apple Maps route.
So the strip switches into guidance mode, but it only fills in the ETA for a route it treats as BMW's own.
The car already holds Apple Maps' ETA in BMW's guidance data, so 0.4 tests whether a different provider unlocks it.

1. Start an Apple Maps route on CarPlay. The street disappears from the strip.
2. Tap **Test A: provider none**. Look at the strip, then tap **Mark in log**.
3. Tap **Test B: provider other**. Look at the strip, then tap **Mark in log**.
4. Tap **Test: reset** to send back what the car had.

Tried and ruled out:

- 0.2: writing the ETA into CarPlay's street field. The car takes it, but the strip doesn't show it.
- 0.3: setting the CarPlay route to active. It hides the street but shows no ETA.

## Safety

It calls one method, the guidance service's `setGuidanceState` on the head unit, and only when you tap a test
button. It never talks to the engine or any other module. Ending the route resets the state.
