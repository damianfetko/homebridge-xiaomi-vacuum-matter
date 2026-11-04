import { EventEmitter } from 'node:events';
import { MiioClient, type MiioClientOptions } from '../miio/client.js';
import {
  ACTION,
  CleaningType,
  decodeCleaningType,
  encodeCleaningType,
  PROP,
  type PropName,
  SuctionLevel,
  TASK_COMPLETED,
  VacuumState,
  WaterLevel,
} from './spec.js';

export interface VacuumStatus {
  online: boolean;
  state?: VacuumState;
  fault: number;
  status?: number;
  taskStatus?: number;
  battery?: number;
  chargingState?: number;
  suction?: SuctionLevel;
  waterLevel?: WaterLevel;
  cleaningModeRaw?: number;
  cleaningType?: CleaningType;
  waterTank?: number;
  washStation?: number;
  cleaningTime?: number;
  cleanedArea?: number;
  mainBrushLife?: number;
  sideBrushLife?: number;
  filterLife?: number;
  mopLife?: number;
  childLock?: number;
  volume?: number;
  totalCleanCount?: number;
  totalCleanArea?: number;
  totalCleanTime?: number;
}

export interface VacuumOptions extends MiioClientOptions {
  /** Poll interval while idle/docked (ms). */
  pollInterval?: number;
  /** Poll interval while cleaning or right after a command (ms). */
  activePollInterval?: number;
}

/** Properties polled on every cycle. Order matters only for readability. */
const POLLED: PropName[] = [
  'state', 'fault', 'suction', 'battery', 'chargingState', 'status', 'cleaningTime', 'cleanedArea',
  'waterLevel', 'waterTank', 'taskStatus', 'cleaningMode', 'washStation', 'childLock',
  'mainBrushLife', 'sideBrushLife', 'filterLife', 'mopLife', 'volume',
  'totalCleanTime', 'totalCleanCount', 'totalCleanArea',
];

const ACTIVE_STATES = new Set<VacuumState>([
  VacuumState.Sweeping, VacuumState.Mopping, VacuumState.SweepingAndMopping, VacuumState.GoWashing,
  VacuumState.Building, VacuumState.RemoteClean, VacuumState.Paused, VacuumState.WashingMopPause,
]);

export interface CleanRoomsOptions {
  repeats?: number;
  suction?: SuctionLevel;
  water?: WaterLevel;
}

export class XiaomiVacuum extends EventEmitter {
  readonly client: MiioClient;
  private _status: VacuumStatus = { online: false, fault: 0 };
  private timer?: NodeJS.Timeout;
  private boostUntil = 0;
  private stopped = true;
  private polling?: Promise<VacuumStatus>;
  private readonly pollInterval: number;
  private readonly activePollInterval: number;

  constructor(options: VacuumOptions, client?: MiioClient) {
    super();
    this.client = client ?? new MiioClient(options);
    this.pollInterval = options.pollInterval ?? 15_000;
    this.activePollInterval = options.activePollInterval ?? 4_000;
  }

  get status(): VacuumStatus {
    return this._status;
  }

  /** True while the robot is working on a task (cleaning, paused, returning, washing mid-task). */
  isTaskActive(s: VacuumStatus = this._status): boolean {
    if (s.taskStatus !== undefined && s.taskStatus !== TASK_COMPLETED) {
      return true;
    }
    return s.state !== undefined && ACTIVE_STATES.has(s.state);
  }

  isPaused(s: VacuumStatus = this._status): boolean {
    return s.state === VacuumState.Paused || s.state === VacuumState.WashingMopPause;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.client.close();
  }

  private schedule(delay: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.refresh()
        .catch(() => undefined)
        .finally(() => this.schedule(this.nextInterval()));
    }, delay);
  }

  private nextInterval(): number {
    if (!this._status.online) {
      return Math.min(this.pollInterval, 30_000);
    }
    if (Date.now() < this.boostUntil || this.isTaskActive()) {
      return this.activePollInterval;
    }
    return this.pollInterval;
  }

  /** Poll faster for a while (after a command, the robot changes state within seconds). */
  boost(ms = 60_000, firstDelay = 1500): void {
    this.boostUntil = Date.now() + ms;
    this.schedule(firstDelay);
  }

  /** Read all polled properties. Concurrent callers share one request. */
  refresh(): Promise<VacuumStatus> {
    if (!this.polling) {
      this.polling = this.doRefresh().finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  private async doRefresh(): Promise<VacuumStatus> {
    try {
      const refs = POLLED.map((name) => PROP[name]);
      const results = await this.client.getProperties(refs);
      const values: Partial<Record<PropName, any>> = {};
      for (const r of results) {
        const name = POLLED.find((n) => PROP[n].siid === r.siid && PROP[n].piid === r.piid);
        if (name && r.code === 0) {
          values[name] = r.value;
        }
      }
      const next = XiaomiVacuum.buildStatus(values);
      this.applyStatus(next);
      return next;
    } catch (err) {
      this.applyStatus({ ...this._status, online: false });
      this.emit('error', err);
      throw err;
    }
  }

  static buildStatus(v: Partial<Record<PropName, any>>): VacuumStatus {
    const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    const raw = num(v.cleaningMode);
    return {
      online: true,
      state: num(v.state),
      fault: num(v.fault) ?? 0,
      status: num(v.status),
      taskStatus: num(v.taskStatus),
      battery: num(v.battery),
      chargingState: num(v.chargingState),
      suction: num(v.suction),
      waterLevel: num(v.waterLevel),
      cleaningModeRaw: raw,
      cleaningType: raw === undefined ? undefined : decodeCleaningType(raw),
      waterTank: num(v.waterTank),
      washStation: num(v.washStation),
      cleaningTime: num(v.cleaningTime),
      cleanedArea: num(v.cleanedArea),
      mainBrushLife: num(v.mainBrushLife),
      sideBrushLife: num(v.sideBrushLife),
      filterLife: num(v.filterLife),
      mopLife: num(v.mopLife),
      childLock: num(v.childLock),
      volume: num(v.volume),
      totalCleanCount: num(v.totalCleanCount),
      totalCleanArea: num(v.totalCleanArea),
      totalCleanTime: num(v.totalCleanTime),
    };
  }

  /** Emits 'update' on changes and 'poll' after every refresh (also when unchanged). */
  private applyStatus(next: VacuumStatus): void {
    const prev = this._status;
    this._status = next;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      this.emit('update', next, prev);
    }
    this.emit('poll', next);
  }

  // ---------------------------------------------------------------- commands

  private async command<T>(fn: () => Promise<T>): Promise<T> {
    const result = await fn();
    this.boost();
    return result;
  }

  /** Full house clean, or resume when paused. */
  startCleaning(): Promise<void> {
    return this.command(() => this.client.action(ACTION.start.siid, ACTION.start.aiid));
  }

  resume(): Promise<void> {
    return this.startCleaning();
  }

  pause(): Promise<void> {
    return this.command(() => this.client.action(ACTION.pause.siid, ACTION.pause.aiid));
  }

  stopCleaning(): Promise<void> {
    return this.command(() => this.client.action(ACTION.stop.siid, ACTION.stop.aiid));
  }

  dock(): Promise<void> {
    return this.command(() => this.client.action(ACTION.dock.siid, ACTION.dock.aiid));
  }

  locate(): Promise<void> {
    return this.client.action(ACTION.locate.siid, ACTION.locate.aiid);
  }

  autoEmpty(): Promise<void> {
    return this.command(() => this.client.action(ACTION.autoEmpty.siid, ACTION.autoEmpty.aiid));
  }

  washMop(): Promise<void> {
    return this.command(() => this.client.action(ACTION.washMop.siid, ACTION.washMop.aiid));
  }

  startDrying(): Promise<void> {
    return this.command(() => this.client.action(ACTION.startDrying.siid, ACTION.startDrying.aiid));
  }

  stopDrying(): Promise<void> {
    return this.command(() => this.client.action(ACTION.stopDrying.siid, ACTION.stopDrying.aiid));
  }

  /**
   * Segment (room) cleaning, Dreame protocol:
   * action 4.1 with 4.1 = 18 (segment cleaning) and 4.10 = {"selects":[[id, repeats, suction, water, order]]}
   */
  cleanRooms(roomIds: number[], opts: CleanRoomsOptions = {}): Promise<void> {
    if (roomIds.length === 0) {
      return this.startCleaning();
    }
    const payload = XiaomiVacuum.buildRoomPayload(roomIds, {
      repeats: opts.repeats ?? 1,
      suction: opts.suction ?? this._status.suction ?? SuctionLevel.Standard,
      water: opts.water ?? this._status.waterLevel ?? WaterLevel.Medium,
    });
    return this.command(() =>
      this.client.action(ACTION.startCustom.siid, ACTION.startCustom.aiid, [
        { piid: PROP.status.piid, value: 18 },
        { piid: 10, value: payload },
      ]),
    );
  }

  static buildRoomPayload(roomIds: number[], o: Required<CleanRoomsOptions>): string {
    return JSON.stringify({
      selects: roomIds.map((id, index) => [id, Math.max(1, Math.min(3, o.repeats)), o.suction, o.water, index + 1]),
    });
  }

  async setSuction(level: SuctionLevel): Promise<void> {
    await this.client.setProperties([{ ...PROP.suction, value: level }]);
    this._status = { ...this._status, suction: level };
  }

  async setWaterLevel(level: WaterLevel): Promise<void> {
    await this.client.setProperties([{ ...PROP.waterLevel, value: level }]);
    this._status = { ...this._status, waterLevel: level };
  }

  async setCleaningType(type: CleaningType): Promise<void> {
    // 4.23 carries more than the cleaning type, always read-modify-write
    const [current] = await this.client.getProperties([PROP.cleaningMode]);
    if (!current || current.code !== 0 || typeof current.value !== 'number') {
      throw new Error('Unable to read the current cleaning mode');
    }
    const value = encodeCleaningType(current.value, type);
    if (value !== current.value) {
      await this.client.setProperties([{ ...PROP.cleaningMode, value }]);
    }
    this._status = { ...this._status, cleaningModeRaw: value, cleaningType: type };
  }

  async applyCleanSettings(s: { type?: CleaningType; suction?: SuctionLevel; water?: WaterLevel }): Promise<void> {
    if (s.type !== undefined && s.type !== this._status.cleaningType) {
      await this.setCleaningType(s.type);
    }
    if (s.suction !== undefined && s.suction !== this._status.suction) {
      await this.setSuction(s.suction);
    }
    if (s.water !== undefined && s.water !== this._status.waterLevel) {
      await this.setWaterLevel(s.water);
    }
    this.boost(15_000);
  }
}
