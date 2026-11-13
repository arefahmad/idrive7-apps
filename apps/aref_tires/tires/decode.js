'use strict';
/**
 * decode.js - the car's tire values (TPMS, TPMSInternalData, FES) in plain English, and the one write the app
 * makes (TPMS.chassisControl), built so it can never ask for a DSC change.
 *
 * Why the write needs care: chassisControl is one struct the HMI's tire menu and the DSC button share. Its
 * operationModeTractionDSC member is the DSC request (DSC_EINSCHALTEN 0 = on, DSC_AUSSCHALTEN 1 = off, ...,
 * SIGNAL_UNGUELTIG 7 = no request). Every write here starts from NO_ACTION (every member "no request"), sets only
 * the tire members it means to, and check() refuses the struct unless the DSC member is exactly
 * SIGNAL_UNGUELTIG. main.js also reads the DSC state (FES.statusDSCSwitchHMI) before and after each write.
 *
 * Pure functions, no car access: test/tires.test.js runs them on the PC. Node 8.
 */

const NONE16 = 65532;                         // raw pressures from here up: no value (65533 = target not set)
const TYRES = ['FLH', 'FRH', 'RLH', 'RRH'];
const WHEEL = { FLH: 'Front left', FRH: 'Front right', RLH: 'Rear left', RRH: 'Rear right' };

/** psi from the car's raw value (0.1 psi on this US car: 360 = 36.0 psi), null for "none". */
function psi(raw) { return typeof raw === 'number' && raw < NONE16 ? Math.round(raw) / 10 : null; }
/** deg F from the raw temperature (raw - 40, in F on this car: 94 -> 54 F), null for "none". */
function degF(raw) { return typeof raw === 'number' && raw < 255 ? raw - 40 : null; }

function four(v, pre, fn) {
    const o = {};
    TYRES.forEach((p) => { o[p] = v ? fn(v[pre + p]) : null; });
    return o;
}
const pressures = (v) => four(v, 'actualValuePressureTyre', psi);
const targets = (v) => four(v, 'targetPressureTyre', psi);
const temps = (v) => four(v, 'actualValueTemperatureTyre', degF);

/* ---------- enums in plain English ---------- */
const name = (v) => (v && typeof v === 'object' ? v.name || v.value : v);

// TPMSInternalData.statusWheelTypeChange.statusWheelTypeChangeDetection: why auto-detect does or doesn't work
const DETECTION = {
    ALGORITHMUS_RADERKENNUNG_LAEUFT: ['busy', 'Finding the wheels', 'The car is still matching sensors to wheels. Keep driving.'],
    ALGORITHMUS_RADERKENNUNG_ABGESCHLOSSEN: ['ok', 'Wheels found', 'Every sensor is matched to a wheel.'],
    RADIDENTIFIKATION_ABGESCHLOSSEN: ['ok', 'Wheels identified', 'The car knows each sensor.'],
    POSITIONSBESTIMMUNG_ABGESCHLOSSEN: ['ok', 'Wheel positions found', 'The car knows where each sensor sits.'],
    NEUER_REIFEN: ['busy', 'New tire noticed', 'The car saw a tire it hasn\'t learned. Pick it in the tire list, then reset.'],
    PERMUTATION: ['busy', 'Wheels swapped', 'The car noticed the wheels moved positions.'],
    KEINE_AUTOMATISCHE_AUSWAHL_MOEGLICH: ['bad', 'Can\'t pick the tire by itself', 'Auto detect can\'t work on these tires. Pick the tire from the list instead.'],
    RDC_DEGRADIERT_KEIN_PASSENDER_REIFEN_GEFUNDEN: ['bad', 'No matching tire found', 'The tires on the car aren\'t in the car\'s tire list. Auto detect fails; pick the closest size from the list, or have the list coded with your tire.'],
    RDC_DEGRADIERT_UNGUELTIGE_REIFENLISTE: ['bad', 'Tire list not valid', 'The car\'s stored tire list is broken or missing. A coding job (ISTA / E-Sys) fixes this.'],
    RDC_DEGRADIERT_ERFS_NICHT_CODIERT: ['bad', 'Tire recognition not coded', 'Automatic tire recognition is switched off in this car\'s coding. Pick the tire by hand.'],
    RDC_DEGRADIERT_FUNKTION_NICHT_VERFUEGBAR: ['bad', 'Tire monitor not available', 'The tire monitor reports itself unavailable. Check fault codes.'],
    RDC_NOCH_NICHT_VERFUEGBAR: ['busy', 'Not ready yet', 'The tire monitor hasn\'t started. Drive a few minutes.'],
    FUNKTION_MELDET_FEHLER: ['bad', 'Tire monitor fault', 'The tire monitor reports a fault. Check fault codes.'],
    FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR: ['bad', 'No answer', 'The tire monitor isn\'t answering.'],
};
function detection(v) {
    const n = name(v && v.statusWheelTypeChangeDetection);
    const d = DETECTION[n];
    return d ? { tone: d[0], title: d[1], text: d[2], raw: n } : n ? { tone: 'dim', title: n, text: '', raw: n } : null;
}

// TpmsCalibrationData: the last reset
const CAL_TYPE = {
    ECU_NOT_CALIBRATED_YET: 'Never reset', ECU_NOT_CALIBRATED_YET_WU_POSITIONS_ASSUMED: 'Never reset',
    CALIBRATION_IS_ONGOING: 'Reset running', ERFS_HMI_USER_INITIATED_SELECTION: 'Reset from the iDrive menu',
    ERFS_DIAGNOSTIC_SELECTION: 'Set by a shop tool', ERFS_DIAGNOSTIC_SELECTION_WU_POSITIONS_ASSUMED: 'Set by a shop tool',
};
const CAL_RESULT = {
    PASSED: ['ok', 'Passed'], FAILED: ['bad', 'Failed'], ONGOING: ['busy', 'Running: keep driving'],
    MANUAL_CALIBRATION_PLAUSIBILITY_CHECK_PASSED: ['ok', 'Passed (manual tire)'],
    MANUAL_CALIBRATION_PLAUSIBILITY_CHECK_FAILED: ['bad', 'Failed: the pressures don\'t fit the tire picked'],
    SIGNAL_UNBEFUELLT: ['dim', 'No result yet'],
};
function calibration(v) {
    if (!v) return null;
    const t = name(v.tpmsCalibrationCalibrationType), r = name(v.tpmsCalibrationPlausibility);
    const typ = CAL_TYPE[t] || (/^AUTOMATIC_FILLING/.test(t || '') ? 'Learned after inflating' : t || '');
    const res = CAL_RESULT[r] || ['dim', r || ''];
    return { type: typ, tone: res[0], result: res[1], mileage: num(v.tpmsCalibrationMileage), raw: { type: t, result: r } };
}
const num = (x) => (typeof x === 'number' && x < 4294967295 ? x : null);

/** A tire size from one of the car's tire structs (keys differ per struct: pass the member prefix). */
const SEASON = { SOMMERREIFEN: 'summer', WINTERREIFEN: 'winter', ALLJAHRESREIFEN: 'all-season' };
const RUNFLAT = { RUNFLAT: 'run-flat', NON_MINUS_RUNFLAT: '', PAX: 'PAX' };
function tire(v, k) {
    if (!v) return null;
    const g = (m) => v[m.replace('#', k)];
    const rw = g('width#'), rr = g('relationSide#') !== undefined ? g('relationSide#') : g('crossSection#'), rd = g('radius#') !== undefined ? g('radius#') : g('diameter#');
    if (!(rw > 0 && rw < 255 && rr > 0 && rr < 255 && rd > 0 && rd < 255)) return null;
    // the car sends steps, not millimetres (its tire list on Nov 12: widths 13 / 16, ratios 4-7, rims 6-8):
    // width = 95 + 10 x step, ratio = 15 + 5 x step, rim = 11 + step. That decodes the list to the G22's own
    // sizes (225/45R18 + 255/40R18, 255/35R19, 225/50R17 + 255/45R17 winters). Real millimetres pass as they are.
    const w = rw < 60 ? 95 + 10 * rw : rw, r = rr < 20 ? 15 + 5 * rr : rr, d = rd < 12 ? 11 + rd : rd;
    // the load index's step isn't certain (it lands within 1 of the real one), so it's left out of the size
    const speed = name(g('indexSpeed#') !== undefined ? g('indexSpeed#') : g('speedIndex#'));
    const xl = name(g('carcass#')) === 'REIFEN_XL', season = SEASON[name(g('season#'))] || '', rf = RUNFLAT[name(g('runflat#'))] || '';
    const sp = speed && speed !== 'SIGNAL_UNGUELTIG' && speed.length <= 2 ? ' ' + speed : '';
    const size = w + '/' + r + 'R' + d + sp;
    return { size: size, xl: xl, season: season, runflat: rf, raw: [rw, rr, rd], text: [size, xl ? 'XL' : '', season, rf].filter(Boolean).join(' · ') };
}
const listEntry = (v) => { const t = tire(v, 'TypeTyre'); return t ? Object.assign(t, { id: v.statusTyreObjectListID }) : null; };
const frontAxle = (v) => tire(v, 'FrontAxleTypeTyre');
const rearAxle = (v) => tire(v, 'BackAxleTypeTyre');          // the car names it the back axle
/** What the sensors say is fitted (ERFS: tire data written into the sensors from the tire's QR code). */
function sensorTire(v) {
    if (!v) return null;
    const mounted = name(v.tpmsErfsActTireDimSummerMounted);
    // its members are named differently from the axle structs: map them to tire()'s names
    const m = {
        width: v.tpmsErfsActTireDimSummerWidth, crossSection: v.tpmsErfsActTireDimSummerCrossSection, diameter: v.tpmsErfsActTireDimSummerDiameter,
        loadIndex: v.tpmsErfsActTireDimSummerLoadIndex, speedIndex: v.tpmsErfsActTireDimSummerSpeedIndex, carcass: v.tpmsErfsActTireDimSummerCarcass,
        season: v.tpmsErfsActTireDimSummerSeason, runflat: v.tpmsErfsActTireDimSummerRunflat,
    };
    const out = tire(m, '');
    return { mounted: mounted === 'TIRE_MOUNTED', state: mounted, tire: out };
}

// TyreState
const SELECTION = { AUSWAHL: 'Picked from the list', VERBAUT: 'Fitted (learned)', VERBAUT_FELGENSENSOR: 'Fitted (rim sensors)' };
const LOADING = { ECO_SOLLDRUCK: 'Eco / comfort', TEILBELADEN: 'Partly loaded', VOLLBELADEN: 'Fully loaded' };
const MANUAL = { AUTOMATISCHE_REIFENAUSWAHL: 'Automatic', MANUELLE_REIFENAUSWAHL: 'Manual' };
function tyreState(v) {
    if (!v) return null;
    return {
        selection: SELECTION[name(v.statusSelectionTyre)] || null, loading: LOADING[name(v.statusTargetPressureLoadingConditionTyrePressureControl)] || null,
        season: SEASON[name(v.statusTyreSeasonTyrePressureControl)] || null, mode: MANUAL[name(v.statusManualSelection)] || null,
        listLength: v.lengthObjectListTypeTyre > 0 && v.lengthObjectListTypeTyre < 255 ? v.lengthObjectListTypeTyre : null,
        // the iDrive menu's progress bar while it detects the tires: 0-100 %, then 253 when it failed (Nov 12: 0 -> 100
        // in about 2 min, then 253, then 254), 254 idle
        progress: v.qualifierRDCInitializationDisplay <= 100 ? v.qualifierRDCInitializationDisplay : v.qualifierRDCInitializationDisplay === 253 ? 'failed' : null,
    };
}

// FES.statusDSCSwitchHMI: what DSC is doing now (what the cluster shows)
const DSC = { DSC_EIN: 'on', DSC_AUS: 'off', TRAKTIONSMODUS_EIN: 'traction', ANFAHRHILFE_AKTIV: 'start-off assist' };
function dsc(v) { const n = name(v && v.displayStatusDSC2); return n ? { state: DSC[n] || 'unknown', raw: n } : null; }

/* ---------- the write ---------- */
// every member "no request": the receiving units ignore SIGNAL_UNGUELTIG / KEINE_* values
const NO_ACTION = Object.freeze({
    operationTyreSeasonTyrePressureControl: 'KEINE_AENDERUNG',
    operationTyrePressureControl: 'KEINE_AKTION',
    operationModeTractionDSC: 'SIGNAL_UNGUELTIG',
    operationTargetPressureLoadingConditionTyrePressureControl: 'SIGNAL_UNGUELTIG',
    requestObjectListTyrePressureControl: 'KEINE_LISTE_ANGEFORDERT',
    operationSelectionTyreAvailable: 255,
    operationIDRSelection: 'KEINE_AKTION',
    statusIDRMessageCenter: 'KEINE_AKTION_DURCHGEFUEHRT',
});
const DSC_KEY = 'operationModeTractionDSC';

/** The actions the app offers: name -> the members it changes (never the DSC member). */
const ACTIONS = {
    list: { requestObjectListTyrePressureControl: 'LISTE_ANGEFORDERT' },
    auto: { operationIDRSelection: 'AUTOMATISCHE_AUSWAHL' },
    pick: (id) => ({ operationIDRSelection: 'MANUELLE_AUSWAHL', operationSelectionTyreAvailable: id }),
    reset: { operationTyrePressureControl: 'RDC_S_RPA_SETZEN' },
    summer: { operationTyreSeasonTyrePressureControl: 'SOMMERREIFEN' },
    winter: { operationTyreSeasonTyrePressureControl: 'WINTERREIFEN' },
    eco: { operationTargetPressureLoadingConditionTyrePressureControl: 'ECO_SOLLDRUCK' },
    partly: { operationTargetPressureLoadingConditionTyrePressureControl: 'TEILBELADEN' },
    full: { operationTargetPressureLoadingConditionTyrePressureControl: 'VOLLBELADEN' },
};

/** The struct to send for an action (and argument), or throws. */
function build(action, arg) {
    const a = ACTIONS[action];
    if (!a) throw new Error('unknown action ' + action);
    const change = typeof a === 'function' ? a(arg) : a;
    if (Object.prototype.hasOwnProperty.call(change, DSC_KEY)) throw new Error('an action may not touch DSC');
    const out = Object.assign({}, NO_ACTION, change);
    check(out);
    return out;
}
/** Throws unless the struct leaves DSC alone and has exactly the known members. */
function check(s) {
    const keys = Object.keys(NO_ACTION);
    if (!s || s[DSC_KEY] !== 'SIGNAL_UNGUELTIG') throw new Error('refused: the DSC member must be SIGNAL_UNGUELTIG (no request), is ' + (s && s[DSC_KEY]));
    const extra = Object.keys(s).filter((k) => keys.indexOf(k) < 0);
    if (extra.length) throw new Error('refused: unknown members ' + extra.join(', '));
    const missing = keys.filter((k) => !(k in s));
    if (missing.length) throw new Error('refused: missing members ' + missing.join(', '));
    if (s.operationSelectionTyreAvailable !== 255 && !(s.operationSelectionTyreAvailable >= 0 && s.operationSelectionTyreAvailable < 255)) throw new Error('refused: bad tire id');
    return true;
}

module.exports = { TYRES, WHEEL, psi, degF, pressures, targets, temps, detection, calibration, listEntry, frontAxle, rearAxle, sensorTire,
    tyreState, dsc, NO_ACTION, ACTIONS, build, check };
