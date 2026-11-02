import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, readdir, unlink, link } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { imageSize } from '@carboneio/image-size';

const MAX_IMAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = ['id', 'name', 'mime', 'bytes', 'width', 'height', 'sha256'];
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const identity = (s) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const revision = (s) => `${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const fail = (message) => { throw new Error(message); };

function checkId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) fail('图片 ID 无效');
  return id;
}

function safeName(name) {
  if (typeof name !== 'string') fail('图片文件名无效');
  return basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '').trim().slice(0, 200) || '图片';
}

function checkMetadata(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.keys(m).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(m, key))) fail('图片 metadata 字段无效');
  checkId(m.id);
  if (safeName(m.name) !== m.name || !Object.hasOwn(EXTENSIONS, m.mime)
    || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_BYTES
    || !Number.isInteger(m.width) || !Number.isInteger(m.height)
    || m.width < 1 || m.height < 1 || m.width > 16384 || m.height > 16384 || m.width * m.height > 16777216
    || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) fail('图片 metadata 无效或超出限制');
  return Object.fromEntries(FIELDS.map((key) => [key, m[key]]));
}

function checkBatch(items) {
  if (!Array.isArray(items) || items.length > MAX_IMAGES) fail('每个任务最多8张图片');
}

// Structural checks supplement the library's header dimensions without decoding pixels.
// The caller subsequently checks nativeImage decoding before showing/saving a preview.
function frameFits(width, height, x, y, canvas) {
  if (width < 1 || height < 1 || x + width > canvas.width || y + height > canvas.height) fail('图片帧超出已验证的画布尺寸');
}

function checkWebpChunks(buffer, start, end, canvas, nested = false) {
  let offset = start;
  let hasData = false;
  while (offset + 8 <= end) {
    const length = buffer.readUInt32LE(offset + 4);
    const type = buffer.toString('ascii', offset, offset + 4);
    const next = offset + 8 + length + (length % 2);
    if (next > end) fail('WebP 数据不完整');
    if (type === 'VP8 ' || type === 'VP8L') {
      if (length < (type === 'VP8 ' ? 10 : 5)) fail('WebP 帧数据不完整');
      // Parse only the elementary frame header; never allocate/decode its pixels.
      const probe = Buffer.alloc(30);
      buffer.copy(probe, 0, 0, 12);
      buffer.copy(probe, 12, offset, Math.min(offset + 18, offset + 8 + length));
      let frame;
      try { frame = imageSize(probe); } catch { fail('WebP 帧签名无效'); }
      frameFits(frame.width, frame.height, 0, 0, canvas);
      hasData = true;
    } else if (type === 'ANMF') {
      if (nested || length < 16) fail('WebP 动画帧数据无效');
      const x = buffer.readUIntLE(offset + 8, 3) * 2;
      const y = buffer.readUIntLE(offset + 11, 3) * 2;
      const width = buffer.readUIntLE(offset + 14, 3) + 1;
      const height = buffer.readUIntLE(offset + 17, 3) + 1;
      frameFits(width, height, x, y, canvas);
      checkWebpChunks(buffer, offset + 24, offset + 8 + length, { width, height }, true);
      hasData = true;
    } else if (type === 'VP8X' && (nested || offset !== 12 || length !== 10)) fail('WebP 扩展头无效');
    offset = next;
  }
  if (!hasData || offset !== end) fail('WebP 数据不完整');
}

function checkContainer(buffer, mime, canvas) {
  if (mime === 'image/png') {
    let offset = 8;
    let hasData = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (end > buffer.length || (offset === 8 && (type !== 'IHDR' || length !== 13))) fail('PNG 数据不完整');
      if (offset !== 8 && type === 'IHDR') fail('PNG 重复画布头');
      if (type === 'fcTL') {
        if (length !== 26) fail('PNG 动画帧头无效');
        frameFits(buffer.readUInt32BE(offset + 12), buffer.readUInt32BE(offset + 16), buffer.readUInt32BE(offset + 20), buffer.readUInt32BE(offset + 24), canvas);
      }
      if (type === 'IDAT' && length) hasData = true;
      if (type === 'IEND') {
        if (length || !hasData || end !== buffer.length) fail('PNG 数据不完整');
        return;
      }
      offset = end;
    }
    fail('PNG 数据不完整');
  }
  if (mime === 'image/jpeg') {
    if (buffer.length < 4 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) fail('JPEG 数据不完整');
    return;
  }
  if (buffer.length < 20 || buffer.readUInt32LE(4) !== buffer.length - 8) fail('WebP 数据不完整');
  checkWebpChunks(buffer, 12, buffer.length, canvas);
}

function describe(buffer, id, name) {
  if (!buffer.length || buffer.length > MAX_BYTES) fail('每张图片不得超过10MiB');
  let mime;
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) mime = 'image/jpeg';
  else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else fail('仅支持实际格式为 PNG、JPEG、WebP 的图片');
  let size;
  try { size = imageSize(buffer); } catch { fail('图片格式或尺寸无效'); }
  if (size.type !== ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime]) fail('图片签名与格式不符');
  const metadata = checkMetadata({ id, name, mime, bytes: buffer.length, width: size.width, height: size.height, sha256: sha256(buffer) });
  checkContainer(buffer, mime, metadata);
  return metadata;
}

function matches(a, b) { return FIELDS.every((key) => a[key] === b[key]); }

async function readBounded(handle, size) {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== size) fail('图片文件读取时大小已变化');
  return buffer.subarray(0, offset);
}

/** Owns copied image data only. Committed files are retained for Codex queue/history references. */
export class AttachmentStore {
  #pending = Promise.resolve();
  #ready = false;
  #directories = new Map();
  #drafts = new Map();
  #retiredDrafts = new Map();
  #warnings = [];
  #identities = new Map();

  constructor(directory) { this.directory = resolve(directory); }

  #serialize(operation) {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => {});
    return result;
  }

  init() {
    return this.#serialize(async () => {
      if (this.#ready) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) fail('图片存储目录不能是链接');
      this.directory = await realpath(this.directory);
      for (const directory of [this.directory, join(this.directory, 'images'), join(this.directory, '.drafts')]) {
        await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) fail('图片存储目录不安全');
        this.#directories.set(directory, identity(stat));
      }
      // Only remove clearly named, ordinary files in our own draft directory. Never recurse.
      const draftDirectory = join(this.directory, '.drafts');
      for (const entry of await readdir(draftDirectory, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f-]{36}\.(png|jpg|webp|json|[0-9a-f-]{36}\.tmp)$/.test(entry.name)
          && UUID.test(entry.name.slice(0, 36))) await this.#remove(join(draftDirectory, entry.name));
      }
      this.#ready = true;
    });
  }

  async #guard() {
    for (const [directory, expected] of this.#directories) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected || await realpath(directory) !== directory) fail('图片存储目录已被替换或重定向');
    }
  }

  #paths(id, mime, draft) {
    checkId(id);
    const directory = join(this.directory, draft ? '.drafts' : 'images');
    return { image: join(directory, `${id}.${EXTENSIONS[mime]}`), meta: join(directory, `${id}.json`) };
  }

  async #read(path, limit) {
    await this.#guard();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > limit
      || await realpath(path) !== path) fail('图片文件不安全或超出限制');
    const previous = this.#identities.get(path);
    if (previous && previous !== identity(before)) fail('图片文件已被替换');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (revision(opened) !== revision(before)) fail('图片文件读取时已变化');
      const buffer = await readBounded(handle, before.size);
      if (revision(await handle.stat()) !== revision(before)
        || revision(await lstat(path)) !== revision(before) || await realpath(path) !== path) fail('图片文件读取时已变化');
      await this.#guard();
      this.#identities.set(path, identity(before));
      return buffer;
    } finally { await handle.close(); }
  }

  async #remove(path) {
    await this.#guard();
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path) fail('拒绝清理非自有普通图片文件');
      const expected = this.#identities.get(path);
      if (expected && identity(stat) !== expected) fail('拒绝清理身份已改变的图片文件');
      await unlink(path);
      this.#identities.delete(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async #write(path, buffer, created) {
    await this.#guard();
    const temporary = join(resolve(path, '..'), `${basename(path).slice(0, 36)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx+', 0o600);
    const expected = identity(await handle.stat());
    this.#identities.set(temporary, expected);
    created.push(temporary);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
      await this.#verifyWritten(handle, [temporary], buffer, expected);
      // Keep the original handle open and verify both names after atomic
      // publication: a pathname may have been substituted during link().
      await link(temporary, path);
      created.push(path);
      this.#identities.set(path, expected);
      await this.#verifyWritten(handle, [temporary, path], buffer, expected);
      await this.#remove(temporary);
      await this.#verifyWritten(handle, [path], buffer, expected);
    } finally { await handle.close(); }
  }

  async #verifyWritten(handle, paths, buffer, expected) {
    await this.#guard();
    const before = await handle.stat();
    if (!before.isFile() || identity(before) !== expected || before.size !== buffer.length || before.nlink !== paths.length) fail('图片暂存文件身份或大小已改变');
    for (const path of paths) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || revision(stat) !== revision(before)
        || await realpath(path) !== path) fail('图片暂存或发布文件已被替换');
    }
    if (sha256(await readBounded(handle, buffer.length)) !== sha256(buffer)
      || revision(await handle.stat()) !== revision(before)) fail('图片暂存内容在发布时已改变');
    for (const path of paths) {
      if (revision(await lstat(path)) !== revision(before) || await realpath(path) !== path) fail('图片发布文件校验时已改变');
    }
    await this.#guard();
  }

  async #cleanup(paths) {
    const failures = [];
    for (const path of paths) { try { await this.#remove(path); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, '部分图片草稿未能清理');
  }

  importImages(images) {
    return this.#serialize(async () => {
      if (!this.#ready) fail('图片存储尚未初始化');
      checkBatch(images);
      let total = 0;
      const inputs = images.map((image) => {
        if (!image || typeof image !== 'object' || Array.isArray(image)
          || Object.keys(image).length !== 2 || !Object.hasOwn(image, 'name') || !Object.hasOwn(image, 'data')
          || !(image.data instanceof Uint8Array || image.data instanceof ArrayBuffer)) fail('图片导入参数无效');
        if (!image.data.byteLength || image.data.byteLength > MAX_BYTES) fail('每张图片不得超过10MiB');
        total += image.data.byteLength;
        if (total > MAX_TOTAL) fail('图片合计不得超过32MiB');
        return image;
      });
      const created = [];
      const records = [];
      try {
        for (const { name, data } of inputs) {
          const buffer = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          const metadata = describe(buffer, randomUUID(), safeName(name));
          const paths = this.#paths(metadata.id, metadata.mime, true);
          await this.#write(paths.image, buffer, created);
          await this.#write(paths.meta, Buffer.from(JSON.stringify(metadata)), created);
          records.push(metadata);
        }
      } catch (error) {
        try { await this.#cleanup(created.reverse()); } catch (cleanupError) { throw new AggregateError([error, cleanupError], '图片导入及回滚失败'); }
        throw error;
      }
      for (const metadata of records) this.#drafts.set(metadata.id, metadata);
      return records.map((m) => ({ ...m }));
    });
  }

  async #load(id, committedOnly = false) {
    checkId(id);
    const draft = !committedOnly && this.#drafts.has(id);
    const directory = join(this.directory, draft ? '.drafts' : 'images');
    const metadata = checkMetadata(JSON.parse((await this.#read(join(directory, `${id}.json`), 4096)).toString('utf8')));
    if (metadata.id !== id || (draft && !matches(metadata, this.#drafts.get(id)))) fail('图片 metadata 已改变');
    const paths = this.#paths(id, metadata.mime, draft);
    const buffer = await this.#read(paths.image, MAX_BYTES);
    const verified = describe(buffer, id, metadata.name);
    if (!matches(verified, metadata)) fail('图片内容与 metadata 不符');
    return { metadata: verified, buffer, path: paths.image, draft };
  }

  async #verifyBatch(items, committedOnly = false) {
    if (!this.#ready) fail('图片存储尚未初始化');
    checkBatch(items);
    const canonical = items.map(checkMetadata);
    if (new Set(canonical.map((m) => m.id)).size !== canonical.length) fail('图片 ID 不能重复');
    if (canonical.reduce((sum, m) => sum + m.bytes, 0) > MAX_TOTAL) fail('图片合计不得超过32MiB');
    const records = [];
    for (const client of canonical) {
      const record = await this.#load(client.id, committedOnly);
      if (!matches(client, record.metadata)) fail('客户端图片 metadata 与存储副本不符');
      records.push(record);
    }
    return records;
  }

  prepare(items) {
    return this.#serialize(async () => {
      const records = await this.#verifyBatch(items);
      const created = [];
      try {
        for (const { metadata, buffer, draft } of records) {
          if (!draft) continue;
          const paths = this.#paths(metadata.id, metadata.mime, false);
          await this.#write(paths.image, buffer, created);
          await this.#write(paths.meta, Buffer.from(JSON.stringify(metadata)), created);
        }
        // Earlier files may change while later files are being published.
        // Validate the complete durable batch before its logical commit point.
        await this.#verifyBatch(records.map(({ metadata }) => metadata), true);
      } catch (error) {
        try { await this.#cleanup(created.reverse()); } catch (cleanupError) { throw new AggregateError([error, cleanupError], '图片保存及回滚失败，原草稿保留'); }
        throw error;
      }
      // Commit point: every image and sidecar is durable. Once published, a
      // redundant staging cleanup error must never report a failed prepare.
      for (const { metadata, draft } of records) {
        if (!draft) continue;
        this.#drafts.delete(metadata.id);
        this.#retiredDrafts.set(metadata.id, metadata);
      }
      for (const { metadata, draft } of records) {
        if (!draft) continue;
        try { await this.#discardPrivateDraft(metadata.id); }
        catch (error) {
          this.#warnings.push({
            event: 'attachment-draft-cleanup-failed', id: metadata.id,
            code: String(error.errors?.[0]?.code || error.code || 'CLEANUP_FAILED').slice(0, 80),
            message: '图片已保存，部分临时副本暂时无法清理，将在移除、退出或下次启动时重试。',
          });
          if (this.#warnings.length > 20) this.#warnings.shift();
        }
      }
      return records.map(({ metadata }) => ({ ...metadata }));
    });
  }

  readImage(id) {
    return this.#serialize(async () => {
      if (!this.#ready) fail('图片存储尚未初始化');
      const { metadata, buffer } = await this.#load(id);
      return { metadata, buffer };
    });
  }

  resolveForSend(items) {
    return this.#serialize(async () => (await this.#verifyBatch(items, true)).map(({ path }) => ({ type: 'localImage', path })));
  }

  /** Main may drain these bounded, nonfatal cleanup warnings into its log. */
  drainWarnings() { return this.#warnings.splice(0); }

  async #discardPrivateDraft(id) {
    const metadata = this.#drafts.get(id) || this.#retiredDrafts.get(id);
    if (!metadata) return;
    const paths = this.#paths(id, metadata.mime, true);
    await this.#cleanup([paths.image, paths.meta]);
    this.#drafts.delete(id);
    this.#retiredDrafts.delete(id);
  }

  async #discardPrivateDrafts(ids) {
    const failures = [];
    for (const id of ids) {
      try { await this.#discardPrivateDraft(id); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '部分图片临时副本仍待清理');
  }

  discardDrafts(ids) {
    return this.#serialize(async () => {
      if (!Array.isArray(ids) || ids.length > MAX_IMAGES) fail('图片 ID 列表无效');
      ids.forEach(checkId);
      await this.#discardPrivateDrafts(ids);
    });
  }

  clearDrafts() {
    return this.#serialize(async () => {
      await this.#discardPrivateDrafts([...this.#drafts.keys(), ...this.#retiredDrafts.keys()]);
    });
  }
}
