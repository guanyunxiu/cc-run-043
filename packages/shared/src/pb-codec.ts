/**
 * 极小 Protobuf 线格式编解码器。
 *
 * 只实现房间控制协议所需的 wire types：
 *   - varint    (wire type 0)
 *   - bytes/string/message (wire type 2, length-delimited)
 *
 * Yjs 文档增量本身不在此编码：见 ./y-protobuf-compat.ts，
 * 其字节布局与官方 y-protobuf（SyncStep / Update 信封）完全兼容。
 *
 * 手写实现而非引入 protobufjs，目的：
 *   1) 零依赖、可同时在浏览器 / Node 运行；
 *   2) 输出确定的二进制，便于幂等去重（见 SyncManager 暂存队列）。
 */

const MAX_VARINT_BYTES = 10;

export class PbWriter {
  private parts: number[] = [];

  private varint(value: number): void {
    // 安全处理 32 位有符号 / 无符号；房间协议字段远小于 2^31。
    let v = value >>> 0;
    while (v >= 0x80) {
      this.parts.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.parts.push(v);
  }

  private tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  /** wire type 0 */
  writeUint32(field: number, value: number): this {
    this.tag(field, 0);
    this.varint(value);
    return this;
  }

  /** wire type 2 */
  writeString(field: number, value: string): this {
    this.tag(field, 2);
    const bytes = new TextEncoder().encode(value);
    this.varint(bytes.length);
    for (const b of bytes) this.parts.push(b);
    return this;
  }

  /** wire type 2（字节数组 / 嵌套消息） */
  writeBytes(field: number, value: Uint8Array): this {
    this.tag(field, 2);
    this.varint(value.length);
    this.parts.push(...value);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export class PbReader {
  private view: DataView;
  private bytes: Uint8Array;
  offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get eof(): boolean {
    return this.offset >= this.bytes.length;
  }

  private readVarint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < MAX_VARINT_BYTES; i++) {
      const b = this.bytes[this.offset++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    throw new Error('varint overflow');
  }

  /** 读取 (fieldNumber, wireType) */
  readTag(): { field: number; wireType: number } {
    const t = this.readVarint();
    return { field: t >>> 3, wireType: t & 0x7 };
  }

  readUint32(): number {
    return this.readVarint();
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const start = this.offset;
    this.offset += len;
    return this.bytes.subarray(start, this.offset);
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  /**
   * 将一条 length-delimited 消息按字段展开为 Map（重复字段收集为数组）。
   * 房间协议没有重复的标量字段，重复的嵌套消息使用数组。
   */
  readFields(): Map<number, number[] | Uint8Array[]> {
    const fields = new Map<number, number[] | Uint8Array[]>();
    while (!this.eof) {
      const { field, wireType } = this.readTag();
      let value: number | Uint8Array;
      if (wireType === 0) value = this.readUint32();
      else if (wireType === 2) value = this.readBytes();
      else throw new Error(`unsupported wire type ${wireType}`);
      const list = fields.get(field);
      if (list) list.push(value as never);
      else fields.set(field, [value] as number[] | Uint8Array[]);
    }
    return fields;
  }
}

/** 便捷读取辅助 */
export function firstUint(fields: Map<number, number[] | Uint8Array[]>, field: number): number | undefined {
  const v = fields.get(field);
  return v ? (v[0] as number) : undefined;
}

export function firstBytes(fields: Map<number, number[] | Uint8Array[]>, field: number): Uint8Array | undefined {
  const v = fields.get(field);
  return v ? (v[0] as Uint8Array) : undefined;
}

export function firstString(fields: Map<number, number[] | Uint8Array[]>, field: number): string | undefined {
  const b = firstBytes(fields, field);
  return b ? new TextDecoder().decode(b) : undefined;
}

export function allBytes(fields: Map<number, number[] | Uint8Array[]>, field: number): Uint8Array[] {
  const v = fields.get(field);
  return v ? (v as Uint8Array[]) : [];
}
