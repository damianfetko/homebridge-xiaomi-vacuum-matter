import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHello, buildPacket, decodePacket, deriveKeys, parseHeader, parseJsonLenient, verifyChecksum } from '../src/miio/protocol.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('miIO protocol', () => {
  it('derives key and iv from token', () => {
    const k = deriveKeys(TOKEN);
    const token = Buffer.from(TOKEN, 'hex');
    expect(k.key).toEqual(crypto.createHash('md5').update(token).digest());
    expect(k.iv).toEqual(crypto.createHash('md5').update(Buffer.concat([k.key, token])).digest());
  });

  it('rejects invalid tokens', () => {
    expect(() => deriveKeys('abc')).toThrow();
    expect(() => deriveKeys('zz'.repeat(16))).toThrow();
  });

  it('builds a hello packet', () => {
    const h = buildHello();
    expect(h.length).toBe(32);
    expect(h.readUInt16BE(0)).toBe(0x2131);
    expect(h.readUInt16BE(2)).toBe(32);
    expect(h.subarray(4).every((b) => b === 0xff)).toBe(true);
  });

  it('round-trips an encrypted packet', () => {
    const keys = deriveKeys(TOKEN);
    const payload = { id: 42, method: 'get_properties', params: [{ siid: 2, piid: 1 }] };
    const pkt = buildPacket(keys, 123456789, 12345, payload);
    const header = parseHeader(pkt);
    expect(header.deviceId).toBe(123456789);
    expect(header.stamp).toBe(12345);
    expect(header.length).toBe(pkt.length);
    expect(verifyChecksum(keys, pkt)).toBe(true);
    expect(decodePacket(keys, pkt).data).toEqual(payload);
  });

  it('detects a wrong token through the checksum', () => {
    const pkt = buildPacket(deriveKeys(TOKEN), 1, 1, { id: 1 });
    expect(() => decodePacket(deriveKeys('00'.repeat(16)), pkt)).toThrow(/Checksum/);
  });

  it('detects tampering', () => {
    const keys = deriveKeys(TOKEN);
    const pkt = buildPacket(keys, 1, 1, { id: 1 });
    pkt[pkt.length - 1] ^= 0xff;
    expect(verifyChecksum(keys, pkt)).toBe(false);
  });

  it('parses slightly broken JSON from firmware', () => {
    expect(parseJsonLenient('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(parseJsonLenient('{"a":"x\u0001"}')).toEqual({ a: 'x' });
  });
});
