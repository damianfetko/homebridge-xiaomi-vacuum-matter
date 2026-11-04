import type { API, Logger, MatterAccessory } from 'homebridge';
import { CleaningType, VacuumState } from '../device/spec.js';
import type { VacuumStatus, XiaomiVacuum } from '../device/vacuum.js';
import {
  cleanModeFromStatus,
  cleanModes,
  findCleanMode,
  type Language,
  OPERATIONAL_STATE_LIST,
  OpState,
  operationalErrorFromStatus,
  operationalStateFromStatus,
  PowerSourceStatus,
  powerSourceFromStatus,
  type RoomConfig,
  RUN_MODE_CLEANING,
  RUN_MODE_IDLE,
  runModeFromStatus,
  runModes,
  supportedAreas,
} from './mapping.js';

export interface VacuumAccessoryConfig {
  name: string;
  serialNumber: string;
  model: string;
  firmware?: string;
  language: Language;
  rooms: RoomConfig[];
  /** What switching the run mode to Idle does while a task is running. */
  idleAction: 'dock' | 'stop' | 'pause';
  /** How many passes per room for room cleaning (1-3). */
  roomRepeats: number;
  /** Allow changing suction / water while cleaning. */
  directModeChange: boolean;
}

type Cluster = 'rvcRunMode' | 'rvcCleanMode' | 'rvcOperationalState' | 'powerSource' | 'serviceArea';

/** Thin interface over api.matter so the controller can be tested without Homebridge. */
export interface MatterStateSink {
  updateAccessoryState(uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void>;
  status: { InvalidInState: new (message?: string) => Error; Busy: new (message?: string) => Error };
}

export class VacuumMatterController {
  readonly uuid: string;
  private last: Partial<Record<Cluster, string>> = {};
  private selectedAreas: number[] = [];
  private cleanModeLockUntil = 0;
  private runModeLockUntil = 0;
  private registered = false;
  private lastTaskActive = false;

  constructor(
    private readonly matter: MatterStateSink,
    private readonly log: Logger,
    private readonly vacuum: XiaomiVacuum,
    private readonly config: VacuumAccessoryConfig,
    uuid: string,
  ) {
    this.uuid = uuid;
  }

  static fromApi(api: API, log: Logger, vacuum: XiaomiVacuum, config: VacuumAccessoryConfig): VacuumMatterController {
    const matter = api.matter!;
    const uuid = matter.uuid.generate(`xiaomi-vacuum-matter:${config.serialNumber}`);
    return new VacuumMatterController(matter as unknown as MatterStateSink, log, vacuum, config, uuid);
  }

  buildAccessory(deviceType: unknown): MatterAccessory {
    const s = this.vacuum.status;
    const lang = this.config.language;
    const clusters: Record<string, Record<string, unknown>> = {
      rvcRunMode: {
        supportedModes: runModes(lang),
        currentMode: runModeFromStatus(s, this.vacuum.isTaskActive(s)),
      },
      rvcCleanMode: {
        supportedModes: cleanModes(lang),
        currentMode: cleanModeFromStatus(s) ?? 20,
      },
      rvcOperationalState: {
        operationalStateList: OPERATIONAL_STATE_LIST,
        operationalState: s.online ? operationalStateFromStatus(s) : OpState.Stopped,
        operationalError: s.online ? operationalErrorFromStatus(s) : { errorStateId: 0 },
        phaseList: null,
        currentPhase: null,
      },
      powerSource: {
        status: PowerSourceStatus.Active,
        order: 0,
        description: 'Battery',
        batReplaceability: 1,
        batFunctionalWhileCharging: true,
        ...powerSourceFromStatus(s),
      },
    };
    if (this.config.rooms.length > 0) {
      clusters.serviceArea = {
        supportedAreas: supportedAreas(this.config.rooms),
        selectedAreas: [],
        currentArea: null,
        estimatedEndTime: null,
      };
    }

    const handlers: Record<string, Record<string, (args: any) => Promise<void>>> = {
      rvcRunMode: { changeToMode: (args) => this.onChangeRunMode(args?.newMode) },
      rvcCleanMode: { changeToMode: (args) => this.onChangeCleanMode(args?.newMode) },
      rvcOperationalState: {
        pause: () => this.onPause(),
        resume: () => this.onResume(),
        goHome: () => this.onGoHome(),
      },
      identify: { identify: (args) => this.onIdentify(args?.identifyTime) },
    };
    if (this.config.rooms.length > 0) {
      handlers.serviceArea = { selectAreas: (args) => this.onSelectAreas(args?.newAreas ?? []) };
    }

    return {
      UUID: this.uuid,
      displayName: this.config.name,
      deviceType: deviceType as MatterAccessory['deviceType'],
      serialNumber: this.config.serialNumber,
      manufacturer: 'Xiaomi',
      model: this.config.model,
      firmwareRevision: this.config.firmware,
      softwareVersion: this.config.firmware,
      features: this.config.directModeChange ? { rvcCleanMode: { directModeChange: true } } : undefined,
      context: { kind: 'vacuum', serialNumber: this.config.serialNumber },
      clusters: clusters as MatterAccessory['clusters'],
      handlers: handlers as MatterAccessory['handlers'],
    };
  }

  /** Called once the accessory is registered – from now on state can be pushed. */
  async onRegistered(): Promise<void> {
    this.registered = true;
    this.last = {};
    // A restored accessory keeps its cached state, so push the static lists too
    // (rooms may have been edited in the config).
    if (this.config.rooms.length > 0) {
      await this.push('serviceArea', { supportedAreas: supportedAreas(this.config.rooms) }, true);
    }
    await this.sync(this.vacuum.status);
  }

  // ------------------------------------------------------------ state sync

  private async push(cluster: Cluster, attrs: Record<string, unknown>, force = false): Promise<void> {
    if (!this.registered) {
      return;
    }
    const key = JSON.stringify(attrs);
    if (!force && this.last[cluster] === key) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(this.uuid, cluster, attrs);
      this.last[cluster] = key;
    } catch (err) {
      this.log.warn(`Failed to update ${cluster}: ${(err as Error).message}`);
    }
  }

  async sync(s: VacuumStatus): Promise<void> {
    if (!s.online) {
      // Keep last known values; mark the battery source as unavailable so controllers can see something is off.
      await this.push('powerSource', { status: PowerSourceStatus.Unavailable });
      return;
    }
    const taskActive = this.vacuum.isTaskActive(s);
    const now = Date.now();

    await this.push('powerSource', { status: PowerSourceStatus.Active, ...powerSourceFromStatus(s) });
    await this.push('rvcOperationalState', {
      operationalState: operationalStateFromStatus(s),
      operationalError: operationalErrorFromStatus(s),
    });
    if (now >= this.runModeLockUntil) {
      await this.push('rvcRunMode', { currentMode: runModeFromStatus(s, taskActive) });
    }
    const cleanMode = cleanModeFromStatus(s);
    if (cleanMode !== undefined && now >= this.cleanModeLockUntil) {
      await this.push('rvcCleanMode', { currentMode: cleanMode });
    }

    if (this.config.rooms.length > 0) {
      const currentArea = taskActive && this.selectedAreas.length === 1 ? this.selectedAreas[0] : null;
      if (this.lastTaskActive && !taskActive) {
        // Task finished – forget the room selection so the next plain "start" cleans everything.
        this.selectedAreas = [];
        await this.push('serviceArea', { selectedAreas: [], currentArea: null });
      } else {
        await this.push('serviceArea', { selectedAreas: this.selectedAreas, currentArea });
      }
    }
    this.lastTaskActive = taskActive;
  }

  private async setOpState(state: number): Promise<void> {
    await this.push('rvcOperationalState', { operationalState: state, operationalError: { errorStateId: 0 } });
  }

  // -------------------------------------------------------------- handlers

  private ensureOnline(): void {
    if (!this.vacuum.status.online) {
      throw new this.matter.status.Busy('Vacuum is offline');
    }
  }

  async onChangeRunMode(newMode: number | undefined): Promise<void> {
    this.ensureOnline();
    const s = this.vacuum.status;
    const active = this.vacuum.isTaskActive(s);
    if (newMode === RUN_MODE_CLEANING) {
      if (this.vacuum.isPaused(s)) {
        this.log.info('Resuming cleaning');
        await this.vacuum.resume();
      } else if (active && s.state !== VacuumState.GoCharging) {
        this.log.info('Already cleaning');
      } else if (this.selectedAreas.length > 0) {
        const names = this.selectedAreas.map((id) => this.config.rooms.find((r) => r.id === id)?.name ?? `#${id}`);
        this.log.info(`Starting room cleaning: ${names.join(', ')}`);
        await this.vacuum.cleanRooms(this.selectedAreas, { repeats: this.config.roomRepeats });
      } else {
        this.log.info('Starting full cleaning');
        await this.vacuum.startCleaning();
      }
      this.runModeLockUntil = Date.now() + 10_000;
      await this.setOpState(OpState.Running);
      return;
    }
    if (newMode === RUN_MODE_IDLE) {
      this.runModeLockUntil = Date.now() + 10_000;
      if (!active) {
        return;
      }
      await this.endTask(this.config.idleAction);
      return;
    }
    throw new this.matter.status.InvalidInState(`Unsupported run mode ${newMode}`);
  }

  private async endTask(action: 'dock' | 'stop' | 'pause'): Promise<void> {
    if (action === 'pause') {
      this.log.info('Pausing cleaning');
      await this.vacuum.pause();
      await this.setOpState(OpState.Paused);
      return;
    }
    this.log.info(action === 'dock' ? 'Stopping cleaning and returning to dock' : 'Stopping cleaning');
    await this.vacuum.stopCleaning();
    if (action === 'dock') {
      await delay(800);
      await this.vacuum.dock();
      await this.setOpState(OpState.SeekingCharger);
    } else {
      await this.setOpState(OpState.Stopped);
    }
  }

  async onChangeCleanMode(newMode: number | undefined): Promise<void> {
    const def = newMode === undefined ? undefined : findCleanMode(newMode);
    if (!def) {
      throw new this.matter.status.InvalidInState(`Unknown clean mode ${newMode}`);
    }
    this.ensureOnline();
    const s = this.vacuum.status;
    const active = this.vacuum.isTaskActive(s);
    if (active && s.cleaningType !== undefined && def.type !== s.cleaningType) {
      throw new this.matter.status.InvalidInState('The cleaning type can only be changed while the vacuum is idle');
    }
    this.log.info(`Setting clean mode: ${def.labels.en}`);
    await this.vacuum.applyCleanSettings({
      type: active ? undefined : def.type,
      suction: def.type === CleaningType.Mopping ? undefined : def.suction,
      water: def.type === CleaningType.Sweeping ? undefined : def.water,
    });
    this.cleanModeLockUntil = Date.now() + 20_000;
    this.last.rvcCleanMode = JSON.stringify({ currentMode: def.mode });
  }

  async onPause(): Promise<void> {
    this.ensureOnline();
    this.log.info('Pausing');
    await this.vacuum.pause();
    await this.setOpState(OpState.Paused);
  }

  async onResume(): Promise<void> {
    this.ensureOnline();
    this.log.info('Resuming');
    await this.vacuum.resume();
    await this.setOpState(OpState.Running);
  }

  async onGoHome(): Promise<void> {
    this.ensureOnline();
    const s = this.vacuum.status;
    if (this.vacuum.isTaskActive(s)) {
      await this.endTask('dock');
    } else {
      this.log.info('Returning to dock');
      await this.vacuum.dock();
      await this.setOpState(OpState.SeekingCharger);
    }
    this.runModeLockUntil = Date.now() + 10_000;
    await this.push('rvcRunMode', { currentMode: RUN_MODE_IDLE });
  }

  async onSelectAreas(areas: number[]): Promise<void> {
    const known = new Set(this.config.rooms.map((r) => r.id));
    const unique = [...new Set(areas)];
    const unknown = unique.filter((a) => !known.has(a));
    if (unknown.length > 0) {
      throw new this.matter.status.InvalidInState(`Unknown area(s): ${unknown.join(', ')}`);
    }
    if (this.vacuum.isTaskActive() && !this.vacuum.isPaused()) {
      throw new this.matter.status.InvalidInState('Areas cannot be changed while cleaning');
    }
    this.selectedAreas = unique;
    this.log.info(
      unique.length === 0
        ? 'Area selection cleared (whole home)'
        : `Selected areas: ${unique.map((id) => this.config.rooms.find((r) => r.id === id)?.name).join(', ')}`,
    );
    this.last.serviceArea = JSON.stringify({ selectedAreas: unique, currentArea: null });
  }

  async onIdentify(identifyTime: number | undefined): Promise<void> {
    if (identifyTime === 0) {
      return;
    }
    this.ensureOnline();
    this.log.info('Locating vacuum');
    await this.vacuum.locate();
  }

  /** For tests / diagnostics. */
  get selection(): number[] {
    return [...this.selectedAreas];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
