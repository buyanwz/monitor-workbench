// 本地文件存储适配层：实现业务代码所用的 R2 子集（put/get/delete/list），
// 文件全部存在 <数据目录>/files/ 下，key 即相对路径。零第三方依赖。
// 安全：key 按段清洗（防 .. 穿越），put/get/delete/list 走同一清洗规则，
// file_asset.storage_path 存的原始 key 与清洗后路径一一对应。

import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";

export interface BucketObjectBody {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BucketListedObject {
  key: string;
  uploaded: Date;
  size: number;
}

export interface BucketPutOptions {
  httpMetadata?: { contentType?: string };
}

export interface BucketGetOptions {
  range?: { offset: number; length: number };
}

/** 单段清洗：只留字母数字与 . _ -，多点折下划线，空段与 . / .. 一律变 _。 */
function cleanSegment(seg: string): string {
  let s = seg.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
  if (s === "" || s === "." || s === "..") s = "_";
  return s;
}

/** key → 相对路径（POSIX 段），统一清洗规则。 */
export function storageRelPath(key: string): string {
  const segs = String(key).split("/").filter((s) => s.length > 0).map(cleanSegment);
  return segs.join("/");
}

class FileObjectBody implements BucketObjectBody {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  private filePath: string;
  private offset: number;
  private length: number;

  constructor(filePath: string, offset: number, length: number) {
    this.filePath = filePath;
    this.offset = offset;
    this.length = length;
    this.size = length;
    const stream = length === 0 ? Readable.from([]) : createReadStream(filePath, { start: offset, end: offset + length - 1 });
    this.body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.length === 0) return new ArrayBuffer(0);
    const fh = await fs.open(this.filePath, "r");
    try {
      const buf = Buffer.alloc(this.length);
      await fh.read(buf, 0, this.length, this.offset);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } finally {
      await fh.close();
    }
  }
}

export class LocalBucket {
  constructor(private root: string) {}

  private resolve(key: string): string {
    const rel = storageRelPath(key);
    if (!rel) throw new Error("存储 key 不合法");
    return path.join(this.root, ...rel.split("/"));
  }

  async put(key: string, data: ArrayBuffer | Uint8Array | string, _opts?: BucketPutOptions): Promise<void> {
    const dest = this.resolve(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as ArrayBuffer);
    // 原子写：先写临时文件再改名，崩溃不留半截文件。
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);
  }

  async get(key: string, opts?: BucketGetOptions): Promise<BucketObjectBody | null> {
    const filePath = this.resolve(key);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const size = stat.size;
    let offset = 0;
    let length = size;
    if (opts?.range) {
      offset = Math.max(0, Math.min(opts.range.offset, size));
      length = Math.max(0, Math.min(opts.range.length, size - offset));
    }
    return new FileObjectBody(filePath, offset, length);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async list(opts?: { prefix?: string }): Promise<{ objects: BucketListedObject[] }> {
    const prefix = opts?.prefix ? storageRelPath(opts.prefix) : "";
    const base = prefix ? path.join(this.root, ...prefix.split("/")) : this.root;
    const objects: BucketListedObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          if (e.name.includes(".tmp-")) continue;
          const rel = path.relative(this.root, full).split(path.sep).join("/");
          const st = await fs.stat(full);
          objects.push({ key: rel, uploaded: st.mtime, size: st.size });
        }
      }
    };
    await walk(base);
    objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { objects };
  }
}
