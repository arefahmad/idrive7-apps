# Roadmap

What is planned, and what each item waits on. Most wait on a first test on a car: the apps here are
built on a PC and confirmed on a car one by one.

## Waiting on a car test

| Item | Waits on |
|---|---|
| Car Lyrics on the HUD, in the middle, the way G's Music shows its lyrics | Car Lyrics' probe report from a car playing Apple Music over CarPlay |
| Apple Maps ETA, distance and time left in the cluster's bottom bar | The same probe, and Car Explorer's **Route guidance and ETA** topic |
| Ambient light scenes per drive mode (BMW's own colour presets, switched the way the iDrive menu does) | Car Explorer's **Ambient light** topic: whether the head unit exposes the setting to apps |
| Dash Art: a GIF in the cluster's bottom bar, and a celebration on a new best 0-60 | The bottom bar's position on the cluster, from a calibration grid |

## Planned

| Item | What it does |
|---|---|
| **Launch coach** (Drive Log) | Records the launch of every 0-60 (rpm at launch, how fast the speed builds) and shows which launch gave the best times |
| **Ghost run** (Drive Log) | Your best 0-60 replayed as a bar next to the run going on, like a racing game's ghost |
| **Drive replay** | A drive as a map on your phone afterwards, coloured by speed and g, with the hard pulls marked (needs the car's GPS position) |
| **Phone remote** | A page on your phone, over Tailscale, with Drive Log, Fault Watch and Car Care while the car is awake |
| **Car health score** | One score from Fault Watch, Car Care, and the tyre and battery trends, as a widget |
| **Tyre slow-leak detector** | Each tyre's pressure over days; a warning when one drops faster than the others |
| **Battery health** | The 12 V and 48 V batteries at every start; a warning when the trend drops |
| **Car Link** | Homelab alerts on the car's screen, drive recaps to Discord, reminders from the phone |
| **Home and away** | The car tells the homelab when it leaves home and when it arrives (room lights off and on) |
