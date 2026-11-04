import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XiaomiVacuum } from '../src/device/vacuum.js';
import { ExtraSwitchesController } from '../src/matter/extraSwitches.js';
import { OpState, RUN_MODE_CLEANING, RUN_MODE_IDLE } from '../src/matter/mapping.js';
import { type MatterStateSink, VacuumMatterController } from '../src/matter/vacuumAccessory.js';
import { FakeVacuum, TOKEN } from './fakeDevice.js';

class InvalidInState extends Error {}
class Busy extends Error {}

class Sink implements MatterStateSink {
  updates: Array<{ uuid: string; cluster: string; attrs: Record<string, unknown> }> = [];
  status = { InvalidInState, Busy };
  async updateAccessoryState(uuid: string, cluster: string, attrs: Record<string, unknown>): Promise<void> {
    this.updates.push({ uuid, cluster, attrs });
  }
  lastOf(cluster: string) {
    return [...this.updates].reverse().find((u) => u.cluster === cluster)?.attrs;
  }
}

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, success: () => {}, log: () => {} };

let dev: FakeVacuum;
let vacuum: XiaomiVacuum;
let sink: Sink;
let ctrl: VacuumMatterController;

const rooms = [
  { id: 1, name: 'Obývačka', areaType: 'LivingRoom' },
  { id: 2, name: 'Kuchyňa', areaType: 'Kitchen' },
  { id: 3, name: 'Spálňa' },
];

beforeEach(async () => {
  dev = new FakeVacuum();
  const port = await dev.listen();
  vacuum = new XiaomiVacuum({ address: '127.0.0.1', port, token: TOKEN, timeout: 300 });
  await vacuum.refresh();
  sink = new Sink();
  ctrl = new VacuumMatterController(sink, log, vacuum, {
    name: 'Vysávač', serialNumber: '123456789', model: 'xiaomi.vacuum.c102gl', firmware: '4.5.6_1087',
    language: 'sk', rooms, idleAction: 'dock', roomRepeats: 2, directModeChange: true,
  }, 'uuid-1');
});
afterEach(() => {
  vacuum.stop();
  dev.close();
});

const actions = () => dev.calls.filter((c) => c.method === 'action').map((c) => `${c.params.siid}.${c.params.aiid}`);

describe('accessory definition', () => {
  it('builds a complete RVC accessory', () => {
    const a = ctrl.buildAccessory('RVC');
    expect(a.UUID).toBe('uuid-1');
    expect(a.manufacturer).toBe('Xiaomi');
    expect(a.features).toEqual({ rvcCleanMode: { directModeChange: true } });
    const c = a.clusters as any;
    expect(c.rvcRunMode.currentMode).toBe(RUN_MODE_IDLE);
    expect(c.rvcCleanMode.currentMode).toBe(20); // sweep+mop standard/medium as read from the real robot
    expect(c.rvcOperationalState.operationalState).toBe(OpState.Docked);
    expect(c.powerSource.batPercentRemaining).toBe(200);
    expect(c.serviceArea.supportedAreas).toHaveLength(3);
    expect(c.serviceArea.supportedAreas[0].areaInfo.locationInfo).toEqual({ locationName: 'Obývačka', floorNumber: null, areaType: 52 });
    expect(Object.keys(a.handlers as object).sort()).toEqual(['identify', 'rvcCleanMode', 'rvcOperationalState', 'rvcRunMode', 'serviceArea']);
  });

  it('omits ServiceArea without rooms', () => {
    const c2 = new VacuumMatterController(sink, log, vacuum, {
      name: 'x', serialNumber: '1', model: 'm', language: 'en', rooms: [], idleAction: 'dock', roomRepeats: 1, directModeChange: false,
    }, 'u2');
    const a = c2.buildAccessory('RVC');
    expect((a.clusters as any).serviceArea).toBeUndefined();
    expect((a.handlers as any).serviceArea).toBeUndefined();
    expect(a.features).toBeUndefined();
  });
});

describe('commands', () => {
  it('starts a full clean', async () => {
    await ctrl.onRegistered();
    await ctrl.onChangeRunMode(RUN_MODE_CLEANING);
    expect(actions()).toEqual(['2.1']);
    expect(sink.lastOf('rvcOperationalState')).toMatchObject({ operationalState: OpState.Running });
  });

  it('cleans selected rooms with the Dreame segment payload', async () => {
    await ctrl.onRegistered();
    await ctrl.onSelectAreas([2, 1, 2]);
    expect(ctrl.selection).toEqual([2, 1]);
    await ctrl.onChangeRunMode(RUN_MODE_CLEANING);
    const call = dev.calls.find((c) => c.method === 'action')!;
    expect(call.params.siid).toBe(4);
    expect(call.params.aiid).toBe(1);
    expect(call.params.in[0]).toEqual({ piid: 1, value: 18 });
    expect(JSON.parse(call.params.in[1].value)).toEqual({ selects: [[2, 2, 1, 2, 1], [1, 2, 1, 2, 2]] });
  });

  it('rejects unknown areas', async () => {
    await expect(ctrl.onSelectAreas([99])).rejects.toBeInstanceOf(InvalidInState);
  });

  it('stops and docks when switched to idle', async () => {
    await ctrl.onRegistered();
    await ctrl.onChangeRunMode(RUN_MODE_CLEANING);
    await vacuum.refresh();
    await ctrl.onChangeRunMode(RUN_MODE_IDLE);
    expect(actions()).toEqual(['2.1', '4.2', '3.1']);
    expect(sink.lastOf('rvcOperationalState')).toMatchObject({ operationalState: OpState.SeekingCharger });
  });

  it('idle while idle does nothing', async () => {
    await ctrl.onChangeRunMode(RUN_MODE_IDLE);
    expect(actions()).toEqual([]);
  });

  it('resumes when paused', async () => {
    dev.props.set('2.1', 3);
    dev.props.set('4.7', 6);
    await vacuum.refresh();
    await ctrl.onChangeRunMode(RUN_MODE_CLEANING);
    expect(actions()).toEqual(['2.1']);
  });

  it('pause / resume / goHome', async () => {
    await ctrl.onRegistered();
    await ctrl.onPause();
    await ctrl.onResume();
    await ctrl.onGoHome();
    expect(actions()).toEqual(['2.2', '2.1', '3.1']);
  });

  it('goHome during a task ends the task first', async () => {
    dev.props.set('2.1', 1);
    dev.props.set('4.7', 1);
    await vacuum.refresh();
    await ctrl.onGoHome();
    expect(actions()).toEqual(['4.2', '3.1']);
  });

  it('identify locates the robot', async () => {
    await ctrl.onIdentify(5);
    await ctrl.onIdentify(0);
    expect(actions()).toEqual(['7.1']);
  });

  it('changes the clean mode (type + suction + water)', async () => {
    await ctrl.onChangeCleanMode(4); // vacuum turbo
    expect(dev.props.get('4.23')).toBe(133122);
    expect(dev.props.get('2.3')).toBe(3);
    await ctrl.onChangeCleanMode(12); // mop high
    expect(dev.props.get('4.23')).toBe(133121);
    expect(dev.props.get('4.5')).toBe(3);
    await ctrl.onChangeCleanMode(30);
    expect(dev.props.get('4.23')).toBe(133123);
  });

  it('only allows suction/water changes while cleaning', async () => {
    dev.props.set('2.1', 12);
    dev.props.set('4.7', 1);
    await vacuum.refresh();
    await expect(ctrl.onChangeCleanMode(4)).rejects.toBeInstanceOf(InvalidInState);
    await ctrl.onChangeCleanMode(22); // same type (sweep+mop), turbo + high
    expect(dev.props.get('4.23')).toBe(133120);
    expect(dev.props.get('2.3')).toBe(3);
    expect(dev.props.get('4.5')).toBe(3);
  });

  it('rejects unknown modes and offline commands', async () => {
    await expect(ctrl.onChangeCleanMode(77)).rejects.toBeInstanceOf(InvalidInState);
    await expect(ctrl.onChangeRunMode(9)).rejects.toBeInstanceOf(InvalidInState);
    dev.silent = true;
    await vacuum.refresh().catch(() => undefined);
    await expect(ctrl.onChangeRunMode(RUN_MODE_CLEANING)).rejects.toBeInstanceOf(Busy);
  });
});

describe('state sync', () => {
  it('pushes only changes', async () => {
    await ctrl.onRegistered();
    const n = sink.updates.length;
    await ctrl.sync(vacuum.status);
    expect(sink.updates.length).toBe(n);
    dev.props.set('3.1', 60);
    dev.props.set('2.1', 6);
    await ctrl.sync(await vacuum.refresh());
    expect(sink.lastOf('powerSource')).toMatchObject({ batPercentRemaining: 120 });
    expect(sink.lastOf('rvcOperationalState')).toMatchObject({ operationalState: OpState.Charging });
  });

  it('reports cleaning, error and clears the room selection at the end', async () => {
    await ctrl.onRegistered();
    await ctrl.onSelectAreas([3]);
    await ctrl.onChangeRunMode(RUN_MODE_CLEANING);
    await ctrl.sync(await vacuum.refresh());
    expect(sink.lastOf('serviceArea')).toEqual({ selectedAreas: [3], currentArea: 3 });

    dev.props.set('2.1', 4);
    dev.props.set('2.2', 80);
    await ctrl.sync(await vacuum.refresh());
    expect(sink.lastOf('rvcOperationalState')).toMatchObject({
      operationalState: OpState.Error,
      operationalError: { errorStateId: 65, errorStateDetails: 'Robot stuck (Xiaomi fault 80)' },
    });

    dev.props.set('2.1', 13);
    dev.props.set('2.2', 0);
    dev.props.set('4.7', 0);
    await ctrl.sync(await vacuum.refresh());
    expect(sink.lastOf('serviceArea')).toEqual({ selectedAreas: [], currentArea: null });
    expect(ctrl.selection).toEqual([]);
    // every pushed error is complete and label free (see Matter conformance regression in v1.0.0)
    const errs = sink.updates.filter((u) => u.cluster === 'rvcOperationalState').map((u) => u.attrs.operationalError as Record<string, unknown>);
    expect(errs.length).toBeGreaterThan(2);
    for (const e of errs) {
      expect(e).not.toHaveProperty('errorStateLabel');
      expect(typeof e.errorStateDetails).toBe('string');
    }
    expect(sink.lastOf('rvcOperationalState')).toMatchObject({ operationalError: { errorStateId: 0, errorStateDetails: '' } });
  });

  it('marks the power source unavailable when offline', async () => {
    await ctrl.onRegistered();
    dev.silent = true;
    const s = await vacuum.refresh().catch(() => vacuum.status);
    await ctrl.sync(s);
    expect(sink.lastOf('powerSource')).toEqual({ status: 3 });
  });

  it('pushes supportedAreas on registration (cached accessories)', async () => {
    await ctrl.onRegistered();
    expect(sink.updates[0]).toMatchObject({ cluster: 'serviceArea' });
    expect((sink.updates[0].attrs.supportedAreas as unknown[]).length).toBe(3);
  });
});

describe('extra switches', () => {
  it('runs dock functions and mirrors state', async () => {
    const sw = new ExtraSwitchesController(sink, log, vacuum, {
      name: 'Vysávač', serialNumber: '1', model: 'm', language: 'sk', kinds: ['autoEmpty', 'washMop', 'dryMop', 'locate'],
    }, (k) => k);
    const accs = sw.buildAccessories('Outlet');
    expect(accs.map((a) => a.displayName)).toEqual(['Vysávač Vyprázdniť kôš', 'Vysávač Umyť mop', 'Vysávač Sušiť mop', 'Vysávač Nájsť vysávač']);
    await sw.onRegistered();
    await (accs[0].handlers as any).onOff.on();
    await (accs[1].handlers as any).onOff.on();
    await (accs[2].handlers as any).onOff.on();
    await (accs[2].handlers as any).onOff.off();
    await (accs[3].handlers as any).onOff.on();
    expect(actions()).toEqual(['2.4', '2.6', '2.8', '2.9', '7.1']);
  });
});

/** Sink that behaves like Homebridge: updates are fire-and-forget and may silently not land. */
class LiveSink extends Sink {
  live = new Map<string, Record<string, unknown>>();
  dropNext = new Set<string>();
  override async updateAccessoryState(uuid: string, cluster: string, attrs: Record<string, unknown>): Promise<void> {
    await super.updateAccessoryState(uuid, cluster, attrs);
    if (this.dropNext.delete(cluster)) {
      return; // resolved, but never applied (e.g. rejected by matter.js validation)
    }
    this.live.set(cluster, { ...(this.live.get(cluster) ?? {}), ...attrs });
  }
  async getAccessoryState(_uuid: string, cluster: string) {
    return this.live.get(cluster);
  }
}

describe('self-healing sync (regression: Apple Home stuck on a stale state)', () => {
  it('re-sends an update that resolved but did not land', async () => {
    const live = new LiveSink();
    const c = new VacuumMatterController(live, log, vacuum, {
      name: 'x', serialNumber: '1', model: 'm', language: 'en', rooms: [], idleAction: 'dock', roomRepeats: 1, directModeChange: true,
    }, 'u');
    await c.onRegistered();
    expect(live.live.get('rvcRunMode')).toEqual({ currentMode: RUN_MODE_IDLE });

    // robot starts vacuuming from the Xiaomi app, the first update gets lost
    dev.props.set('2.1', 1);
    dev.props.set('4.7', 1);
    dev.props.set('4.23', 133122);
    live.dropNext.add('rvcRunMode');
    live.dropNext.add('rvcOperationalState');
    const s = await vacuum.refresh();
    await c.sync(s);
    expect(live.live.get('rvcRunMode')).toEqual({ currentMode: RUN_MODE_IDLE });

    // next poll with an unchanged robot status repairs it
    await c.sync(await vacuum.refresh());
    expect(live.live.get('rvcRunMode')).toEqual({ currentMode: RUN_MODE_CLEANING });
    expect(live.live.get('rvcOperationalState')).toMatchObject({ operationalState: OpState.Running });
    expect(live.live.get('rvcCleanMode')).toEqual({ currentMode: 2 });

    // and once everything matches nothing more is sent
    const n = live.updates.length;
    await c.sync(await vacuum.refresh());
    expect(live.updates.length).toBe(n);
  });

  it('repairs state changed behind its back (e.g. restored from cache)', async () => {
    const live = new LiveSink();
    const c = new VacuumMatterController(live, log, vacuum, {
      name: 'x', serialNumber: '1', model: 'm', language: 'en', rooms: [], idleAction: 'dock', roomRepeats: 1, directModeChange: true,
    }, 'u');
    await c.onRegistered();
    live.live.set('rvcOperationalState', { operationalState: OpState.Running, operationalError: { errorStateId: 0 } });
    await c.sync(vacuum.status);
    expect(live.live.get('rvcOperationalState')).toMatchObject({ operationalState: OpState.Docked });
  });

  it('emits poll after every refresh, update only on change', async () => {
    let polls = 0;
    let updates = 0;
    vacuum.on('poll', () => polls++);
    vacuum.on('update', () => updates++);
    await vacuum.refresh();
    await vacuum.refresh();
    expect(polls).toBe(2);
    expect(updates).toBe(0);
    dev.props.set('3.1', 50);
    await vacuum.refresh();
    expect(polls).toBe(3);
    expect(updates).toBe(1);
  });
});

describe('matchesSubset', () => {
  it('compares recursively and ignores extra live fields', async () => {
    const { matchesSubset } = await import('../src/matter/vacuumAccessory.js');
    expect(matchesSubset({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(matchesSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(matchesSubset({ e: { errorStateId: 0, errorStateDetails: '', x: 1 } }, { e: { errorStateId: 0, errorStateDetails: '' } })).toBe(true);
    expect(matchesSubset({ l: [1, 2] }, { l: [1, 2] })).toBe(true);
    expect(matchesSubset({ l: [1] }, { l: [1, 2] })).toBe(false);
    expect(matchesSubset({ c: undefined }, { c: null })).toBe(true);
    expect(matchesSubset(undefined, { a: 1 })).toBe(false);
  });
});
