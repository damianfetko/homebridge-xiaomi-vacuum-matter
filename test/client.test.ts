import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiioClient, MiioError, MiioTimeoutError } from '../src/miio/client.js';
import { DEVICE_ID, FakeVacuum, TOKEN } from './fakeDevice.js';

let dev: FakeVacuum;
let client: MiioClient;

beforeEach(async () => {
  dev = new FakeVacuum();
  const port = await dev.listen();
  client = new MiioClient({ address: '127.0.0.1', port, token: TOKEN, timeout: 300, retries: 3 });
});
afterEach(() => {
  client.close();
  dev.close();
});

describe('MiioClient', () => {
  it('handshakes and reads miIO.info', async () => {
    const info = await client.info();
    expect(info.model).toBe('xiaomi.vacuum.c102gl');
    expect(client.connectedDeviceId).toBe(DEVICE_ID);
  });

  it('reads properties in chunks', async () => {
    const refs = Array.from({ length: 22 }, (_, i) => ({ siid: 2, piid: i + 1 }));
    const res = await client.getProperties(refs, 10);
    expect(res).toHaveLength(22);
    expect(dev.calls.filter((c) => c.method === 'get_properties')).toHaveLength(3);
    expect(res[0]).toMatchObject({ siid: 2, piid: 1, code: 0, value: 13 });
    expect(res[5].code).toBe(-1);
  });

  it('writes properties and runs actions', async () => {
    await client.setProperties([{ siid: 2, piid: 3, value: 3 }]);
    expect(dev.props.get('4.4')).toBe(3);
    await client.action(2, 1);
    expect(dev.props.get('2.1')).toBe(1);
  });

  it('retries after packet loss', async () => {
    await client.info();
    dev.dropNext = 2;
    const info = await client.info();
    expect(info.model).toBe('xiaomi.vacuum.c102gl');
  });

  it('fails with a timeout when the device is silent', async () => {
    dev.silent = true;
    await expect(client.info()).rejects.toBeInstanceOf(MiioTimeoutError);
  });

  it('propagates device errors without retrying', async () => {
    await expect(client.call('fail')).rejects.toBeInstanceOf(MiioError);
    expect(dev.calls.filter((c) => c.method === 'fail')).toHaveLength(1);
  });

  it('serializes concurrent requests and matches responses by id', async () => {
    const results = await Promise.all([client.info(), client.getProperties([{ siid: 3, piid: 1 }]), client.info()]);
    expect(results[1][0].value).toBe(100);
    expect(results[0].model).toBe(results[2].model);
  });

  it('recovers after the device was offline', async () => {
    dev.silent = true;
    await expect(client.info()).rejects.toThrow();
    dev.silent = false;
    await expect(client.info()).resolves.toMatchObject({ model: 'xiaomi.vacuum.c102gl' });
  });

  it('rejects with a wrong token', async () => {
    const bad = new MiioClient({ address: '127.0.0.1', port: dev.port, token: 'ff'.repeat(16), timeout: 200, retries: 1 });
    await expect(bad.info()).rejects.toThrow();
    bad.close();
  });
});
