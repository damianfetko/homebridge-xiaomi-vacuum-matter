/**
 * miIO binary protocol (UDP port 54321).
 *
 * Packet layout (all big-endian):
 *   0  u16 magic 0x2131
 *   2  u16 total length (header + payload)
 *   4  u32 unknown (0, or 0xFFFFFFFF for hello)
 *   8  u32 device id
 *  12  u32 stamp (seconds since device boot)
 *  16  16B checksum = md5(header-with-token-in-checksum-field + payload)
 *  32  payload  = AES-128-CBC(key = md5(token), iv = md5(key + token)), PKCS#7
 */
import crypto from 'node:crypto';

export const MIIO_PORT = 54321;
export const MAGIC = 0x2131;
export const HEADER_LENGTH = 32;

export interface MiioKeys {
  token: Buffer;
  key: Buffer;
  iv: Buffer;
}

export function deriveKeys(tokenHex: string): MiioKeys {
  if (!/^[0-9a-fA-F]{32}$/.test(tokenHex)) {
    throw new Error('Token must be a 32 character hex string');
  }
  const token = Buffer.from(tokenHex, 'hex');
  const key = md5(token);
  const iv = md5(Buffer.concat([key, token]));
  return { token, key, iv };
}

function md5(data: Buffer): Buffer {
  return crypto.createHash('md5').update(data).digest();
}

export function encrypt(keys: MiioKeys, plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', keys.key, keys.iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

export function decrypt(keys: MiioKeys, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keys.key, keys.iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function buildHello(): Buffer {
  const packet = Buffer.alloc(HEADER_LENGTH, 0xff);
  packet.writeUInt16BE(MAGIC, 0);
  packet.writeUInt16BE(HEADER_LENGTH, 2);
  return packet;
}

export interface ParsedHeader {
  length: number;
  deviceId: number;
  stamp: number;
  checksum: Buffer;
}

export function parseHeader(packet: Buffer): ParsedHeader {
  if (packet.length < HEADER_LENGTH) {
    throw new Error(`Packet too short (${packet.length} bytes)`);
  }
  if (packet.readUInt16BE(0) !== MAGIC) {
    throw new Error('Invalid miIO magic');
  }
  return {
    length: packet.readUInt16BE(2),
    deviceId: packet.readUInt32BE(8),
    stamp: packet.readUInt32BE(12),
    checksum: packet.subarray(16, 32),
  };
}

export function buildPacket(keys: MiioKeys, deviceId: number, stamp: number, payload: object): Buffer {
  const encrypted = encrypt(keys, Buffer.from(JSON.stringify(payload), 'utf8'));
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt16BE(MAGIC, 0);
  header.writeUInt16BE(HEADER_LENGTH + encrypted.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);
  keys.token.copy(header, 16);
  const packet = Buffer.concat([header, encrypted]);
  md5(packet).copy(packet, 16);
  return packet;
}

/** Validate the checksum of a received packet. */
export function verifyChecksum(keys: MiioKeys, packet: Buffer): boolean {
  const copy = Buffer.from(packet);
  const received = Buffer.from(copy.subarray(16, 32));
  keys.token.copy(copy, 16);
  return md5(copy).equals(received);
}

/** Decode the payload of a response packet into a JSON object. */
export function decodePacket(keys: MiioKeys, packet: Buffer): { header: ParsedHeader; data: any } {
  const header = parseHeader(packet);
  if (packet.length === HEADER_LENGTH) {
    return { header, data: null };
  }
  if (!verifyChecksum(keys, packet)) {
    throw new Error('Checksum mismatch – wrong token?');
  }
  const text = decrypt(keys, packet.subarray(HEADER_LENGTH, header.length))
    .toString('utf8')
    .replace(/\0+$/, '');
  return { header, data: parseJsonLenient(text) };
}

/** Some firmwares emit slightly broken JSON (trailing commas, raw control chars). */
export function parseJsonLenient(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0019]+/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}
