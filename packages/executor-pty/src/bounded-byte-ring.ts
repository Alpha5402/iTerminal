export interface ByteRingSnapshot {
  readonly data: string;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export class BoundedByteRing {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #totalBytes = 0;

  public constructor(private readonly capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new Error("Ring capacity must be a positive safe integer");
    }
  }

  public append(data: string | Buffer): void {
    const incoming = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.#totalBytes += incoming.length;
    if (incoming.length >= this.capacityBytes) {
      this.#buffer = incoming.subarray(incoming.length - this.capacityBytes);
      return;
    }
    const combined = Buffer.concat([this.#buffer, incoming]);
    this.#buffer =
      combined.length <= this.capacityBytes
        ? combined
        : combined.subarray(combined.length - this.capacityBytes);
  }

  public snapshot(): ByteRingSnapshot {
    return {
      byteLength: this.#buffer.length,
      data: this.#buffer.toString("utf8"),
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#buffer.length,
    };
  }
}
