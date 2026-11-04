// Commission the vacuum and print operationalState/operationalError every 3 s (diagnostics).
import { Environment, StorageService } from '@matter/main';
import { GeneralCommissioning, RvcOperationalState } from '@matter/main/clusters';
import { CommissioningController } from '@project-chip/matter.js';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import path from 'node:path';
const a = (n) => process.argv[process.argv.indexOf(`--${n}`) + 1];
const env = Environment.default; env.vars.set('storage.path', mkdtempSync(path.join(tmpdir(), 'xvm-w-'))); env.vars.set('log.level', 'error'); env.get(StorageService);
const c = new CommissioningController({ environment: { environment: env, id: 'w' }, autoConnect: false, adminFabricLabel: 'w' });
await c.start();
const id = await c.commissionNode({ commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: 'SK' },
  discovery: { knownAddress: { ip: '127.0.0.1', port: Number(a('port')), type: 'udp' }, identifierData: { longDiscriminator: Number(a('discriminator')) } }, passcode: Number(a('passcode')) });
const node = await c.getNode(id); node.connect(); if (!node.initialized) await node.events.initialized;
const op = node.getDevices().find((d) => d.getClusterClient(RvcOperationalState.Cluster)).getClusterClient(RvcOperationalState.Cluster);
for (let i = 0; i < Number(a('count') ?? 20); i++) {
  console.log(new Date().toISOString().slice(11, 19), await op.getOperationalStateAttribute(true), JSON.stringify(await op.getOperationalErrorAttribute(true)));
  await new Promise((r) => setTimeout(r, 3000));
}
await c.removeNode(id, true).catch(() => {}); await c.close(); process.exit(0);
