import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, importContentPack, mergeContent, orderedDatasets, readLibrary, saveNote, toggleFavorite } from '../app/src/store';

const packDir = path.resolve(__dirname, '../app/public/packs');
const catalog = JSON.parse(await readFile(path.join(packDir, 'catalog.json'), 'utf8')) as { packs: { id: string; version: string; file: string }[] };
const importPack = async (target: { id: string; version: string; file: string }) =>
  importContentPack(new Blob([await readFile(path.join(packDir, target.file))]), target);

async function freshMerge() {
  const packs = (await db.packs.toArray()).sort((a, b) => a.installedAt.localeCompare(b.installedAt));
  return mergeContent(orderedDatasets(packs, await db.datasets.bulkGet(packs.map(p => p.generation))));
}

describe('readLibrary content cache', () => {
  beforeAll(async () => { await db.delete(); await db.open(); });

  it('reuses merged content across profile writes and rebuilds it after imports', async () => {
    const [first, second, ...rest] = catalog.packs;
    await importPack(first);
    const afterFirst = await readLibrary();
    expect(afterFirst.content.entries.length).toBeGreaterThan(0);

    await importPack(second);
    const afterSecond = await readLibrary();
    expect(afterSecond.content).not.toBe(afterFirst.content);
    expect(afterSecond.packs.map(p => p.id)).toEqual([first.id, second.id]);

    for (const target of rest) await importPack(target);
    const t0 = performance.now();
    const full = await readLibrary();
    const missMs = performance.now() - t0;
    expect(full.packs.map(p => p.id)).toEqual(catalog.packs.map(p => p.id));
    expect(JSON.stringify(full.content)).toBe(JSON.stringify(await freshMerge()));

    const entryId = full.content.entries[0].id;
    await toggleFavorite(entryId);
    await saveNote(entryId, '缓存测试');
    const t1 = performance.now();
    const afterEdits = await readLibrary();
    const hitMs = performance.now() - t1;
    expect(afterEdits.content).toBe(full.content);
    expect(afterEdits.profile.favorites).toContain(entryId);
    expect(afterEdits.profile.notes[entryId]).toBe('缓存测试');

    // Re-importing an installed version is a no-op and must not invalidate the cache.
    expect(await importPack(first)).toContain('已安装');
    expect((await readLibrary()).content).toBe(full.content);

    console.log(`readLibrary with ${catalog.packs.length} book packs: cold merge ${missMs.toFixed(1)} ms, cached ${hitMs.toFixed(1)} ms`);
  }, 180_000);
});
