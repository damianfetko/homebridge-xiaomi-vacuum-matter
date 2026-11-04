import type { API, DynamicPlatformPlugin, Logger, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';
import { SUPPORTED_MODELS } from './device/spec.js';
import { XiaomiVacuum } from './device/vacuum.js';
import { EXTRA_SWITCH_KINDS, type ExtraSwitchKind, ExtraSwitchesController } from './matter/extraSwitches.js';
import { type Language, validateRooms } from './matter/mapping.js';
import { type MatterStateSink, VacuumMatterController } from './matter/vacuumAccessory.js';

export const PLUGIN_NAME = 'homebridge-xiaomi-vacuum-matter';
export const PLATFORM_NAME = 'XiaomiVacuumMatter';

export interface DeviceConfig {
  name?: string;
  ip: string;
  token: string;
  deviceId?: string | number;
  model?: string;
  language?: Language;
  rooms?: Array<{ id: number; name: string; areaType?: string; floor?: number }>;
  idleAction?: 'dock' | 'stop' | 'pause';
  roomRepeats?: number;
  directModeChange?: boolean;
  pollInterval?: number;
  activePollInterval?: number;
  extraSwitches?: Partial<Record<ExtraSwitchKind, boolean>>;
  debug?: boolean;
}

interface RunningDevice {
  vacuum: XiaomiVacuum;
  controller: VacuumMatterController;
  switches?: ExtraSwitchesController;
}

export class XiaomiVacuumMatterPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, MatterAccessory>();
  private readonly devices: RunningDevice[] = [];

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    if (!api.isMatterEnabled?.() || !api.matter) {
      log.error(
        'Matter is not enabled for this bridge. Enable Matter for the child bridge of this plugin '
          + '(Plugins → Xiaomi Vacuum Matter → Child Bridge settings → Enable Matter) and restart. Homebridge 2.5.0+ is required.',
      );
      return;
    }
    api.on('didFinishLaunching', () => {
      this.startAll().catch((err) => log.error(`Startup failed: ${(err as Error).stack ?? err}`));
    });
    api.on('shutdown', () => {
      for (const d of this.devices) {
        d.vacuum.stop();
      }
    });
  }

  configureAccessory(_accessory: PlatformAccessory): void {
    // HAP accessories are not used by this plugin.
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async startAll(): Promise<void> {
    const list: DeviceConfig[] = Array.isArray(this.config.devices) ? this.config.devices : [];
    if (list.length === 0) {
      this.log.warn('No devices configured.');
    }
    const keep = new Set<string>();
    for (const dc of list) {
      try {
        const running = await this.startDevice(dc);
        if (running) {
          keep.add(running.controller.uuid);
          running.switches?.uuids.forEach((u) => keep.add(u));
        }
      } catch (err) {
        this.log.error(`[${dc.name ?? dc.ip}] ${(err as Error).message}`);
        // keep the cached accessories of a failing device, so its pairing survives
        for (const [uuid, acc] of this.cached) {
          if ((acc.context as any)?.ip === dc.ip) {
            keep.add(uuid);
          }
        }
      }
    }
    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessories`);
      await this.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private async startDevice(dc: DeviceConfig): Promise<RunningDevice | undefined> {
    const label = dc.name ?? dc.ip;
    if (!dc.ip || !dc.token) {
      throw new Error('"ip" and "token" are required');
    }
    const log = this.prefixed(label, dc.debug === true);
    const { rooms, errors } = validateRooms(dc.rooms);
    errors.forEach((e) => log.warn(e));

    const vacuum = new XiaomiVacuum({
      address: dc.ip,
      token: dc.token,
      deviceId: dc.deviceId !== undefined ? Number(dc.deviceId) : undefined,
      pollInterval: clamp(dc.pollInterval, 3, 300, 15) * 1000,
      activePollInterval: clamp(dc.activePollInterval, 2, 60, 4) * 1000,
      logger: { debug: (m) => log.debug(m) },
    });

    // Identify the device (model / firmware / serial). Fall back to the cache when offline.
    const cachedVacuum = [...this.cached.values()].find((a) => (a.context as any)?.kind === 'vacuum' && (a.context as any)?.ip === dc.ip);
    let model = dc.model ?? (cachedVacuum?.model as string | undefined) ?? 'xiaomi.vacuum.c102gl';
    let firmware = cachedVacuum?.firmwareRevision;
    let serial = (cachedVacuum?.context as any)?.serialNumber as string | undefined;
    try {
      const info = await vacuum.client.info();
      model = info.model ?? model;
      firmware = info.fw_ver ?? firmware;
      serial = serial ?? String(vacuum.client.connectedDeviceId ?? dc.deviceId ?? info.mac);
      log.info(`Connected: ${model}, firmware ${firmware}, device id ${vacuum.client.connectedDeviceId}`);
      if (!SUPPORTED_MODELS.includes(model)) {
        log.warn(`Model ${model} is not tested with this plugin – it may still work if it is a Dreame based robot.`);
      }
      await vacuum.refresh();
    } catch (err) {
      log.warn(`Vacuum not reachable right now (${(err as Error).message}). Will keep retrying.`);
    }
    serial = serial ?? String(dc.deviceId ?? dc.ip);

    const language: Language = dc.language === 'sk' ? 'sk' : 'en';
    const name = dc.name ?? 'Robot Vacuum';
    const controller = VacuumMatterController.fromApi(this.api, log, vacuum, {
      name,
      serialNumber: serial,
      model,
      firmware,
      language,
      rooms,
      idleAction: dc.idleAction ?? 'dock',
      roomRepeats: clamp(dc.roomRepeats, 1, 3, 1),
      directModeChange: dc.directModeChange !== false,
    });
    const accessory = controller.buildAccessory(this.api.matter!.deviceTypes.RoboticVacuumCleaner);
    Object.assign(accessory.context as object, { ip: dc.ip });

    const kinds = EXTRA_SWITCH_KINDS.filter((k) => dc.extraSwitches?.[k] === true);
    const switches = kinds.length > 0
      ? new ExtraSwitchesController(this.api.matter as unknown as MatterStateSink, log, vacuum, { name, serialNumber: serial, model, language, kinds }, (k) => this.api.matter!.uuid.generate(k))
      : undefined;

    // Sync after every poll, not only on changes: the controller verifies the live
    // Matter state and re-sends anything that did not land.
    let syncing = false;
    vacuum.on('poll', (s) => {
      if (syncing) {
        return;
      }
      syncing = true;
      Promise.all([controller.sync(s), switches?.sync(s)])
        .catch((err) => log.debug(`Sync failed: ${(err as Error).message}`))
        .finally(() => {
          syncing = false;
        });
    });
    vacuum.client.on('offline', () => log.debug('Vacuum offline'));
    vacuum.on('error', (err: Error) => log.debug(`Poll failed: ${err.message}`));
    let wasOnline = vacuum.status.online;
    vacuum.on('update', (s) => {
      if (s.online !== wasOnline) {
        wasOnline = s.online;
        if (s.online) {
          log.info('Vacuum is reachable again');
        } else {
          log.warn('Vacuum is not reachable');
        }
      }
    });

    await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    await controller.onRegistered();
    log.info(`Registered Matter robot vacuum "${name}"${rooms.length ? ` with ${rooms.length} rooms` : ''}. `
      + 'It has its own Matter pairing code – see the Homebridge UI / log.');

    if (switches) {
      try {
        const accs = switches.buildAccessories(this.api.matter!.deviceTypes.OnOffOutlet);
        accs.forEach((a) => Object.assign(a.context as object, { ip: dc.ip }));
        await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accs);
        await switches.onRegistered();
        log.info(`Registered ${accs.length} extra switches on the Matter bridge`);
      } catch (err) {
        log.warn(`Extra switches could not be registered (is the Matter bridge enabled, not "externals only"?): ${(err as Error).message}`);
      }
    }

    vacuum.start();
    const running = { vacuum, controller, switches };
    this.devices.push(running);
    return running;
  }

  private prefixed(label: string, debug: boolean): Logger {
    const log = this.log;
    const p = (m: string) => `[${label}] ${m}`;
    return {
      ...log,
      info: (m: string, ...a: unknown[]) => log.info(p(m), ...a),
      warn: (m: string, ...a: unknown[]) => log.warn(p(m), ...a),
      error: (m: string, ...a: unknown[]) => log.error(p(m), ...a),
      success: (m: string, ...a: unknown[]) => log.success(p(m), ...a),
      debug: (m: string, ...a: unknown[]) => (debug ? log.info(p(`[debug] ${m}`), ...a) : log.debug(p(m), ...a)),
      log: log.log.bind(log),
    } as Logger;
  }
}

function clamp(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return def;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}
