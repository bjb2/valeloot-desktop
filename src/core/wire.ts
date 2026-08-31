/**
 * FishNet payload primitives, as used by SpiritVale's `CharacterData` RPCs.
 *
 * Wire facts (all four verified against the game's own IL2CPP dump + the shapes the client
 * serialises; see docs/character-data-layout.md for the provenance table):
 *   bool      1 byte, 1 = true.
 *   objectRef 1 leading byte per nullable reference field: 0 = the object follows, 1 = null.
 *   packed    LEB128 varint carrying a zig-zag encoded signed integer: (raw >> 1) ^ -(raw & 1).
 *   string    packed byte length (-1 = null) followed by that many UTF-8 bytes.
 *   float     4 bytes little-endian.
 *   list      packed count (-1 = null/empty) followed by count elements.
 *   dict      packed count (-1 = null/empty) followed by count (string key, value) pairs.
 *
 * `Reader` never trusts the payload: every length is bounded and every read is range-checked, so a
 * malformed or drifted packet throws instead of walking off the buffer or allocating wildly.
 * `Writer` is the exact inverse and exists so tests can build payloads byte-for-byte (fixtures) —
 * it is never used to send anything. Nothing in this package writes to a socket.
 */

export class WireError extends Error {}

const MAX_COLLECTION = 100_000;

export class Reader {
  #buf: Uint8Array;
  #view: DataView;
  #at = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get offset(): number { return this.#at; }
  get remaining(): number { return this.#buf.length - this.#at; }

  #need(n: number): void {
    if (this.#at + n > this.#buf.length) throw new WireError(`truncated payload: need ${n} byte(s) at ${this.#at}/${this.#buf.length}`);
  }

  bool(): boolean {
    this.#need(1);
    return this.#buf[this.#at++] === 1;
  }

  /**
   * A boolean that REFUSES anything but 0 or 1.
   *
   * `bool()` is forgiving because a field we only skip past does not need policing. Shape
   * identification is the opposite job: it decides whether an anonymous payload is the message we
   * think it is, and a byte of 0x7f quietly reading as `false` is exactly how a wrong guess survives
   * long enough to be believed.
   */
  flag(): boolean {
    this.#need(1);
    const byte = this.#buf[this.#at++]!;
    if (byte > 1) throw new WireError(`boolean byte ${byte} is neither 0 nor 1`);
    return byte === 1;
  }

  /** Leading null-flag of a nullable reference field. true = the object's fields follow. */
  objectRef(): boolean { return !this.bool(); }

  packed(): number {
    let raw = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      this.#need(1);
      const byte = this.#buf[this.#at++]!;
      raw |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        const signed = (raw >> 1n) ^ -(raw & 1n);
        const value = Number(signed);
        if (!Number.isSafeInteger(value)) throw new WireError('packed integer out of safe range');
        return value;
      }
      shift += 7n;
    }
    throw new WireError('packed integer never terminated');
  }

  string(max: number): string | null {
    const len = this.packed();
    if (len === -1) return null;
    if (len < 0 || len > max) throw new WireError(`string length ${len} outside 0..${max}`);
    this.#need(len);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#buf.subarray(this.#at, this.#at + len));
    this.#at += len;
    return text;
  }

  float(): number {
    this.#need(4);
    const value = this.#view.getFloat32(this.#at, true);
    this.#at += 4;
    return value;
  }

  /** Element count of a list/dictionary; -1 (null) reads as 0. */
  count(): number {
    const n = this.packed();
    if (n === -1) return 0;
    if (n < 0 || n > MAX_COLLECTION) throw new WireError(`collection length ${n} outside 0..${MAX_COLLECTION}`);
    return n;
  }

  list<T>(read: (index: number) => T): T[] {
    const n = this.count();
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = read(i);
    return out;
  }

  /** Dictionary<string, V> — the key is read for you and handed to `read` alongside the index. */
  dict<T>(read: (key: string, index: number) => T): T[] {
    const n = this.count();
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const key = this.string(256) ?? '';
      out[i] = read(key, i);
    }
    return out;
  }
}

export class Writer {
  #bytes: number[] = [];

  bytes(): Uint8Array { return new Uint8Array(this.#bytes); }

  bool(value: boolean): this { this.#bytes.push(value ? 1 : 0); return this; }

  /** Write the leading null-flag: present = the object's fields follow. */
  objectRef(present: boolean): this { return this.bool(!present); }

  packed(value: number): this {
    if (!Number.isSafeInteger(value)) throw new WireError('packed integer out of safe range');
    let remaining = (BigInt(value) << 1n) ^ (BigInt(value) >> 63n);
    while (remaining >= 0x80n) {
      this.#bytes.push(Number((remaining & 0x7fn) | 0x80n));
      remaining >>= 7n;
    }
    this.#bytes.push(Number(remaining));
    return this;
  }

  string(value: string | null): this {
    if (value === null) return this.packed(-1);
    const bytes = new TextEncoder().encode(value);
    this.packed(bytes.length);
    for (const byte of bytes) this.#bytes.push(byte);
    return this;
  }

  float(value: number): this {
    const buf = new DataView(new ArrayBuffer(4));
    buf.setFloat32(0, value, true);
    for (let i = 0; i < 4; i++) this.#bytes.push(buf.getUint8(i));
    return this;
  }

  list<T>(values: readonly T[], write: (value: T, index: number) => void): this {
    this.packed(values.length);
    values.forEach((value, index) => write(value, index));
    return this;
  }

  dict<T>(entries: ReadonlyArray<readonly [string, T]>, write: (value: T, key: string) => void): this {
    this.packed(entries.length);
    for (const [key, value] of entries) { this.string(key); write(value, key); }
    return this;
  }
}
