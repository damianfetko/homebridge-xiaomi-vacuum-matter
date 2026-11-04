// Commission the vacuum and print run mode / operational state every 3 s, both as a
// subscribing controller (like Apple Home) sees them and as read directly from the device.
import { Environment, StorageService } from '@matter/main';
import { GeneralCommissioning, RvcOperationalState, RvcRunMode, RvcCleanMode } from '@matter/main/clusters';
import { CommissioningController } from '@project-chip/matter.js';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import path from 'node:path';
const a = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const env = Environment.default; env.vars.set('storage.path', mkdtempSync(path.join(tmpdir(), 'xvm-s-'))); env.vars.set('log.level', 'error'); env.get(StorageService);
const c = new CommissioningController({ environment: { environment: env, id: 's' }, autoConnect: false, adminFabricLabel: 's' });
await c.start();
const id = await c.commissionNode({ commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: 'SK' },
  discovery: { knownAddress: { ip: a('ip', '127.0.0.1'), port: Number(a('port')), type: 'udp' }, identifierData: { longDiscriminator: Number(a('discriminator')) } }, passcode: Number(a('passcode')) });
const node = await c.getNode(id); node.connect(); if (!node.initialized) await node.events.initialized;
const dev = node.getDevices().find((d) => d.getClusterClient(RvcRunMode.Cluster));
const run = dev.getClusterClient(RvcRunMode.Cluster), op = dev.getClusterClient(RvcOperationalState.Cluster), cm = dev.getClusterClient(RvcCleanMode.Cluster);
console.log('time      | subscribed run/op/clean | device run/op/clean');
for (let i = 0; i < Number(a('count', 20)); i++) {
  const sub = [await run.getCurrentModeAttribute(), await op.getOperationalStateAttribute(), await cm.getCurrentModeAttribute()];
  const rem = [await run.getCurrentModeAttribute(true), await op.getOperationalStateAttribute(true), await cm.getCurrentModeAttribute(true)];
  console.log(new Date().toISOString().slice(11, 19), '|', sub.join('/').padEnd(23), '|', rem.join('/'), JSON.stringify(sub) === JSON.stringify(rem) ? '' : '  <-- MISMATCH');
  await new Promise((r) => setTimeout(r, 3000));
}
await c.removeNode(id, true).catch(() => {}); await c.close(); process.exit(0);
