import type { Logger, MatterAccessory } from 'homebridge';
import { VacuumState } from '../device/spec.js';
import type { VacuumStatus, XiaomiVacuum } from '../device/vacuum.js';
import type { Language } from './mapping.js';
import type { MatterStateSink } from './vacuumAccessory.js';

export type ExtraSwitchKind = 'autoEmpty' | 'washMop' | 'dryMop' | 'locate';

export const EXTRA_SWITCH_KINDS: ExtraSwitchKind[] = ['autoEmpty', 'washMop', 'dryMop', 'locate'];

const LABELS: Record<ExtraSwitchKind, Record<Language, string>> = {
  autoEmpty: { en: 'Empty Dust Bin', sk: 'Vyprázdniť kôš' },
  washMop: { en: 'Wash Mop', sk: 'Umyť mop' },
  dryMop: { en: 'Dry Mop', sk: 'Sušiť mop' },
  locate: { en: 'Find Vacuum', sk: 'Nájsť vysávač' },
};

interface SwitchEntry {
  kind: ExtraSwitchKind;
  uuid: string;
  lastOn?: boolean;
  /** Ignore status driven updates until this time (after a command). */
  lockUntil: number;
}

/** Whether the switch should appear "on" for a given robot status. */
export function switchStateFromStatus(kind: ExtraSwitchKind, s: VacuumStatus): boolean {
  switch (kind) {
    case 'autoEmpty':
      return s.state === VacuumState.DustCollecting;
    case 'washMop':
      return s.state === VacuumState.Washing;
    case 'dryMop':
      return s.state === VacuumState.Drying;
    default:
      return false;
  }
}

/**
 * Optional bridged Matter switches for robot functions Matter RVC does not
 * model (auto-empty, mop wash, mop drying, locate). They live on the regular
 * Matter bridge of the (child) bridge, not on the vacuum's own pairing.
 */
export class ExtraSwitchesController {
  private readonly entries: SwitchEntry[];
  private registered = false;

  constructor(
    private readonly matter: MatterStateSink,
    private readonly log: Logger,
    private readonly vacuum: XiaomiVacuum,
    private readonly opts: { name: string; serialNumber: string; model: string; language: Language; kinds: ExtraSwitchKind[] },
    uuidFor: (key: string) => string,
  ) {
    this.entries = opts.kinds.map((kind) => ({ kind, uuid: uuidFor(`xiaomi-vacuum-matter:${opts.serialNumber}:${kind}`), lockUntil: 0 }));
  }

  get uuids(): string[] {
    return this.entries.map((e) => e.uuid);
  }

  buildAccessories(deviceType: unknown): MatterAccessory[] {
    return this.entries.map((e) => ({
      UUID: e.uuid,
      displayName: `${this.opts.name} ${LABELS[e.kind][this.opts.language]}`,
      deviceType: deviceType as MatterAccessory['deviceType'],
      serialNumber: `${this.opts.serialNumber}-${e.kind}`,
      manufacturer: 'Xiaomi',
      model: this.opts.model,
      context: { kind: 'switch', switch: e.kind, serialNumber: this.opts.serialNumber },
      clusters: { onOff: { onOff: false } },
      handlers: {
        onOff: {
          on: () => this.onCommand(e, true),
          off: () => this.onCommand(e, false),
        },
      },
    }));
  }

  async onRegistered(): Promise<void> {
    this.registered = true;
    await this.sync(this.vacuum.status);
  }

  async onCommand(e: SwitchEntry, on: boolean): Promise<void> {
    if (!this.vacuum.status.online) {
      throw new this.matter.status.Busy('Vacuum is offline');
    }
    e.lockUntil = Date.now() + 15_000;
    e.lastOn = on;
    switch (e.kind) {
      case 'autoEmpty':
        if (on) {
          this.log.info('Emptying dust bin');
          await this.vacuum.autoEmpty();
        }
        break;
      case 'washMop':
        if (on) {
          this.log.info('Washing mop');
          await this.vacuum.washMop();
        }
        break;
      case 'dryMop':
        this.log.info(on ? 'Starting mop drying' : 'Stopping mop drying');
        await (on ? this.vacuum.startDrying() : this.vacuum.stopDrying());
        break;
      case 'locate':
        if (on) {
          this.log.info('Locating vacuum');
          await this.vacuum.locate();
          // momentary
          setTimeout(() => {
            e.lockUntil = 0;
            void this.set(e, false, true);
          }, 1500);
        }
        break;
    }
  }

  private async set(e: SwitchEntry, on: boolean, force = false): Promise<void> {
    if (!this.registered || (!force && e.lastOn === on)) {
      return;
    }
    try {
      await this.matter.updateAccessoryState(e.uuid, 'onOff', { onOff: on });
      e.lastOn = on;
    } catch (err) {
      this.log.debug(`Failed to update switch ${e.kind}: ${(err as Error).message}`);
    }
  }

  async sync(s: VacuumStatus): Promise<void> {
    if (!s.online) {
      return;
    }
    const now = Date.now();
    for (const e of this.entries) {
      if (now < e.lockUntil) {
        continue;
      }
      await this.set(e, switchStateFromStatus(e.kind, s));
    }
  }
}
