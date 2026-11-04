import { describe, expect, it } from 'vitest';
import { CleaningType, SuctionLevel, VacuumState, WaterLevel } from '../src/device/spec.js';
import type { VacuumStatus } from '../src/device/vacuum.js';
import {
  BatChargeLevel,
  BatChargeState,
  CLEAN_MODES,
  cleanModeFromStatus,
  cleanModes,
  errorStateId,
  ModeTag,
  OpError,
  operationalErrorFromStatus,
  operationalStateFromStatus,
  OpState,
  powerSourceFromStatus,
  resolveAreaType,
  RUN_MODE_CLEANING,
  RUN_MODE_IDLE,
  runModeFromStatus,
  runModes,
  supportedAreas,
  validateRooms,
} from '../src/matter/mapping.js';

const base: VacuumStatus = { online: true, fault: 0, battery: 80, chargingState: 2 };
const st = (o: Partial<VacuumStatus>): VacuumStatus => ({ ...base, ...o });

describe('operational state', () => {
  it.each([
    [VacuumState.Sweeping, OpState.Running],
    [VacuumState.Mopping, OpState.Running],
    [VacuumState.SweepingAndMopping, OpState.Running],
    [VacuumState.GoWashing, OpState.Running],
    [VacuumState.Paused, OpState.Paused],
    [VacuumState.WashingMopPause, OpState.Paused],
    [VacuumState.GoCharging, OpState.SeekingCharger],
    [VacuumState.Washing, OpState.CleaningMop],
    [VacuumState.DustCollecting, OpState.EmptyingDustBin],
    [VacuumState.WaterInspecting, OpState.FillingWaterTank],
    [VacuumState.Building, OpState.UpdatingMaps],
    [VacuumState.ChargingCompleted, OpState.Docked],
    [VacuumState.Error, OpState.Error],
    [VacuumState.Idle, OpState.Stopped],
  ])('state %i -> %i', (state, op) => {
    expect(operationalStateFromStatus(st({ state }))).toBe(op);
  });

  it('charging vs docked depends on battery', () => {
    expect(operationalStateFromStatus(st({ state: VacuumState.Charging, battery: 50 }))).toBe(OpState.Charging);
    expect(operationalStateFromStatus(st({ state: VacuumState.Charging, battery: 100 }))).toBe(OpState.Docked);
  });

  it('drying on the dock reports charging/docked', () => {
    expect(operationalStateFromStatus(st({ state: VacuumState.Drying, chargingState: 1, battery: 70 }))).toBe(OpState.Charging);
    expect(operationalStateFromStatus(st({ state: VacuumState.Drying, chargingState: 1, battery: 100 }))).toBe(OpState.Docked);
    expect(operationalStateFromStatus(st({ state: VacuumState.Drying, chargingState: 2 }))).toBe(OpState.Docked);
  });

  it('idle while charging reports charging', () => {
    expect(operationalStateFromStatus(st({ state: VacuumState.Idle, chargingState: 1, battery: 40 }))).toBe(OpState.Charging);
  });

  it('a fault code alone (warning) is not an error', () => {
    expect(operationalStateFromStatus(st({ state: VacuumState.ChargingCompleted, fault: 101 }))).toBe(OpState.Docked);
    expect(operationalErrorFromStatus(st({ state: VacuumState.ChargingCompleted, fault: 101 }))).toEqual({ errorStateId: OpError.NoError });
  });

  it('reports error details', () => {
    const e = operationalErrorFromStatus(st({ state: VacuumState.Error, fault: 80 }));
    expect(e.errorStateId).toBe(OpError.Stuck);
    expect(e.errorStateLabel).toBe('Robot stuck');
    expect(e.errorStateLabel!.length).toBeLessThanOrEqual(64);
  });

  it('a task halted at the station with a fault is an error (observed on the real X20+: 2.1=21, 4.25=4, 2.2=107)', () => {
    const s = st({ state: VacuumState.WashingMopPause, status: 6, taskStatus: 1, washStation: 4, fault: 107 });
    expect(operationalStateFromStatus(s)).toBe(OpState.Error);
    expect(operationalErrorFromStatus(s)).toMatchObject({ errorStateId: OpError.WaterTankEmpty, errorStateLabel: 'Clean water tank empty' });
    expect(runModeFromStatus(s, true)).toBe(RUN_MODE_CLEANING);
    // paused by the user without a fault stays paused
    expect(operationalStateFromStatus(st({ state: VacuumState.Paused, fault: 0 }))).toBe(OpState.Paused);
  });

  it('dreame status 12 + fault means error', () => {
    expect(operationalStateFromStatus(st({ state: VacuumState.Idle, status: 12, fault: 12 }))).toBe(OpState.Error);
  });
});

describe('error mapping', () => {
  it.each([
    [0, OpError.NoError],
    [19, OpError.FailedToFindChargingDock],
    [12, OpError.BrushJammed],
    [13, OpError.BrushJammed],
    [15, OpError.WheelsJammed],
    [11, OpError.DustBinFull],
    [8, OpError.DustBinMissing],
    [107, OpError.WaterTankEmpty],
    [105, OpError.WaterTankMissing],
    [111, OpError.MopCleaningPadMissing],
    [20, OpError.LowBattery],
    [86, OpError.DirtyWaterTankFull],
    [106, OpError.DirtyWaterTankMissing],
    [48, OpError.NavigationSensorObscured],
    [59, OpError.CannotReachTargetArea],
    [97, OpError.Stuck],
    [250, OpError.UnableToCompleteOperation],
  ])('fault %i -> %i', (fault, id) => {
    expect(errorStateId(fault)).toBe(id);
  });
});

describe('run mode', () => {
  it('reports cleaning while a task is active', () => {
    expect(runModeFromStatus(st({ state: VacuumState.GoCharging }), true)).toBe(RUN_MODE_CLEANING);
    expect(runModeFromStatus(st({ state: VacuumState.Sweeping }), false)).toBe(RUN_MODE_CLEANING);
    expect(runModeFromStatus(st({ state: VacuumState.ChargingCompleted }), false)).toBe(RUN_MODE_IDLE);
    expect(runModeFromStatus(st({ state: VacuumState.GoCharging }), false)).toBe(RUN_MODE_IDLE);
  });

  it('satisfies matter.js constraints (Idle + Cleaning tag, exclusive)', () => {
    for (const lang of ['en', 'sk'] as const) {
      const modes = runModes(lang);
      expect(modes.some((m) => m.modeTags.some((t) => t.value === ModeTag.Idle))).toBe(true);
      expect(modes.some((m) => m.modeTags.some((t) => t.value === ModeTag.Cleaning))).toBe(true);
      for (const m of modes) {
        expect(m.modeTags).toHaveLength(1);
      }
    }
  });
});

describe('clean modes', () => {
  it('have unique ids, labels and tags', () => {
    const ids = CLEAN_MODES.map((m) => m.mode);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lang of ['en', 'sk'] as const) {
      const list = cleanModes(lang);
      expect(new Set(list.map((m) => m.label)).size).toBe(list.length);
      for (const m of list) {
        expect(m.label.length).toBeLessThanOrEqual(64);
        expect(m.modeTags.length).toBeGreaterThan(0);
        expect(new Set(m.modeTags.map((t) => t.value)).size).toBe(m.modeTags.length);
        expect(m.mode).toBeLessThanOrEqual(254);
      }
    }
  });

  it('maps exact device settings to the right mode', () => {
    for (const m of CLEAN_MODES) {
      expect(cleanModeFromStatus({ cleaningType: m.type, suction: m.suction, waterLevel: m.water })).toBe(m.mode);
    }
  });

  it('picks the closest mode for settings made in the Xiaomi app', () => {
    // sweep+mop, strong suction, medium water -> "Vacuum & Mop" (standard)
    expect(cleanModeFromStatus({ cleaningType: CleaningType.SweepingAndMopping, suction: SuctionLevel.Strong, waterLevel: WaterLevel.Medium })).toBe(20);
    // mopping ignores suction
    expect(cleanModeFromStatus({ cleaningType: CleaningType.Mopping, suction: SuctionLevel.Turbo, waterLevel: WaterLevel.High })).toBe(12);
    // vacuum ignores water
    expect(cleanModeFromStatus({ cleaningType: CleaningType.Sweeping, suction: SuctionLevel.Turbo, waterLevel: WaterLevel.Low })).toBe(4);
    // real device state read during analysis: 4.23 = 133120, suction 1, water 2
    expect(cleanModeFromStatus({ cleaningType: CleaningType.SweepingAndMopping, suction: 1, waterLevel: 2 })).toBe(20);
    expect(cleanModeFromStatus({ cleaningType: undefined })).toBeUndefined();
  });
});

describe('battery', () => {
  it('converts percentage and charge state', () => {
    expect(powerSourceFromStatus(st({ battery: 100, state: VacuumState.ChargingCompleted, chargingState: 1 }))).toEqual({
      batPercentRemaining: 200, batChargeLevel: BatChargeLevel.Ok, batChargeState: BatChargeState.IsAtFullCharge,
    });
    expect(powerSourceFromStatus(st({ battery: 15, state: VacuumState.Sweeping, chargingState: 2 }))).toEqual({
      batPercentRemaining: 30, batChargeLevel: BatChargeLevel.Warning, batChargeState: BatChargeState.IsNotCharging,
    });
    expect(powerSourceFromStatus(st({ battery: 5, state: VacuumState.Charging, chargingState: 1 })).batChargeLevel).toBe(BatChargeLevel.Critical);
    expect(powerSourceFromStatus(st({ battery: 5, state: VacuumState.Charging, chargingState: 1 })).batChargeState).toBe(BatChargeState.IsCharging);
  });
});

describe('rooms', () => {
  it('validates the config', () => {
    const { rooms, errors } = validateRooms([
      { id: 1, name: 'Obývačka', areaType: 'LivingRoom' },
      { id: 2, name: ' Kuchyňa ', areaType: 'kitchen' },
      { id: 2, name: 'dup' },
      { id: 'x', name: 'bad' },
      { id: 5 },
      { id: 6, name: 'Chodba', areaType: 'nope' },
    ]);
    expect(rooms.map((r) => r.id)).toEqual([1, 2, 6]);
    expect(rooms[1].name).toBe('Kuchyňa');
    expect(errors).toHaveLength(4);
    expect(validateRooms('x').errors).toHaveLength(1);
    expect(validateRooms(undefined).rooms).toEqual([]);
  });

  it('resolves area types case-insensitively', () => {
    expect(resolveAreaType('LivingRoom')).toBe(52);
    expect(resolveAreaType('living room')).toBe(52);
    expect(resolveAreaType('Kitchen')).toBe(47);
    expect(resolveAreaType('unknown')).toBeNull();
    expect(resolveAreaType(undefined)).toBeNull();
  });

  it('builds ServiceArea supportedAreas without maps', () => {
    expect(supportedAreas([{ id: 3, name: 'Spálňa', areaType: 'Bedroom', floor: 1 }])).toEqual([
      { areaId: 3, mapId: null, areaInfo: { locationInfo: { locationName: 'Spálňa', floorNumber: 1, areaType: 7 }, landmarkInfo: null } },
    ]);
  });
});
