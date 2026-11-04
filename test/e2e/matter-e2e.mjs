#!/usr/bin/env node
/**
 * End-to-end test: acts as a Matter controller (like Apple Home), commissions
 * the robot vacuum published by Homebridge and exercises every cluster.
 *
 *   node test/e2e/matter-e2e.mjs --port 5530 --passcode 843472 --discriminator 3403 [--move] [--room 2]
 *
 * Without --move only non-moving commands are sent (clean mode, area selection, identify).
 * With --move the robot is started, paused, resumed and sent home (and, with --room, a room clean).
 */
import { Environment, StorageService } from '@matter/main';
import { GeneralCommissioning, PowerSource, RvcCleanMode, RvcOperationalState, RvcRunMode, ServiceArea, Identify, BasicInformation } from '@matter/main/clusters';
import { CommissioningController } from '@project-chip/matter.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const port = Number(arg('port'));
const passcode = Number(arg('passcode'));
const discriminator = Number(arg('discriminator'));
const ip = arg('ip', '127.0.0.1');
const move = has('move');
const room = arg('room') ? Number(arg('room')) : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

const env = Environment.default;
env.vars.set('storage.path', arg('storage', mkdtempSync(path.join(tmpdir(), 'xvm-e2e-'))));
env.vars.set('log.level', 'warn');
env.get(StorageService);

const controller = new CommissioningController({
  environment: { environment: env, id: 'xvm-e2e' },
  autoConnect: false,
  adminFabricLabel: 'xvm-e2e',
});
await controller.start();

let nodeId;
try {
  console.log(`Commissioning ${ip}:${port} …`);
  nodeId = await controller.commissionNode({
    commissioning: {
      regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
      regulatoryCountryCode: 'SK',
    },
    discovery: { knownAddress: { ip, port, type: 'udp' }, identifierData: { longDiscriminator: discriminator }, discoveryCapabilities: { onIpNetwork: true } },
    passcode,
  });
  check('commissioning', !!nodeId, String(nodeId));

  const node = await controller.getNode(nodeId);
  node.connect();
  if (!node.initialized) {
    await node.events.initialized;
  }
  const devices = node.getDevices();
  const rvc = devices.find((d) => d.getClusterClient(RvcRunMode.Cluster));
  check('robot vacuum endpoint present', !!rvc, devices.map((d) => d.name).join(','));
  check('device type 116 (RoboticVacuumCleaner)', rvc?.deviceType === 116, String(rvc?.deviceType));

  const basic = node.getRootClusterClient?.(BasicInformation.Cluster);
  if (basic) {
    console.log('  vendor/product:', await basic.getVendorNameAttribute(), '/', await basic.getProductNameAttribute());
  }

  const run = rvc.getClusterClient(RvcRunMode.Cluster);
  const clean = rvc.getClusterClient(RvcCleanMode.Cluster);
  const op = rvc.getClusterClient(RvcOperationalState.Cluster);
  const area = rvc.getClusterClient(ServiceArea.Cluster);
  const power = rvc.getClusterClient(PowerSource.Cluster);
  const ident = rvc.getClusterClient(Identify.Cluster);

  const runModes = await run.getSupportedModesAttribute();
  console.log('  run modes:', runModes.map((m) => `${m.mode}:${m.label}`).join(', '));
  check('run modes Idle+Cleaning', runModes.length === 2);
  console.log('  current run mode:', await run.getCurrentModeAttribute(true));

  const cleanModes = await clean.getSupportedModesAttribute();
  console.log('  clean modes:', cleanModes.map((m) => `${m.mode}:${m.label}`).join(', '));
  check('11 clean modes', cleanModes.length === 11);
  const initialClean = await clean.getCurrentModeAttribute();
  console.log('  current clean mode:', initialClean);

  const opState = await op.getOperationalStateAttribute();
  const opList = await op.getOperationalStateListAttribute();
  console.log('  operational state:', opState, 'error:', JSON.stringify(await op.getOperationalErrorAttribute()));
  check('operational state list', opList.length === 11);

  const pct = await power.getBatPercentRemainingAttribute();
  console.log('  battery:', pct / 2, '% charge state', await power.getBatChargeStateAttribute());
  check('battery reported', typeof pct === 'number' && pct >= 0 && pct <= 200);

  if (area) {
    const areas = await area.getSupportedAreasAttribute();
    console.log('  areas:', areas.map((a) => `${a.areaId}:${a.areaInfo.locationInfo?.locationName}`).join(', '));
    check('service areas', areas.length > 0);
    const sel = await area.selectAreas({ newAreas: [areas[areas.length - 1].areaId] });
    check('selectAreas', sel.status === ServiceArea.SelectAreasStatus.Success, JSON.stringify(sel));
    check('selectedAreas updated', JSON.stringify(await area.getSelectedAreasAttribute(true)) === JSON.stringify([areas[areas.length - 1].areaId]));
    const bad = await area.selectAreas({ newAreas: [999] }).catch((e) => ({ status: 'error', e: e.message }));
    check('selectAreas rejects unknown area', bad.status !== ServiceArea.SelectAreasStatus.Success, JSON.stringify(bad));
    await area.selectAreas({ newAreas: [] });
  }

  // clean mode change → robot settings
  const r1 = await clean.changeToMode({ newMode: 4 });
  check('changeToMode clean=4 (Vacuum Turbo)', r1.status === 0, JSON.stringify(r1));
  check('clean mode is 4', (await clean.getCurrentModeAttribute(true)) === 4);
  const r2 = await clean.changeToMode({ newMode: initialClean });
  check(`changeToMode clean=${initialClean} (restore)`, r2.status === 0, JSON.stringify(r2));
  const r3 = await clean.changeToMode({ newMode: 99 }).catch((e) => ({ status: -1, e: e.message }));
  check('invalid clean mode rejected', r3.status !== 0, JSON.stringify(r3));

  await ident.identify({ identifyTime: 3 });
  check('identify (locate)', true);

  if (move) {
    const moveMode = arg('clean-mode') ? Number(arg('clean-mode')) : undefined;
    if (moveMode !== undefined) {
      const r = await clean.changeToMode({ newMode: moveMode });
      check(`clean mode ${moveMode} for the drive test`, r.status === 0);
    }
    if (room !== undefined && area) {
      await area.selectAreas({ newAreas: [room] });
    }
    const s1 = await run.changeToMode({ newMode: 1 });
    check('start cleaning (run mode → Cleaning)', s1.status === 0, JSON.stringify(s1));
    await sleep(15000);
    const after = await op.getOperationalStateAttribute(true);
    console.log('  state after start:', after, 'run mode', await run.getCurrentModeAttribute(true), 'error', JSON.stringify(await op.getOperationalErrorAttribute(true)));
    check('run mode Cleaning', (await run.getCurrentModeAttribute(true)) === 1);
    check('operational state Running', after === 1, String(after));
    const p = await op.pause();
    check('pause', p.commandResponseState.errorStateId === 0);
    await sleep(8000);
    check('operational state Paused', (await op.getOperationalStateAttribute(true)) === 2, String(await op.getOperationalStateAttribute(true)));
    const res = await op.resume();
    check('resume', res.commandResponseState.errorStateId === 0);
    await sleep(8000);
    check('operational state Running again', (await op.getOperationalStateAttribute(true)) === 1, String(await op.getOperationalStateAttribute(true)));
    const h = await op.goHome();
    check('goHome', h.commandResponseState.errorStateId === 0);
    await sleep(10000);
    const st = await op.getOperationalStateAttribute(true);
    check('operational state SeekingCharger/Charging/Docked', [64, 65, 66].includes(st), String(st));
    check('run mode Idle after goHome', (await run.getCurrentModeAttribute(true)) === 0);
    if (moveMode !== undefined) {
      await clean.changeToMode({ newMode: initialClean });
    }
  }
} catch (e) {
  console.error('ERROR', e);
  failures++;
} finally {
  if (nodeId) {
    await controller.removeNode(nodeId, true).catch(() => undefined);
  }
  await controller.close();
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
