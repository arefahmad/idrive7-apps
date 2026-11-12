# Tire Setup

The tire pressure monitor (RDC) as your BMW sees it, in plain English, and the iDrive tire menu's own actions
sent from the app. Built for a G22 M440i whose "auto detect" keeps saying it can't recognize the tires.

## What it shows

- **Why auto detect fails:** the car's own status (TPMSInternalData.statusWheelTypeChange) in plain words, e.g.
  "No matching tire found: the tires on the car aren't in the car's tire list".
- **The four tires:** pressure (psi), temperature (F) and target pressure ("Target not set" until a reset passes).
- **What the car thinks is fitted** (front and rear), **what the sensors say is fitted** (tire data written into
  the sensors from the tire's QR code), how the tire was picked, **the last reset** (how, at what mileage, result),
  season and load setting, **DSC** state and whether the car is parked.
- **Tire list:** the tires the car offers (Get list), to pick one by hand.
- **Log:** every write, the DSC state before and after, and what the car answered. Saved to `tires.log`.

## What it changes

The same things the iDrive menu (Vehicle status > Tire Pressure Monitor) changes, through the same message
(TPMS.chassisControl): get the tire list, pick a tire, auto detect, reset pressures, summer / winter.
It can't add a tire the car's list doesn't have: that's a coding job (ISTA / E-Sys) or tire data written into the
sensors by a shop.

## DSC safety

chassisControl also carries the DSC request (DSC_EINSCHALTEN 0 = on, DSC_AUSSCHALTEN 1 = off, SIGNAL_UNGUELTIG 7 =
no request). So:

1. Every write starts from a frozen template with every member set to "no request", DSC to SIGNAL_UNGUELTIG,
   and changes only its own members (`tires/decode.js` build()). check() refuses anything else right before sending.
   `test/tires.test.js` checks every action.
2. Changes are off until **Settings > Allow changes to the car** is on.
3. Only parked (speed 0), only with the DSC state known and on, and each button must be pressed twice.
4. DSC is read (FES.statusDSCSwitchHMI) before and 1.5 s and 4 s after every write. A change raises a red alarm,
   blocks further writes and is logged. **DSC on** sends a DSC-on request (the only write that names DSC, and only
   to turn it on). The DSC button on the console and a new start of the car also turn DSC on.

## First test on the car

1. Parked, engine on. Settings > Allow changes to the car: on.
2. Press **Safe test** twice: sends the template with nothing requested. Expect "the car took it" and DSC staying on.
   If the car refuses it, the head unit doesn't let apps write this field and nothing else will work.
3. **Get list** twice: the car's tire list should fill in.
4. Then the real fix: pick the tire closest to yours (or Auto detect), then **Reset** twice, then drive 10 to 20
   minutes above 20 mph.
5. Leave the car on for 10 minutes after so the homelab pulls `tires.log`.

The tire sizes are decoded from the car's fields as best known; the raw values are in the log, so a wrong
decoding shows up there.
