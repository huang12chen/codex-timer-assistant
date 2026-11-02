import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, readFile, readdir, writeFile, unlink, symlink, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { AttachmentStore } from '../src/attachments.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=', 'base64');
// JPEG was generated locally with System.Drawing.Bitmap(1, 1), no external image assets.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==', 'base64');
// 1x1 lossy WebP bitstream; solid pixel data carries no third-party artwork.
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AttachmentStore(directory);
  await store.init();
  return { store, directory };
}

test('a selected image becomes an owned persistent localImage after saving and restart', async (t) => {
  const { store, directory } = await setup(t);
  const [metadata] = await store.importImages([{ name: '原图.png', data: PNG }]);
  assert.equal(metadata.mime, 'image/png');
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
  assert.match(metadata.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(metadata).sort(), ['id', 'name', 'mime', 'bytes', 'width', 'height', 'sha256'].sort());
  await assert.rejects(store.resolveForSend([metadata]));
  assert.deepEqual(await store.prepare([metadata]), [metadata]);
  const next = new AttachmentStore(directory);
  await next.init();
  assert.deepEqual(await next.prepare([metadata]), [metadata]);
  const [input] = await next.resolveForSend([metadata]);
  assert.equal(input.type, 'localImage');
  assert.ok(isAbsolute(input.path));
  assert.deepEqual(await readFile(input.path), PNG);
  assert.deepEqual(await next.readImage(metadata.id), { metadata, buffer: PNG });
});

test('real PNG/JPEG/WebP buffers and binary views are identified by bytes, independent of extension', async (t) => {
  const { store } = await setup(t);
  const imageBuffers = [PNG, JPEG, WEBP];
  const imported = await store.importImages([
    { name: 'actually-png.jpg', data: PNG },
    { name: 'actually-jpeg.webp', data: new Uint8Array(JPEG) },
    { name: 'actually-webp.png', data: new Uint8Array(WEBP).buffer },
  ]);
  assert.deepEqual(imported.map((m) => m.mime), ['image/png', 'image/jpeg', 'image/webp']);
  for (const [i, m] of imported.entries()) {
    assert.equal(m.width, 1);
    assert.equal(m.height, 1);
    assert.deepEqual((await store.readImage(m.id)).buffer, imageBuffers[i]);
  }
});

test('fake image extensions, supplied MIME/path, invalid binary types and truncated containers are rejected', async (t) => {
  const { store } = await setup(t);
  for (const input of [
    { name: 'fake.png', data: Buffer.from('<svg width="1" height="1"></svg>') },
    { name: 'fake.jpg', data: Buffer.from('GIF89a0000') },
    { name: 'safe.png', data: PNG, path: 'C:\\private.png' },
    { name: 'safe.png', data: PNG, mime: 'image/jpeg' },
    { name: 'safe.png', data: PNG.toString('base64') },
    { name: 'safe.png', data: { type: 'Buffer', data: [...PNG] } },
    { name: 'short.png', data: PNG.subarray(0, 24) },
    { name: 'short.jpg', data: JPEG.subarray(0, 200) },
    { name: 'short.webp', data: WEBP.subarray(0, 30) },
  ]) await assert.rejects(store.importImages([input]));
  const badWebp = Buffer.from(WEBP);
  badWebp.fill(0, 23, 26); // Missing positive VP8 start code (fixed in maintained fork).
  await assert.rejects(store.importImages([{ name: 'spoof.webp', data: badWebp }]));
});

test('filenames are display-only, normalized and bounded, and every import has a fresh ID', async (t) => {
  const { store } = await setup(t);
  const [a, b] = await store.importImages([
    { name: 'C:\\secret\\..\\测试\u0000\n<>:"|?*.png', data: PNG },
    { name: 'x'.repeat(500), data: PNG },
  ]);
  assert.equal(a.name, '测试.png');
  assert.equal(b.name.length, 200);
  assert.notEqual(a.id, b.id);
  assert.equal(a.sha256, b.sha256);
});

test('count, per-image bytes, cumulative bytes and dimensions are bounded before persistence', async (t) => {
  const { store, directory } = await setup(t);
  await assert.rejects(store.importImages(Array.from({ length: 9 }, () => ({ name: 'x.png', data: PNG }))), /8/);
  await assert.rejects(store.importImages([{ name: 'x.png', data: Buffer.alloc(10 * 1024 * 1024 + 1) }]), /10MiB/);
  await assert.rejects(store.importImages(Array.from({ length: 4 }, () => ({ name: 'x.png', data: Buffer.alloc(9 * 1024 * 1024) }))), /32MiB/);
  for (const [width, height] of [[0, 1], [16385, 1], [1, 16385], [4097, 4096]]) {
    const giant = Buffer.from(PNG);
    giant.writeUInt32BE(width, 16);
    giant.writeUInt32BE(height, 20);
    await assert.rejects(store.importImages([{ name: 'huge.png', data: giant }]));
  }
  assert.deepEqual(await readdir(join(directory, '.drafts')), []);
  assert.equal((await store.importImages(Array.from({ length: 8 }, () => ({ name: 'x.png', data: PNG })))).length, 8);
});

test('client metadata, duplicate IDs, traversal IDs and arbitrary path fields cannot authorize images', async (t) => {
  const { store } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  for (const replacement of [{ name: 'changed.png' }, { mime: 'image/jpeg' }, { bytes: 1 }, { width: 2 }, { height: 2 }, { sha256: 'a'.repeat(64) }, { path: 'C:\\private.png' }, { id: '../private' }, { id: m.id.toUpperCase() }]) {
    await assert.rejects(store.prepare([{ ...m, ...replacement }]));
  }
  await assert.rejects(store.prepare([m, m]));
  await assert.rejects(store.readImage('../private'));
  await assert.rejects(store.discardDrafts(['../private']));
  assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  await store.prepare([m]);
  await assert.rejects(store.resolveForSend([{ ...m, path: 'C:\\private.png' }]));
  await assert.rejects(store.resolveForSend([{ ...m, sha256: '0'.repeat(64) }]));
});

test('failed batch import removes only the new batch and retains older drafts and saved images', async (t) => {
  const { store, directory } = await setup(t);
  const [saved] = await store.importImages([{ name: 'saved.png', data: PNG }]);
  await store.prepare([saved]);
  const [draft] = await store.importImages([{ name: 'draft.png', data: PNG }]);
  const before = (await readdir(join(directory, '.drafts'))).sort();
  await assert.rejects(store.importImages([{ name: 'new.png', data: PNG }, { name: 'invalid.png', data: Buffer.from('bad') }]));
  assert.deepEqual((await readdir(join(directory, '.drafts'))).sort(), before);
  assert.deepEqual((await store.readImage(draft.id)).buffer, PNG);
  assert.equal((await store.resolveForSend([saved])).length, 1);
});

test('publication errors during prepare preserve all original drafts and roll back only new committed files', async (t) => {
  const { store, directory } = await setup(t);
  const metadata = await store.importImages([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }]);
  const original = fs.promises.link;
  let calls = 0;
  fs.promises.link = async (...args) => {
    if (++calls === 3) throw new Error('injected publication failure');
    return original(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(store.prepare(metadata), /publication failure/); }
  finally { fs.promises.link = original; syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(join(directory, 'images')), []);
  for (const m of metadata) assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  assert.deepEqual(await store.prepare(metadata), metadata);
});

test('post-commit draft cleanup failure returns successful prepared images, reports a warning, and remains retryable', async (t) => {
  const { store, directory } = await setup(t);
  const metadata = await store.importImages([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }]);
  const blocked = join(directory, '.drafts', `${metadata[0].id}.json`);
  const original = fs.promises.unlink;
  fs.promises.unlink = async (path, ...rest) => {
    if (path === blocked) throw Object.assign(new Error('injected cleanup lock'), { code: 'EPERM' });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    // Publication has already committed: cleanup cannot report a failed prepare.
    assert.deepEqual(await store.prepare(metadata), metadata);
    assert.equal((await store.resolveForSend(metadata)).length, 2);
    const warnings = store.drainWarnings();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, 'attachment-draft-cleanup-failed');
    assert.equal(warnings[0].id, metadata[0].id);
    assert.equal(warnings[0].code, 'EPERM');
    assert.deepEqual(store.drainWarnings(), []);
    assert.deepEqual(await readdir(join(directory, '.drafts')), [`${metadata[0].id}.json`]);
    for (const m of metadata) assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  } finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
  await store.clearDrafts();
  assert.deepEqual(await readdir(join(directory, '.drafts')), []);
  assert.equal((await store.resolveForSend(metadata)).length, 2);
  const next = new AttachmentStore(directory);
  await next.init();
  assert.equal((await next.resolveForSend(metadata)).length, 2);
});

test('changed bytes and sidecars are rejected before preview, prepare, and send', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const original = await readFile(join(directory, '.drafts', `${m.id}.png`));
  const corrupt = Buffer.from(original);
  corrupt[40] ^= 1;
  await writeFile(join(directory, '.drafts', `${m.id}.png`), corrupt);
  await assert.rejects(store.readImage(m.id));
  await assert.rejects(store.prepare([m]));
  await writeFile(join(directory, '.drafts', `${m.id}.png`), original);
  await writeFile(join(directory, '.drafts', `${m.id}.json`), JSON.stringify({ ...m, name: 'tampered.png' }));
  await assert.rejects(store.prepare([m]));
  await writeFile(join(directory, '.drafts', `${m.id}.json`), JSON.stringify(m));
  await store.prepare([m]);
  await writeFile(join(directory, 'images', `${m.id}.png`), corrupt);
  await assert.rejects(store.resolveForSend([m]));
  const next = new AttachmentStore(directory);
  await next.init();
  await assert.rejects(next.resolveForSend([m]));
});

test('discard, exit cleanup, and startup cleanup keep committed data for queued Codex history', async (t) => {
  const { store, directory } = await setup(t);
  const [saved, discarded, exitDraft] = await store.importImages([
    { name: 'saved.png', data: PNG }, { name: 'remove.png', data: PNG }, { name: 'exit.png', data: PNG },
  ]);
  await store.prepare([saved]);
  await store.discardDrafts([saved.id, discarded.id]);
  await assert.rejects(store.readImage(discarded.id));
  assert.deepEqual((await store.readImage(exitDraft.id)).buffer, PNG);
  await store.clearDrafts();
  await assert.rejects(store.readImage(exitDraft.id));
  const [old] = await store.importImages([{ name: 'restart.png', data: PNG }]);
  await writeFile(join(directory, '.drafts', 'unrelated.txt'), 'leave this alone');
  await mkdir(join(directory, '.drafts', `${old.id}.png-folder`));
  const next = new AttachmentStore(directory);
  await next.init();
  await assert.rejects(next.readImage(old.id));
  assert.equal((await next.resolveForSend([saved])).length, 1);
  assert.equal(await readFile(join(directory, '.drafts', 'unrelated.txt'), 'utf8'), 'leave this alone');
});

test('concurrent imports, prepare and draft clearing serialize without aliasing saved images', async (t) => {
  const { store } = await setup(t);
  const imports = await Promise.all(Array.from({ length: 4 }, () => store.importImages([{ name: 'same.png', data: PNG }])));
  const metadata = imports.flat();
  assert.equal(new Set(metadata.map((m) => m.id)).size, 4);
  await Promise.all([store.prepare([metadata[0]]), store.clearDrafts()]);
  assert.equal((await store.resolveForSend([metadata[0]])).length, 1);
  for (const m of metadata.slice(1)) await assert.rejects(store.readImage(m.id));
});

test('symlinked image or metadata never authorizes an outside file and cleanup leaves targets intact', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  await store.prepare([m]);
  const outside = join(directory, 'outside.png');
  await writeFile(outside, PNG);
  const imagePath = join(directory, 'images', `${m.id}.png`);
  await unlink(imagePath);
  try { await symlink(outside, imagePath, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('file symlinks require privileges on this Windows host');
    throw error;
  }
  await assert.rejects(store.resolveForSend([m]));
  await store.clearDrafts();
  assert.deepEqual(await readFile(outside), PNG);
  const next = new AttachmentStore(directory);
  await next.init();
  await assert.rejects(next.readImage(m.id));
});

test('extended WebP/APNG canvas dimensions cannot conceal an oversized embedded frame', async (t) => {
  const { store } = await setup(t);
  const header = Buffer.alloc(18);
  header.write('VP8X');
  header.writeUInt32LE(10, 4); // Extended header with a 1x1 canvas.
  const hugeFrame = Buffer.from(WEBP.subarray(12));
  hugeFrame.writeUInt16LE(16383, 14);
  hugeFrame.writeUInt16LE(16383, 16);
  const extended = Buffer.concat([WEBP.subarray(0, 12), header, hugeFrame]);
  extended.writeUInt32LE(extended.length - 8, 4);
  await assert.rejects(store.importImages([{ name: 'hidden-huge.webp', data: extended }]));

  const frameControl = Buffer.alloc(38);
  frameControl.writeUInt32BE(26, 0);
  frameControl.write('fcTL', 4);
  frameControl.writeUInt32BE(16384, 12);
  frameControl.writeUInt32BE(16384, 16);
  const animated = Buffer.concat([PNG.subarray(0, 33), frameControl, PNG.subarray(33)]);
  await assert.rejects(store.importImages([{ name: 'hidden-huge.png', data: animated }]));
});

test('replacement of the persistent directory by a Windows junction is rejected', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  await store.prepare([m]);
  const elsewhere = join(directory, 'outside-images');
  await rename(join(directory, 'images'), elsewhere);
  try { await symlink(elsewhere, join(directory, 'images'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory symlinks unavailable');
    throw error;
  }
  await assert.rejects(store.resolveForSend([m]));
  const next = new AttachmentStore(directory);
  await assert.rejects(next.init());
  assert.deepEqual(await readFile(join(elsewhere, `${m.id}.png`)), PNG);
});

test('replacing a saved file with another file containing identical bytes is rejected in the live store', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  await store.prepare([m]);
  const image = join(directory, 'images', `${m.id}.png`);
  await rename(image, join(directory, 'original-held.png'));
  await writeFile(image, PNG);
  await assert.rejects(store.resolveForSend([m]), /替换/);
});

test('draft cleanup refuses a regular file substituted at a known draft path', async (t) => {
  const { store, directory } = await setup(t);
  const [m, other] = await store.importImages([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }]);
  const path = join(directory, '.drafts', `${m.id}.png`);
  const held = join(directory, 'original-draft-held.png');
  await rename(path, held);
  await writeFile(path, 'unrelated file must survive');
  await assert.rejects(store.clearDrafts());
  assert.equal(await readFile(path, 'utf8'), 'unrelated file must survive');
  assert.deepEqual(await readFile(held), PNG);
  await assert.rejects(store.readImage(other.id));
});

test('a staging file swap during publication rejects prepare and preserves both the real draft and unrelated replacement', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const originalLink = fs.promises.link;
  let substitutedPath;
  fs.promises.link = async (source, target) => {
    if (!substitutedPath && target === join(directory, 'images', `${m.id}.png`)) {
      substitutedPath = source;
      await rename(source, join(directory, 'original-staging-held.png'));
      await writeFile(source, 'unrelated publication replacement');
    }
    return originalLink(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(store.prepare([m])); }
  finally { fs.promises.link = originalLink; syncBuiltinESMExports(); }
  assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  assert.equal(await readFile(substitutedPath, 'utf8'), 'unrelated publication replacement');
  await assert.rejects(store.resolveForSend([m]));
});

test('a staging file changed in place during publication rolls back persistent copies and retains the original draft', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const originalLink = fs.promises.link;
  let injected = false;
  fs.promises.link = async (source, target) => {
    if (!injected && target === join(directory, 'images', `${m.id}.png`)) {
      injected = true;
      await writeFile(source, Buffer.alloc(PNG.length, 0));
    }
    return originalLink(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(store.prepare([m])); }
  finally { fs.promises.link = originalLink; syncBuiltinESMExports(); }
  assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  assert.deepEqual(await readdir(join(directory, 'images')), []);
  assert.deepEqual(await store.prepare([m]), [m]);
});

test('the whole published batch is revalidated before committing and deleting original drafts', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const originalLink = fs.promises.link;
  fs.promises.link = async (source, target) => {
    if (target === join(directory, 'images', `${m.id}.json`)) {
      const modified = Buffer.from(PNG);
      modified[40] ^= 1;
      await writeFile(join(directory, 'images', `${m.id}.png`), modified);
    }
    return originalLink(source, target);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(store.prepare([m])); }
  finally { fs.promises.link = originalLink; syncBuiltinESMExports(); }
  assert.deepEqual((await store.readImage(m.id)).buffer, PNG);
  assert.deepEqual(await readdir(join(directory, 'images')), []);
});

test('oversized sidecars and image growth are rejected using bounded reads', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const meta = join(directory, '.drafts', `${m.id}.json`);
  await writeFile(meta, ' '.repeat(4097));
  await assert.rejects(store.readImage(m.id));
  await writeFile(meta, JSON.stringify(m));
  const image = join(directory, '.drafts', `${m.id}.png`);
  await writeFile(image, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(store.readImage(m.id));
});

test('startup cleanup removes only ordinary UUID-owned private drafts, without following junctions', async (t) => {
  const { store, directory } = await setup(t);
  const [m] = await store.importImages([{ name: 'x.png', data: PNG }]);
  const outside = join(directory, 'unrelated-data');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'private');
  try { await symlink(outside, join(directory, '.drafts', `${m.id}.webp`), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory symlinks unavailable');
    throw error;
  }
  const next = new AttachmentStore(directory);
  await next.init();
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'private');
  assert.deepEqual(await readdir(join(directory, '.drafts')), [`${m.id}.webp`]);
});
