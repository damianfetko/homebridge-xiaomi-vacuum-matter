/**
 * Pure mapping between the robot's MIoT state and Matter RVC clusters.
 * No Homebridge / matter.js imports here so everything is unit-testable.
 */
import { ChargingState, CleaningType, FAULT_NAMES, SuctionLevel, VacuumState, WaterLevel } from '../device/spec.js';
import type { VacuumStatus } from '../device/vacuum.js';

// ------------------------------------------------------------- Matter enums
// Values from the Matter 1.4 specification (identical to matter.js 0.18 enums).

export const OpState = {
  Stopped: 0,
  Running: 1,
  Paused: 2,
  Error: 3,
  SeekingCharger: 64,
  Charging: 65,
  Docked: 66,
  EmptyingDustBin: 67,
  CleaningMop: 68,
  FillingWaterTank: 69,
  UpdatingMaps: 70,
} as const;

export const OpError = {
  NoError: 0,
  UnableToStartOrResume: 1,
  UnableToCompleteOperation: 2,
  CommandInvalidInState: 3,
  FailedToFindChargingDock: 64,
  Stuck: 65,
  DustBinMissing: 66,
  DustBinFull: 67,
  WaterTankEmpty: 68,
  WaterTankMissing: 69,
  WaterTankLidOpen: 70,
  MopCleaningPadMissing: 71,
  LowBattery: 72,
  CannotReachTargetArea: 73,
  DirtyWaterTankFull: 74,
  DirtyWaterTankMissing: 75,
  WheelsJammed: 76,
  BrushJammed: 77,
  NavigationSensorObscured: 78,
} as const;

export const ModeTag = {
  // common
  Auto: 0,
  Quick: 1,
  Quiet: 2,
  LowNoise: 3,
  LowEnergy: 4,
  Vacation: 5,
  Min: 6,
  Max: 7,
  Night: 8,
  Day: 9,
  // RvcRunMode
  Idle: 16384,
  Cleaning: 16385,
  Mapping: 16386,
  // RvcCleanMode
  DeepClean: 16384,
  Vacuum: 16385,
  Mop: 16386,
  VacuumThenMop: 16387,
} as const;

export const PowerSourceStatus = { Unspecified: 0, Active: 1, Standby: 2, Unavailable: 3 } as const;
export const BatChargeLevel = { Ok: 0, Warning: 1, Critical: 2 } as const;
export const BatChargeState = { Unknown: 0, IsCharging: 1, IsAtFullCharge: 2, IsNotCharging: 3 } as const;

// ---------------------------------------------------------------- run modes

export const RUN_MODE_IDLE = 0;
export const RUN_MODE_CLEANING = 1;

export type Language = 'en' | 'sk';

const RUN_LABELS: Record<Language, [string, string]> = {
  en: ['Idle', 'Cleaning'],
  sk: ['Nečinný', 'Upratovanie'],
};

export function runModes(lang: Language) {
  const [idle, cleaning] = RUN_LABELS[lang];
  return [
    { label: idle, mode: RUN_MODE_IDLE, modeTags: [{ value: ModeTag.Idle }] },
    { label: cleaning, mode: RUN_MODE_CLEANING, modeTags: [{ value: ModeTag.Cleaning }] },
  ];
}

// -------------------------------------------------------------- clean modes

export interface CleanModeDef {
  mode: number;
  labels: Record<Language, string>;
  tags: number[];
  type: CleaningType;
  suction: SuctionLevel;
  water: WaterLevel;
}

/**
 * Clean modes offered to Matter controllers. Every mode is a complete recipe
 * (cleaning type + suction + water) so selecting it in Apple Home always
 * results in a well defined robot configuration. Mode numbers are stable – do
 * not renumber, controllers persist them in scenes/automations.
 */
export const CLEAN_MODES: CleanModeDef[] = [
  { mode: 1, labels: { en: 'Vacuum Quiet', sk: 'Vysávanie – tiché' }, tags: [ModeTag.Vacuum, ModeTag.Quiet], type: CleaningType.Sweeping, suction: SuctionLevel.Quiet, water: WaterLevel.Medium },
  { mode: 2, labels: { en: 'Vacuum Standard', sk: 'Vysávanie – štandard' }, tags: [ModeTag.Vacuum, ModeTag.Auto], type: CleaningType.Sweeping, suction: SuctionLevel.Standard, water: WaterLevel.Medium },
  { mode: 3, labels: { en: 'Vacuum Strong', sk: 'Vysávanie – silné' }, tags: [ModeTag.Vacuum], type: CleaningType.Sweeping, suction: SuctionLevel.Strong, water: WaterLevel.Medium },
  { mode: 4, labels: { en: 'Vacuum Turbo', sk: 'Vysávanie – turbo' }, tags: [ModeTag.Vacuum, ModeTag.Max], type: CleaningType.Sweeping, suction: SuctionLevel.Turbo, water: WaterLevel.Medium },
  { mode: 10, labels: { en: 'Mop Low', sk: 'Mopovanie – málo vody' }, tags: [ModeTag.Mop, ModeTag.Min], type: CleaningType.Mopping, suction: SuctionLevel.Standard, water: WaterLevel.Low },
  { mode: 11, labels: { en: 'Mop Medium', sk: 'Mopovanie – stredne' }, tags: [ModeTag.Mop], type: CleaningType.Mopping, suction: SuctionLevel.Standard, water: WaterLevel.Medium },
  { mode: 12, labels: { en: 'Mop High', sk: 'Mopovanie – veľa vody' }, tags: [ModeTag.Mop, ModeTag.Max], type: CleaningType.Mopping, suction: SuctionLevel.Standard, water: WaterLevel.High },
  { mode: 20, labels: { en: 'Vacuum & Mop', sk: 'Vysávanie a mopovanie' }, tags: [ModeTag.Vacuum, ModeTag.Mop], type: CleaningType.SweepingAndMopping, suction: SuctionLevel.Standard, water: WaterLevel.Medium },
  { mode: 21, labels: { en: 'Vacuum & Mop Quiet', sk: 'Vysávanie a mopovanie – tiché' }, tags: [ModeTag.Vacuum, ModeTag.Mop, ModeTag.Quiet], type: CleaningType.SweepingAndMopping, suction: SuctionLevel.Quiet, water: WaterLevel.Low },
  { mode: 22, labels: { en: 'Vacuum & Mop Deep', sk: 'Vysávanie a mopovanie – hĺbkové' }, tags: [ModeTag.Vacuum, ModeTag.Mop, ModeTag.DeepClean], type: CleaningType.SweepingAndMopping, suction: SuctionLevel.Turbo, water: WaterLevel.High },
  { mode: 30, labels: { en: 'Vacuum then Mop', sk: 'Najprv vysávať, potom mopovať' }, tags: [ModeTag.VacuumThenMop], type: CleaningType.MoppingAfterSweeping, suction: SuctionLevel.Standard, water: WaterLevel.Medium },
];

export function cleanModes(lang: Language) {
  return CLEAN_MODES.map((m) => ({ label: m.labels[lang], mode: m.mode, modeTags: m.tags.map((value) => ({ value })) }));
}

export function findCleanMode(mode: number): CleanModeDef | undefined {
  return CLEAN_MODES.find((m) => m.mode === mode);
}

/**
 * Pick the Matter clean mode that best represents the robot's current
 * settings (they can also be changed in the Xiaomi Home app).
 * Exact match first, then same type with closest suction/water.
 */
export function cleanModeFromStatus(s: Pick<VacuumStatus, 'cleaningType' | 'suction' | 'waterLevel'>): number | undefined {
  if (s.cleaningType === undefined) {
    return undefined;
  }
  const candidates = CLEAN_MODES.filter((m) => m.type === s.cleaningType);
  if (candidates.length === 0) {
    return undefined;
  }
  const usesSuction = s.cleaningType !== CleaningType.Mopping;
  const usesWater = s.cleaningType !== CleaningType.Sweeping;
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const m of candidates) {
    const ds = usesSuction && s.suction !== undefined ? Math.abs(m.suction - s.suction) : 0;
    const dw = usesWater && s.waterLevel !== undefined ? Math.abs(m.water - s.waterLevel) : 0;
    // suction weighs more for vacuum modes, water for mop-only
    const score = usesSuction ? ds * 2 + dw : dw;
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best.mode;
}

// -------------------------------------------------------- operational state

export const OPERATIONAL_STATE_LIST = [
  OpState.Stopped,
  OpState.Running,
  OpState.Paused,
  OpState.Error,
  OpState.SeekingCharger,
  OpState.Charging,
  OpState.Docked,
  OpState.EmptyingDustBin,
  OpState.CleaningMop,
  OpState.FillingWaterTank,
  OpState.UpdatingMaps,
].map((operationalStateId) => ({ operationalStateId }));

/** Fault codes that are only warnings/notifications while the robot is not in the error state. */
export function isErrorActive(s: VacuumStatus): boolean {
  if (s.state === VacuumState.Error || (s.status === 12 && s.fault !== 0)) {
    return true;
  }
  // The robot halts a task and waits for the user (e.g. fault 107 "clean water
  // tank empty" while washing the mop at the station). Reported as paused by the
  // robot, but for a controller this is an error the user has to resolve.
  const halted = s.state === VacuumState.Paused || s.state === VacuumState.WashingMopPause || s.washStation === 4;
  return halted && s.fault !== 0;
}

export function operationalStateFromStatus(s: VacuumStatus): number {
  if (isErrorActive(s)) {
    return OpState.Error;
  }
  switch (s.state) {
    case VacuumState.Sweeping:
    case VacuumState.Mopping:
    case VacuumState.SweepingAndMopping:
    case VacuumState.RemoteClean:
    case VacuumState.GoWashing:
      return OpState.Running;
    case VacuumState.Building:
      return OpState.UpdatingMaps;
    case VacuumState.Paused:
    case VacuumState.WashingMopPause:
      return OpState.Paused;
    case VacuumState.GoCharging:
      return OpState.SeekingCharger;
    case VacuumState.Washing:
      return OpState.CleaningMop;
    case VacuumState.DustCollecting:
      return OpState.EmptyingDustBin;
    case VacuumState.WaterInspecting:
      return OpState.FillingWaterTank;
    case VacuumState.Charging:
      return (s.battery ?? 0) >= 100 ? OpState.Docked : OpState.Charging;
    case VacuumState.ChargingCompleted:
      return OpState.Docked;
    case VacuumState.Drying:
    case VacuumState.Idle:
    case VacuumState.Upgrading:
    default:
      // Drying happens on the dock while charging
      if (s.chargingState === ChargingState.Charging) {
        return (s.battery ?? 0) >= 100 ? OpState.Docked : OpState.Charging;
      }
      if (s.state === VacuumState.Drying) {
        return OpState.Docked;
      }
      return OpState.Stopped;
  }
}

export function runModeFromStatus(s: VacuumStatus, taskActive: boolean): number {
  if (taskActive) {
    return RUN_MODE_CLEANING;
  }
  switch (s.state) {
    case VacuumState.Sweeping:
    case VacuumState.Mopping:
    case VacuumState.SweepingAndMopping:
    case VacuumState.RemoteClean:
    case VacuumState.Building:
    case VacuumState.Paused:
    case VacuumState.GoWashing:
    case VacuumState.WashingMopPause:
      return RUN_MODE_CLEANING;
    default:
      return RUN_MODE_IDLE;
  }
}

export function errorStateId(fault: number): number {
  if (fault === 0) {
    return OpError.NoError;
  }
  const map: Array<[number[], number]> = [
    [[19, 1000], OpError.FailedToFindChargingDock],
    [[15, 16, 31, 32, 1, 6], OpError.WheelsJammed],
    [[12, 13, 71], OpError.BrushJammed],
    [[8, 102], OpError.DustBinMissing],
    [[11, 101, 121], OpError.DustBinFull],
    [[10, 107, 116], OpError.WaterTankEmpty],
    [[9, 105], OpError.WaterTankMissing],
    [[68, 69, 74, 85, 111, 120, 126], OpError.MopCleaningPadMissing],
    [[20, 22, 75], OpError.LowBattery],
    [[59, 61, 65, 78], OpError.CannotReachTargetArea],
    [[86, 118], OpError.DirtyWaterTankFull],
    [[76, 106], OpError.DirtyWaterTankMissing],
    [[2, 7, 24, 26, 27, 39, 40, 48, 49, 54, 56, 58, 79], OpError.NavigationSensorObscured],
    [[3, 4, 5, 17, 18, 25, 47, 80, 81, 82, 88, 91, 92, 93, 94, 95, 96, 97, 98, 99, 200], OpError.Stuck],
  ];
  for (const [codes, id] of map) {
    if (codes.includes(fault)) {
      return id;
    }
  }
  return OpError.UnableToCompleteOperation;
}

export function operationalErrorFromStatus(s: VacuumStatus) {
  if (!isErrorActive(s)) {
    return { errorStateId: OpError.NoError };
  }
  const name = FAULT_NAMES[s.fault] ?? `Error ${s.fault}`;
  // Only standard error ids are used: Matter allows ErrorStateLabel solely for
  // manufacturer ids (128-191), and Homebridge cannot remove a label once set
  // (struct updates are merged), so a label would break every later update.
  return { errorStateId: errorStateId(s.fault), errorStateDetails: `${name} (Xiaomi fault ${s.fault})`.slice(0, 64) };
}

// ----------------------------------------------------------------- battery

export function powerSourceFromStatus(s: VacuumStatus) {
  const pct = Math.max(0, Math.min(100, s.battery ?? 0));
  const onDock = s.chargingState === ChargingState.Charging || s.state === VacuumState.Charging || s.state === VacuumState.ChargingCompleted;
  let batChargeState: number = BatChargeState.IsNotCharging;
  if (onDock) {
    batChargeState = pct >= 100 || s.state === VacuumState.ChargingCompleted ? BatChargeState.IsAtFullCharge : BatChargeState.IsCharging;
  }
  return {
    batPercentRemaining: pct * 2,
    batChargeLevel: pct <= 10 ? BatChargeLevel.Critical : pct <= 20 ? BatChargeLevel.Warning : BatChargeLevel.Ok,
    batChargeState,
  };
}

// ------------------------------------------------------------- service area

export const AREA_TYPES: Record<string, number> = {"Aisle":0,"Attic":1,"BackDoor":2,"BackYard":3,"Balcony":4,"Ballroom":5,"Bathroom":6,"Bedroom":7,"Border":8,"Boxroom":9,"BreakfastRoom":10,"Carport":11,"Cellar":12,"Cloakroom":13,"Closet":14,"Conservatory":15,"Corridor":16,"CraftRoom":17,"Cupboard":18,"Deck":19,"Den":20,"Dining":21,"DrawingRoom":22,"DressingRoom":23,"Driveway":24,"Elevator":25,"Ensuite":26,"Entrance":27,"Entryway":28,"FamilyRoom":29,"Foyer":30,"FrontDoor":31,"FrontYard":32,"GameRoom":33,"Garage":34,"GarageDoor":35,"Garden":36,"GardenDoor":37,"GuestBathroom":38,"GuestBedroom":39,"GuestRoom":41,"Gym":42,"Hallway":43,"HearthRoom":44,"KidsRoom":45,"KidsBedroom":46,"Kitchen":47,"LaundryRoom":49,"Lawn":50,"Library":51,"LivingRoom":52,"Lounge":53,"MediaTvRoom":54,"MudRoom":55,"MusicRoom":56,"Nursery":57,"Office":58,"OutdoorKitchen":59,"Outside":60,"Pantry":61,"ParkingLot":62,"Parlor":63,"Patio":64,"PlayRoom":65,"PoolRoom":66,"Porch":67,"PrimaryBathroom":68,"PrimaryBedroom":69,"Ramp":70,"ReceptionRoom":71,"RecreationRoom":72,"Roof":74,"Sauna":75,"Scullery":76,"SewingRoom":77,"Shed":78,"SideDoor":79,"SideYard":80,"SittingRoom":81,"Snug":82,"Spa":83,"Staircase":84,"SteamRoom":85,"StorageRoom":86,"Studio":87,"Study":88,"SunRoom":89,"SwimmingPool":90,"Terrace":91,"UtilityRoom":92,"Ward":93,"Workshop":94,"Toilet":95};

export interface RoomConfig {
  id: number;
  name: string;
  areaType?: string;
  floor?: number;
}

export function resolveAreaType(type: string | undefined): number | null {
  if (!type) {
    return null;
  }
  const key = Object.keys(AREA_TYPES).find((k) => k.toLowerCase() === type.replace(/[\s_-]/g, '').toLowerCase());
  return key === undefined ? null : AREA_TYPES[key];
}

export function validateRooms(rooms: unknown): { rooms: RoomConfig[]; errors: string[] } {
  const errors: string[] = [];
  const out: RoomConfig[] = [];
  if (rooms === undefined) {
    return { rooms: out, errors };
  }
  if (!Array.isArray(rooms)) {
    return { rooms: out, errors: ['"rooms" must be an array'] };
  }
  const seen = new Set<number>();
  for (const [i, r] of rooms.entries()) {
    const id = Number(r?.id);
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    if (!Number.isInteger(id) || id < 1 || id > 0xffff) {
      errors.push(`rooms[${i}]: invalid id "${r?.id}"`);
      continue;
    }
    if (!name) {
      errors.push(`rooms[${i}]: missing name`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`rooms[${i}]: duplicate id ${id}`);
      continue;
    }
    if (r.areaType && resolveAreaType(r.areaType) === null) {
      errors.push(`rooms[${i}]: unknown areaType "${r.areaType}" (ignored)`);
    }
    seen.add(id);
    out.push({ id, name: name.slice(0, 128), areaType: r.areaType, floor: Number.isInteger(r.floor) ? r.floor : undefined });
  }
  return { rooms: out, errors };
}

export function supportedAreas(rooms: RoomConfig[]) {
  return rooms.map((r) => ({
    areaId: r.id,
    mapId: null,
    areaInfo: {
      locationInfo: {
        locationName: r.name,
        floorNumber: r.floor ?? null,
        areaType: resolveAreaType(r.areaType),
      },
      landmarkInfo: null,
    },
  }));
}

/**
 * Homebridge merges struct updates field by field, so details from a previous
 * error would survive into the next state. Always send both fields (matter.js rejects null, so "" means none).
 */
export function completeOperationalError(e: { errorStateId: number; errorStateDetails?: string }) {
  return { errorStateId: e.errorStateId, errorStateDetails: e.errorStateDetails ?? "" };
}
