# Car Watch

Misfire Watch, Fault Watch and Drive Log in one app that starts with the car. It runs as one process
instead of three, which saves about 120 MB of the head unit's memory.

- **Misfires:** every misfire the engine counts, per cylinder, with the rpm, speed, gear, load, coolant
  temperature and drive mode at that moment. Log and per-drive views, Export CSV.
- **Faults:** every control unit's fault memory, read every 10 minutes, with a timeline of what came,
  turned active or cleared. Current faults view, Scan now.
- **Drives:** every drive's distance, time moving, top speed, best 0-60, peak rpm, g, and the highest oil
  and coolant temperatures. History, 0-60 runs, Dragy comparison, Save CSV.

**Show Faults / Show Drives / Show Misfires** switches the section. The home-screen widget shows this
drive's misfires, the stored faults and the last drive.

## Moving from the three old apps

1. Update Misfire Watch (0.1.1), Fault Watch (0.2.2) and Drive Log (0.3.2), then start the car once.
   Each one leaves a copy of its data for Car Watch.
2. Install Car Watch, without restarting the head unit in between (the copy is kept in memory only).
   On its first start it brings the old apps' history over and says so on screen for 30 seconds.
3. Remove Misfire Watch, Fault Watch and Drive Log.

Car Watch never replaces data it already has. The files keep their old names (`misfires.json`,
`faultwatch.json`, `drivelog.json`, `misfires.csv`, `drives.csv`) in Car Watch's data folder.

## Safety

Read-only, as the three apps were: OBD service 06 requests to the engine unit for the misfire counters,
UDS 19 02 to all units for the fault memory, and the car's own driving signals. It never clears a fault
and never writes to the car.
