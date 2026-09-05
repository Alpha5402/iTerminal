export interface ByteRingSnapshot {
  readonly data: string;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export class BoundedByteRing {
  readonly #buffer: Buffer;
  #start = 0;
  #length = 0;
  #totalBytes = 0;

  public constructor(private readonly capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new Error("Ring capacity must be a positive safe integer");
    }
    this.#buffer = Buffer.alloc(capacityBytes);
  }

  public append(data: string | Buffer): void {
    const incoming = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.#totalBytes += incoming.length;
    if (incoming.length >= this.capacityBytes) {
      incoming.copy(this.#buffer, 0, incoming.length - this.capacityBytes);
      this.#start = 0;
      this.#length = this.capacityBytes;
      return;
    }
    const end = (this.#start + this.#length) % this.capacityBytes;
    const first = Math.min(incoming.length, this.capacityBytes - end);
    incoming.copy(this.#buffer, end, 0, first);
    incoming.copy(this.#buffer, 0, first);
    const discarded = Math.max(0, this.#length + incoming.length - this.capacityBytes);
    this.#start = (this.#start + discarded) % this.capacityBytes;
    this.#length = Math.min(this.capacityBytes, this.#length + incoming.length);
  }

  public snapshot(): ByteRingSnapshot {
    // Decode only after reassembling bytes: a UTF-8 glyph can straddle the physical wrap.
    const data = Buffer.allocUnsafe(this.#length);
    const first = Math.min(this.#length, this.capacityBytes - this.#start);
    this.#buffer.copy(data, 0, this.#start, this.#start + first);
    this.#buffer.copy(data, first, 0, this.#length - first);
    return {
      byteLength: this.#length,
      data: data.toString("utf8"),
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#length,
    };
  }
}
