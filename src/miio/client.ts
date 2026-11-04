import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  buildHello,
  buildPacket,
  decodePacket,
  deriveKeys,
  MIIO_PORT,
  type MiioKeys,
  parseHeader,
} from './protocol.js';

export interface MiioClientOptions {
  address: string;
  token: string;
  /** Optional, used only for validation / logging (the device id is taken from the handshake). */
  deviceId?: number;
  port?: number;
  /** Timeout of one request attempt in ms. */
  timeout?: number;
  /** Number of attempts per request. */
  retries?: number;
  /** Re-handshake after this many ms without traffic (stamp drift protection). */
  sessionTtl?: number;
  logger?: { debug: (msg: string) => void };
}

export class MiioError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = 'MiioError';
  }
}

export class MiioTimeoutError extends MiioError {
  constructor(message: string) {
    super(message);
    this.name = 'MiioTimeoutError';
  }
}

export interface MiotPropertyRef {
  siid: number;
  piid: number;
}

export interface MiotPropertyResult extends MiotPropertyRef {
  code: number;
  value?: unknown;
}

export interface MiotActionArg {
  piid: number;
  value: unknown;
}

interface Pending {
  id: number;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/**
 * Local miIO client. Talks to the device directly over UDP – no cloud involved.
 * Requests are serialized (the robots handle one request at a time reliably).
 */
export class MiioClient extends EventEmitter {
  private readonly keys: MiioKeys;
  private readonly port: number;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly sessionTtl: number;
  private socket?: dgram.Socket;
  private deviceId?: number;
  private stampBase = 0;
  private stampAt = 0;
  private lastSeen = 0;
  private messageId: number;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: Pending;
  private handshakeWaiter?: { resolve: (b: Buffer) => void };
  private closed = false;

  constructor(private readonly options: MiioClientOptions) {
    super();
    this.keys = deriveKeys(options.token);
    this.port = options.port ?? MIIO_PORT;
    this.timeout = options.timeout ?? 3000;
    this.retries = Math.max(1, options.retries ?? 3);
    this.sessionTtl = options.sessionTtl ?? 60_000;
    // Devices drop requests with an id that is not larger than the previous one
    // (per session). Start from a time-based value so restarts never go backwards.
    this.messageId = (Math.floor(Date.now() / 1000) % 100_000) * 10 + 1;
  }

  get connectedDeviceId(): number | undefined {
    return this.deviceId;
  }

  private debug(msg: string): void {
    this.options.logger?.debug(`[miio ${this.options.address}] ${msg}`);
  }

  private ensureSocket(): dgram.Socket {
    if (this.socket) {
      return this.socket;
    }
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
    socket.on('error', (err) => {
      this.debug(`socket error: ${err.message}`);
      this.resetSocket();
    });
    this.socket = socket;
    return socket;
  }

  private resetSocket(): void {
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = undefined;
    this.deviceId = undefined;
  }

  private onMessage(msg: Buffer, from: string): void {
    if (from !== this.options.address) {
      return;
    }
    try {
      const header = parseHeader(msg);
      if (msg.length === 32) {
        // Handshake response
        this.handshakeWaiter?.resolve(msg);
        return;
      }
      const { data } = decodePacket(this.keys, msg);
      this.stampBase = header.stamp;
      this.stampAt = Date.now();
      this.lastSeen = Date.now();
      if (!this.pending || !data || data.id !== this.pending.id) {
        this.debug(`ignoring unexpected response ${JSON.stringify(data)?.slice(0, 200)}`);
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      if (data.error) {
        pending.reject(new MiioError(`Device error: ${data.error.message ?? JSON.stringify(data.error)}`, data.error.code));
      } else {
        pending.resolve(data.result);
      }
    } catch (err) {
      this.debug(`failed to decode packet: ${(err as Error).message}`);
    }
  }

  private send(packet: Buffer): Promise<void> {
    const socket = this.ensureSocket();
    return new Promise((resolve, reject) => {
      socket.send(packet, this.port, this.options.address, (err) => (err ? reject(err) : resolve()));
    });
  }

  private async handshake(): Promise<void> {
    const response = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = undefined;
        reject(new MiioTimeoutError(`Handshake with ${this.options.address} timed out`));
      }, this.timeout);
      this.handshakeWaiter = {
        resolve: (buf) => {
          clearTimeout(timer);
          this.handshakeWaiter = undefined;
          resolve(buf);
        },
      };
      this.send(buildHello()).catch((err) => {
        clearTimeout(timer);
        this.handshakeWaiter = undefined;
        reject(err);
      });
    });
    const header = parseHeader(response);
    this.deviceId = header.deviceId;
    this.stampBase = header.stamp;
    this.stampAt = Date.now();
    this.lastSeen = Date.now();
    if (this.options.deviceId && this.options.deviceId !== header.deviceId) {
      this.debug(`device id mismatch: configured ${this.options.deviceId}, device reports ${header.deviceId}`);
    }
    this.debug(`handshake ok, device id ${header.deviceId}, stamp ${header.stamp}`);
  }

  private currentStamp(): number {
    return this.stampBase + Math.floor((Date.now() - this.stampAt) / 1000);
  }

  private async attempt(method: string, params: unknown, forceHandshake: boolean): Promise<any> {
    if (forceHandshake || this.deviceId === undefined || Date.now() - this.lastSeen > this.sessionTtl) {
      await this.handshake();
    }
    const id = this.messageId++;
    if (this.messageId > 2_000_000_000) {
      this.messageId = 1;
    }
    const packet = buildPacket(this.keys, this.deviceId!, this.currentStamp() + 1, { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = undefined;
        }
        reject(new MiioTimeoutError(`Request "${method}" timed out`));
      }, this.timeout);
      this.pending = {
        id,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.send(packet).catch((err) => {
        clearTimeout(timer);
        this.pending = undefined;
        reject(err);
      });
    });
  }

  /** Send a raw miIO command. Retries on timeouts with a fresh handshake. */
  call<T = any>(method: string, params: unknown = []): Promise<T> {
    if (this.closed) {
      return Promise.reject(new MiioError('Client closed'));
    }
    const run = async (): Promise<T> => {
      let lastError: Error | undefined;
      for (let i = 0; i < this.retries; i++) {
        try {
          const result = await this.attempt(method, params, i > 0);
          this.emit('online');
          return result as T;
        } catch (err) {
          lastError = err as Error;
          if (!(err instanceof MiioTimeoutError)) {
            // Device answered with an error, retrying would not help
            if (err instanceof MiioError) {
              throw err;
            }
          }
          this.debug(`attempt ${i + 1}/${this.retries} for ${method} failed: ${lastError.message}`);
        }
      }
      this.emit('offline', lastError);
      throw lastError ?? new MiioError('Unknown error');
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** MIoT get_properties, chunked (devices reject too large batches). */
  async getProperties(props: MiotPropertyRef[], chunkSize = 15): Promise<MiotPropertyResult[]> {
    const out: MiotPropertyResult[] = [];
    for (let i = 0; i < props.length; i += chunkSize) {
      const chunk = props.slice(i, i + chunkSize).map((p) => ({ did: String(this.deviceId ?? ''), siid: p.siid, piid: p.piid }));
      const result = await this.call<MiotPropertyResult[]>('get_properties', chunk);
      out.push(...(result ?? []));
    }
    return out;
  }

  async setProperties(props: Array<MiotPropertyRef & { value: unknown }>): Promise<MiotPropertyResult[]> {
    const result = await this.call<MiotPropertyResult[]>(
      'set_properties',
      props.map((p) => ({ did: String(this.deviceId ?? ''), siid: p.siid, piid: p.piid, value: p.value })),
    );
    for (const r of result ?? []) {
      if (r.code !== 0) {
        throw new MiioError(`set_properties ${r.siid}.${r.piid} failed with code ${r.code}`, r.code);
      }
    }
    return result;
  }

  async action(siid: number, aiid: number, args: MiotActionArg[] = []): Promise<any> {
    const result = await this.call<any>('action', { did: String(this.deviceId ?? ''), siid, aiid, in: args });
    if (result && typeof result.code === 'number' && result.code !== 0) {
      throw new MiioError(`action ${siid}.${aiid} failed with code ${result.code}`, result.code);
    }
    return result;
  }

  async info(): Promise<Record<string, any>> {
    return this.call('miIO.info', []);
  }

  close(): void {
    this.closed = true;
    this.pending?.reject(new MiioError('Client closed'));
    this.pending = undefined;
    this.resetSocket();
  }
}
