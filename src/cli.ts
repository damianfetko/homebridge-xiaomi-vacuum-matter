#!/usr/bin/env node
/**
 * Diagnostic CLI – talks to the robot locally, exactly like the plugin.
 *
 *   xvm-cli --ip 192.168.1.50 --token <hex> status
 *   xvm-cli ... info | start | pause | resume | stop | dock | locate | empty | wash | dry | stopdry
 *   xvm-cli ... room <id> [<id> ...]     clean given room/segment ids
 *   xvm-cli ... suction <0-3> | water <1-3> | type <sweep|mop|both|mopaftersweep>
 *   xvm-cli ... raw <method> [json-params]
 */
import { CleaningType, FAULT_NAMES, SuctionLevel, VacuumState, WaterLevel } from './device/spec.js';
import { XiaomiVacuum } from './device/vacuum.js';
import { cleanModeFromStatus, findCleanMode, operationalStateFromStatus, OpState } from './matter/mapping.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ip = arg('ip') ?? process.env.XVM_IP;
  const token = arg('token') ?? process.env.XVM_TOKEN;
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const [cmd = 'status', ...rest] = positional;
  if (!ip || !token) {
    console.error('Usage: xvm-cli --ip <ip> --token <token> <command> [...]  (or env XVM_IP / XVM_TOKEN)');
    process.exit(2);
  }
  const v = new XiaomiVacuum({ address: ip, token, logger: process.env.DEBUG ? { debug: console.error } : undefined });
  try {
    switch (cmd) {
      case 'info':
        console.log(JSON.stringify(await v.client.info(), null, 2));
        break;
      case 'status': {
        const s = await v.refresh();
        const op = operationalStateFromStatus(s);
        const opName = Object.entries(OpState).find(([, n]) => n === op)?.[0];
        const mode = findCleanMode(cleanModeFromStatus(s) ?? -1);
        console.log({
          state: `${s.state} (${VacuumState[s.state ?? -1] ?? '?'})`,
          fault: s.fault ? `${s.fault} (${FAULT_NAMES[s.fault] ?? '?'})` : 0,
          battery: `${s.battery}%`,
          suction: SuctionLevel[s.suction ?? -1],
          water: WaterLevel[s.waterLevel ?? -1],
          cleaningType: CleaningType[s.cleaningType ?? -1],
          taskActive: v.isTaskActive(s),
          matterOperationalState: opName,
          matterCleanMode: mode?.labels.en,
          consumables: { mainBrush: s.mainBrushLife, sideBrush: s.sideBrushLife, filter: s.filterLife, mop: s.mopLife },
          raw: s,
        });
        break;
      }
      case 'start': await v.startCleaning(); break;
      case 'pause': await v.pause(); break;
      case 'resume': await v.resume(); break;
      case 'stop': await v.stopCleaning(); break;
      case 'dock': await v.dock(); break;
      case 'locate': await v.locate(); break;
      case 'empty': await v.autoEmpty(); break;
      case 'wash': await v.washMop(); break;
      case 'dry': await v.startDrying(); break;
      case 'stopdry': await v.stopDrying(); break;
      case 'room': {
        const ids = rest.map(Number).filter(Number.isInteger);
        if (ids.length === 0) {
          throw new Error('room needs at least one numeric id');
        }
        await v.refresh();
        await v.cleanRooms(ids);
        break;
      }
      case 'suction': await v.setSuction(Number(rest[0]) as SuctionLevel); break;
      case 'water': await v.setWaterLevel(Number(rest[0]) as WaterLevel); break;
      case 'type': {
        const t = { sweep: CleaningType.Sweeping, mop: CleaningType.Mopping, both: CleaningType.SweepingAndMopping, mopaftersweep: CleaningType.MoppingAfterSweeping }[rest[0] ?? ''];
        if (t === undefined) {
          throw new Error('type must be sweep|mop|both|mopaftersweep');
        }
        await v.setCleaningType(t);
        break;
      }
      case 'raw':
        console.log(JSON.stringify(await v.client.call(rest[0], rest[1] ? JSON.parse(rest[1]) : []), null, 2));
        break;
      default:
        throw new Error(`Unknown command ${cmd}`);
    }
    if (!['status', 'info', 'raw'].includes(cmd)) {
      console.log('OK');
    }
  } finally {
    v.stop();
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
