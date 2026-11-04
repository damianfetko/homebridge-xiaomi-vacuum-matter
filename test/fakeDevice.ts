/**
 * A fake miIO device speaking the real encrypted protocol over UDP on localhost.
 * Emulates the subset of xiaomi.vacuum.c102gl used by the plugin.
 */
import dgram from 'node:dgram';
import { buildPacket, decodePacket, deriveKeys, HEADER_LENGTH, MAGIC } from '../src/miio/protocol.js';

export const TOKEN = '00112233445566778899aabbccddeeff';
export const DEVICE_ID = 123456789;

export class FakeVacuum {
  readonly keys = deriveKeys(TOKEN);
  readonly socket = dgram.createSocket('udp4');
  props = new Map<string, unknown>();
  calls: Array<{ method: string; params: any }> = [];
  /** Drop the next N requests (simulate packet loss). */
  dropNext = 0;
  /** Do not answer at all. */
  silent = false;
  private readonly boot = Date.now();
  port = 0;

  constructor() {
    const init: Record<string, unknown> = {
      '2.1': 13, '2.2': 0, '2.3': 1, '3.1': 100, '3.2': 1, '4.1': 14, '4.2': 0, '4.3': 0,
      '4.5': 2, '4.6': 1, '4.7': 0, '4.23': 133120, '4.25': 0, '4.27': 0,
      '9.2': 95, '10.2': 93, '11.1': 90, '18.1': 83, '7.1': 75, '12.2': 804, '12.3': 18, '12.4': 659,
    };
    for (const [k, v] of Object.entries(init)) {
      this.props.set(k, v);
    }
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.port, rinfo.address));
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.socket.bind(0, '127.0.0.1', () => r()));
    this.port = this.socket.address().port;
    return this.port;
  }

  close(): void {
    this.socket.close();
  }

  private stamp(): number {
    return 1000 + Math.floor((Date.now() - this.boot) / 1000);
  }

  private onMessage(msg: Buffer, port: number, address: string): void {
    if (this.silent) {
      return;
    }
    if (msg.length === HEADER_LENGTH) {
      const hello = Buffer.alloc(32, 0);
      hello.writeUInt16BE(MAGIC, 0);
      hello.writeUInt16BE(32, 2);
      hello.writeUInt32BE(DEVICE_ID, 8);
      hello.writeUInt32BE(this.stamp(), 12);
      this.socket.send(hello, port, address);
      return;
    }
    if (this.dropNext > 0) {
      this.dropNext--;
      return;
    }
    let data: any;
    try {
      data = decodePacket(this.keys, msg).data;
    } catch {
      return; // real devices silently ignore packets with a wrong token
    }
    this.calls.push({ method: data.method, params: data.params });
    const result = this.handle(data.method, data.params);
    const reply = buildPacket(this.keys, DEVICE_ID, this.stamp(), 'error' in result ? { id: data.id, error: result.error } : { id: data.id, result: result.result });
    this.socket.send(reply, port, address);
  }

  private handle(method: string, params: any): { result?: unknown; error?: unknown } {
    switch (method) {
      case 'miIO.info':
        return { result: { model: 'xiaomi.vacuum.c102gl', fw_ver: '4.5.6_1087', mac: '02:00:00:00:00:01' } };
      case 'get_properties':
        return {
          result: params.map((p: any) => {
            const key = `${p.siid}.${p.piid}`;
            return this.props.has(key) ? { ...p, code: 0, value: this.props.get(key) } : { ...p, code: -1 };
          }),
        };
      case 'set_properties':
        return {
          result: params.map((p: any) => {
            this.props.set(`${p.siid}.${p.piid}`, p.value);
            if (p.siid === 2 && p.piid === 3) {
              this.props.set('4.4', p.value);
            }
            return { siid: p.siid, piid: p.piid, code: 0 };
          }),
        };
      case 'action':
        this.applyAction(params.siid, params.aiid, params.in);
        return { result: { siid: params.siid, aiid: params.aiid, code: 0, out: [] } };
      case 'fail':
        return { error: { code: -9999, message: 'boom' } };
      default:
        return { error: { code: -32601, message: 'Method not found' } };
    }
  }

  private applyAction(siid: number, aiid: number, _args: unknown): void {
    const key = `${siid}.${aiid}`;
    if (key === '2.1') {
      this.props.set('2.1', 1);
      this.props.set('4.7', 1);
      this.props.set('3.2', 2);
    } else if (key === '2.2') {
      this.props.set('2.1', 3);
    } else if (key === '4.1') {
      this.props.set('2.1', 1);
      this.props.set('4.1', 18);
      this.props.set('4.7', 3);
    } else if (key === '4.2') {
      this.props.set('2.1', 2);
      this.props.set('4.7', 0);
    } else if (key === '3.1') {
      this.props.set('2.1', 5);
    }
  }
}
