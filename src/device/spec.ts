/**
 * MIoT specification of the Xiaomi Robot Vacuum X20+ (xiaomi.vacuum.c102gl),
 * a Dreame based robot. Verified against the device (fw 4.5.6_1087) and
 * https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:vacuum:0000A006:xiaomi-c102gl:1
 */

export const SUPPORTED_MODELS = ['xiaomi.vacuum.c102gl'];

export const PROP = {
  // siid 2 – vacuum
  state: { siid: 2, piid: 1 },
  fault: { siid: 2, piid: 2 },
  suction: { siid: 2, piid: 3 }, // rw, mirrors 4.4
  // siid 3 – battery
  battery: { siid: 3, piid: 1 },
  chargingState: { siid: 3, piid: 2 },
  // siid 4 – vacuum-extend (Dreame)
  status: { siid: 4, piid: 1 },
  cleaningTime: { siid: 4, piid: 2 }, // minutes
  cleanedArea: { siid: 4, piid: 3 }, // m²
  waterLevel: { siid: 4, piid: 5 }, // rw 1..3
  waterTank: { siid: 4, piid: 6 },
  taskStatus: { siid: 4, piid: 7 },
  resumeCleaning: { siid: 4, piid: 11 },
  carpetBoost: { siid: 4, piid: 12 },
  faults: { siid: 4, piid: 18 },
  cleaningMode: { siid: 4, piid: 23 }, // rw, grouped value (low 2 bits = cleaning type)
  washStation: { siid: 4, piid: 25 },
  childLock: { siid: 4, piid: 27 },
  // consumables
  mainBrushLeft: { siid: 9, piid: 1 },
  mainBrushLife: { siid: 9, piid: 2 },
  sideBrushLeft: { siid: 10, piid: 1 },
  sideBrushLife: { siid: 10, piid: 2 },
  filterLife: { siid: 11, piid: 1 },
  filterLeft: { siid: 11, piid: 2 },
  mopLife: { siid: 18, piid: 1 },
  mopLeft: { siid: 18, piid: 2 },
  // misc
  volume: { siid: 7, piid: 1 },
  dndEnabled: { siid: 5, piid: 1 },
  totalCleanTime: { siid: 12, piid: 2 },
  totalCleanCount: { siid: 12, piid: 3 },
  totalCleanArea: { siid: 12, piid: 4 },
} as const;

export type PropName = keyof typeof PROP;

export const ACTION = {
  start: { siid: 2, aiid: 1 }, // start / resume
  pause: { siid: 2, aiid: 2 },
  autoEmpty: { siid: 2, aiid: 4 },
  washMop: { siid: 2, aiid: 6 },
  startDrying: { siid: 2, aiid: 8 },
  stopDrying: { siid: 2, aiid: 9 },
  dock: { siid: 3, aiid: 1 },
  startCustom: { siid: 4, aiid: 1 }, // in: 4.1 status, 4.10 parameters
  stop: { siid: 4, aiid: 2 },
  locate: { siid: 7, aiid: 1 },
  resetMainBrush: { siid: 9, aiid: 1 },
  resetSideBrush: { siid: 10, aiid: 1 },
  resetFilter: { siid: 11, aiid: 1 },
  resetMop: { siid: 18, aiid: 1 },
} as const;

/** 2.1 – robot state */
export enum VacuumState {
  Sweeping = 1,
  Idle = 2,
  Paused = 3,
  Error = 4,
  GoCharging = 5,
  Charging = 6,
  Mopping = 7,
  Drying = 8,
  Washing = 9,
  GoWashing = 10,
  Building = 11,
  SweepingAndMopping = 12,
  ChargingCompleted = 13,
  Upgrading = 14,
  WaterInspecting = 19,
  WashingMopPause = 21,
  DustCollecting = 22,
  RemoteClean = 23,
}

/** 4.1 – Dreame status */
export enum DreameStatus {
  Idle = 0,
  Paused = 1,
  Cleaning = 2,
  BackHome = 3,
  PartialCleaning = 4,
  FollowWall = 5,
  Charging = 6,
  Ota = 7,
  PowerOff = 10,
  Error = 12,
  RemoteControl = 13,
  Sleeping = 14,
  SelfRepair = 15,
  Standby = 17,
  SegmentCleaning = 18,
  ZoneCleaning = 19,
  SpotCleaning = 20,
  FastMapping = 21,
}

/** 3.2 */
export enum ChargingState {
  Charging = 1,
  NotCharging = 2,
  GoCharging = 5,
}

/** 2.3 / 4.4 */
export enum SuctionLevel {
  Quiet = 0,
  Standard = 1,
  Strong = 2,
  Turbo = 3,
}

/** 4.5 */
export enum WaterLevel {
  Low = 1,
  Medium = 2,
  High = 3,
}

/** Logical cleaning type (Dreame enum). */
export enum CleaningType {
  Sweeping = 0,
  Mopping = 1,
  SweepingAndMopping = 2,
  MoppingAfterSweeping = 3,
}

/** 4.7 – task status values that mean "no task". */
export const TASK_COMPLETED = 0;

/**
 * 4.23 on robots with mop pad lifting + self wash base packs three values:
 *   bits 0-1  cleaning type (device encoding: 0 = sweep+mop, 1 = mop, 2 = sweep, 3 = mop after sweep)
 *   bits 8-15 self clean value (mop wash frequency)
 *   bits 16+  extra flags
 * Mapping verified against Tasshack/dreame-vacuum (split_group_value / _update_cleaning_mode).
 */
export function decodeCleaningType(raw: number): CleaningType {
  const low = raw & 0x03;
  if (low === 0) {
    return CleaningType.SweepingAndMopping;
  }
  if (low === 2) {
    return CleaningType.Sweeping;
  }
  return low as CleaningType;
}

export function encodeCleaningType(raw: number, type: CleaningType): number {
  let low: number = type;
  if (type === CleaningType.SweepingAndMopping) {
    low = 0;
  } else if (type === CleaningType.Sweeping) {
    low = 2;
  }
  return (raw & ~0x03) | low;
}

/** Human readable names of the Dreame fault codes (2.2). */
export const FAULT_NAMES: Record<number, string> = {
  1: 'Wheel dropped',
  2: 'Cliff sensor error',
  3: 'Bumper stuck',
  4: 'Robot tilted',
  5: 'Bumper stuck (repeated)',
  6: 'Wheel dropped (repeated)',
  7: 'Optical flow sensor error',
  8: 'Dust bin missing',
  9: 'Water tank missing',
  10: 'Water tank empty',
  11: 'Dust bin full',
  12: 'Main brush jammed',
  13: 'Side brush jammed',
  14: 'Fan error',
  15: 'Left wheel motor error',
  16: 'Right wheel motor error',
  17: 'Robot stuck (turning)',
  18: 'Robot stuck (moving forward)',
  19: 'Charging station not found',
  20: 'Battery low',
  21: 'Charging fault',
  22: 'Battery percentage error',
  23: 'Heart error',
  24: 'Camera blocked',
  25: 'Move error',
  26: 'Flow sensor blocked',
  27: 'Infrared sensor blocked',
  28: 'Charging station has no power',
  29: 'Battery fault',
  30: 'Fan speed error',
  31: 'Left wheel speed error',
  32: 'Right wheel speed error',
  36: 'Left magnet error',
  37: 'Right magnet error',
  38: 'Flow error',
  39: 'Infrared fault',
  40: 'Camera fault',
  41: 'Strong magnetic field',
  42: 'Water pump error',
  43: 'RTC error',
  44: 'Auto key triggered',
  46: 'Camera idle',
  47: 'Robot blocked',
  48: 'LiDAR error',
  49: 'LiDAR bumper error',
  51: 'Filter blocked',
  54: 'Edge sensor error',
  55: 'Carpet detected',
  56: 'Laser sensor error',
  58: 'Ultrasonic sensor error',
  59: 'Robot in no-go zone',
  61: 'Route blocked',
  65: 'Robot in restricted area',
  68: 'Remove mop',
  69: 'Mop removed',
  71: 'Mop pad stopped rotating',
  74: 'Mop installation failed',
  75: 'Low battery, turning off',
  76: 'Dirty water tank not installed',
  78: 'Robot in hidden room',
  79: 'LiDAR failed to lift',
  80: 'Robot stuck',
  81: 'Robot stuck (repeated)',
  82: 'Slippery floor',
  84: 'Unknown error',
  85: 'Check mop installation',
  86: 'Dirty water tank full',
  88: 'Retractable leg stuck',
  89: 'Internal error',
  91: 'Robot stuck on table',
  92: 'Robot stuck in passage',
  93: 'Robot stuck on threshold',
  94: 'Robot stuck under furniture',
  95: 'Robot stuck on ramp',
  96: 'Robot stuck on obstacle',
  97: 'Robot stuck on pet',
  98: 'Robot stuck on slippery surface',
  99: 'Robot stuck on carpet',
  101: 'Dust bin full',
  102: 'Dust bin open',
  105: 'Clean water tank missing',
  106: 'Dirty water tank missing',
  107: 'Clean water tank empty',
  109: 'Dirty water tank blocked',
  110: 'Dirty water tank pump error',
  111: 'Mop pad missing',
  112: 'Mop pad wet',
  114: 'Clean the mop pad',
  116: 'Clean water tank level low',
  117: 'Station disconnected',
  118: 'Dirty water tank level high',
  119: 'Washboard level error',
  120: 'No mop in station',
  121: 'Dust bag full',
  122: 'Warning',
  123: 'Self test failed',
  124: 'Washboard not working',
  125: 'Drainage failed',
  126: 'Mop not detected',
  127: 'Mop holder error',
  128: 'Dock error',
  129: 'Mop wash failed',
  1000: 'Return to dock failed',
};
