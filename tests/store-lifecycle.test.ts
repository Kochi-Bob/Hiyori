import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  db, exportBackup, importContentPack, initialProfile, rateCard, readLibrary, restoreBackup, saveNote,
  seedBundledPack, setEntryMastered, setLessonProgress, sha256, startQuizSession,
  startSession, submitAnswer, toggleFavorite, undoRestore, updateQuizSession,
} from '../app/src/store';
import type { ContentDataset, PackManifest } from '../app/src/types';

const lessonId = 'beginner-1-lesson-21';
const bookPackId = 'book-beginner-1';
const members = [{ id: lessonId, version: '1.0.1', order: 1 }];
const source = { id: 'page', bookId: 'beginner-1', pdfPage: 1 };
const dataset: ContentDataset = {
  books: [{ id: source.bookId, title: '新标日', filename: 'course.pdf', pageCount: 3 }],
  sources: [source],
  entries: ['student', 'teacher', 'other', 'unchecked'].map(id => ({
    id, term: id, type: 'vocabulary', meaning: id, status: id === 'unchecked' ? 'learnable' : 'verified',
    examples: [], sourceIds: [source.id],
  })),
  lessons: [{
    id: lessonId, bookId: source.bookId, title: '第21课', number: 21, status: 'verified',
    entryIds: ['student', 'teacher', 'other', 'unchecked'], quizIds: ['quiz', 'pending'], sections: [],
  }],
  quizzes: ['quiz', 'pending'].map(id => ({
    id, lessonId, type: 'cloze', prompt: '学校へ（　）', answers: id === 'quiz' ? ['いきます'] : [],
    status: id === 'quiz' ? 'verified' : 'searchable', explanation: '动词', sourceIds: [source.id], entryIds: [],
  })),
  bookSections: [],
};

async function archive(data: ContentDataset, patch: Partial<PackManifest> = {}) {
  const files = { 'content.json': strToU8(JSON.stringify([data])) };
  const manifest: PackManifest = {
    id: bookPackId, title: '测试教材', version: '1.0.1', schemaVersion: 4, contentFile: 'content.json', dependencies: [], members,
    files: await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({
      path, bytes: bytes.length, sha256: await sha256(bytes),
    }))),
    ...patch,
  };
  return new Blob([new Uint8Array(zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) }))]);
}

async function changeContentFile(file: Blob, remove: boolean) {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (remove) delete files['content.json'];
  else files['content.json'][0] = 32;
  return new Blob([new Uint8Array(zipSync(files))]);
}

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); });

it('persists one FSRS rating under concurrent submission and resumes after reopening', async () => {
  await importContentPack(await archive(dataset));
  await startSession(3);
  expect((await readLibrary()).profile.session?.entryIds).toEqual(['student', 'teacher', 'other']);
  await expect(rateCard('unchecked', 3)).rejects.toThrow('尚未校对');
  const results = await Promise.allSettled([rateCard('student', 3), rateCard('student', 3)]);
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  await setEntryMastered('teacher', true);
  db.close();
  await db.open();
  const { profile } = await readLibrary();
  expect(profile.session).toMatchObject({ index: 2, completed: 1 });
  expect(profile.cards).toHaveLength(1);
  expect(profile.cards[0]).toMatchObject({ entryId: 'student', archived: false, card: { reps: 1 } });
  expect(profile.cards[0].card.due.getTime()).toBeGreaterThan(Date.now());
  expect(profile.reviews).toMatchObject([{ entryId: 'student', rating: 3, wasNew: true }]);
});

it('resumes a quiz draft and result, rejects duplicate scoring and keeps FSRS independent', async () => {
  await importContentPack(await archive(dataset));
  await expect(startQuizSession(['pending'])).rejects.toThrow('已核对题目');
  await startQuizSession(['quiz']);
  await updateQuizSession({ answer: ' ｲｷﾏｽ ' });
  db.close();
  await db.open();
  expect((await readLibrary()).profile.quizSession).toMatchObject({ answer: ' ｲｷﾏｽ ', result: null });
  expect(await submitAnswer('quiz', ' ｲｷﾏｽ ')).toBe(true);
  await expect(submitAnswer('quiz', 'いきます')).rejects.toThrow('已经提交');
  await startQuizSession(['quiz']);
  expect(await submitAnswer('quiz', 'いきません')).toBe(false);
  db.close();
  await db.open();
  const { profile } = await readLibrary();
  expect(profile.quizSession).toMatchObject({ index: 0, answer: 'いきません', result: false });
  expect(profile.answers.map(answer => answer.correct)).toEqual([true, false]);
  expect(profile.cards).toEqual([]);
  expect(profile.reviews).toEqual([]);
});

it('replaces only the previous generation during a whole-book upgrade and preserves learning records', async () => {
  await importContentPack(await archive(dataset));
  const otherPackId = 'book-supplement';
  await importContentPack(await archive(dataset, {
    id: otherPackId, members: [{ id: 'supplement', version: '1.0.1', order: 2 }],
    dependencies: [{ id: lessonId, version: '1.0.1' }],
  }));
  await setLessonProgress(lessonId, 10, true);
  await saveNote('student', '随手记');
  await toggleFavorite('student');
  const updated: Partial<PackManifest> = {
    version: '1.0.2',
    members: [{ id: lessonId, version: '1.0.2', order: 1 }],
  };
  const conflict = await archive({ ...dataset, sources: [{ ...source, pdfPage: 2 }] }, updated);
  const before = await readLibrary();
  await expect(importContentPack(conflict)).rejects.toThrow('原页 ID 冲突');
  expect(await readLibrary()).toEqual(before);

  const upgrade = await archive(dataset, updated);
  await importContentPack(upgrade);
  expect(await importContentPack(upgrade)).toContain('已安装');
  const { packs, content, profile } = await readLibrary();
  const current = packs.find(pack => pack.id === bookPackId);
  const previous = before.packs.find(pack => pack.id === bookPackId)!;
  expect(current).toMatchObject({ id: bookPackId, version: '1.0.2' });
  expect(current?.generation).not.toBe(previous.generation);
  expect(packs.find(pack => pack.id === otherPackId)).toEqual(before.packs.find(pack => pack.id === otherPackId));
  expect(await db.datasets.get(previous.generation)).toBeUndefined();
  expect(content.sources).toEqual([source]);
  expect(await db.datasets.count()).toBe(2);
  expect(profile.lessonProgress[lessonId]).toEqual({ section: 10, completed: true });
  expect(profile.notes.student).toBe('随手记');
  expect(profile.favorites).toEqual(['student']);
});

it.each([1, 2, 3])('rejects a legacy schema version %i without changing the library', async schemaVersion => {
  await importContentPack(await archive(dataset));
  const before = await readLibrary();
  const files = unzipSync(new Uint8Array(await (await archive(dataset)).arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  delete manifest.members;
  const body = strToU8(JSON.stringify(schemaVersion === 1 ? { ...dataset, bookSections: undefined } : dataset));
  files['content.json'] = body;
  files['manifest.json'] = strToU8(JSON.stringify({ ...manifest, schemaVersion, files: [
    { path: 'content.json', bytes: body.length, sha256: await sha256(body) },
  ] }));
  const legacy = new Blob([new Uint8Array(zipSync(files))]);
  await expect(importContentPack(legacy)).rejects.toThrow('不支持的内容包版本');
  expect(await readLibrary()).toEqual(before);
  expect(await db.datasets.count()).toBe(1);
});

it('requires one dataset per manifest member and a bookSections array in each dataset', async () => {
  await expect(importContentPack(await archive(dataset, { members: [...members, { id: 'other', version: '1.0.0', order: 2 }] })))
    .rejects.toThrow('书包缺少有效的内容清单');
  await expect(importContentPack(await archive({ ...dataset, bookSections: undefined })))
    .rejects.toThrow('教材栏目必须为数组');
  expect(await db.packs.count()).toBe(0);
});

it('opens a version 1 database, preserving whole books, profiles and restore snapshots', async () => {
  await db.delete();
  const old = new Dexie(db.name);
  old.version(1).stores({ packs: 'id', datasets: 'id', assets: 'id', profiles: 'id', snapshots: 'id' });
  const profile = { ...initialProfile(), notes: { student: '升级前笔记' }, lessonProgress: { [lessonId]: { section: 10, completed: true } } };
  const snapshot = { id: 'before-restore', data: initialProfile(), at: '2026-01-01T00:00:00.000Z' };
  const zip = unzipSync(new Uint8Array(await (await archive(dataset)).arrayBuffer()));
  const current = JSON.parse(strFromU8(zip['manifest.json']));
  try {
    await old.table('packs').bulkPut([
      { ...current, generation: 'whole-book', installedAt: snapshot.at },
      { id: lessonId, schemaVersion: 3, generation: 'old-lesson' },
    ]);
    await old.table('datasets').bulkPut([{ id: 'whole-book', data: [dataset] }, { id: 'old-lesson', data: dataset }]);
    await old.table('assets').put({ id: 'old-lesson/assets/page.png', blob: new Blob(['page']) });
    await old.table('profiles').put({ id: 'main', data: profile });
    await old.table('snapshots').put(snapshot);
  } finally {
    old.close();
  }
  await db.open();
  const library = await readLibrary();
  expect(library.packs.map(pack => pack.id)).toEqual([bookPackId]);
  expect(library.content.sources).toEqual([source]);
  expect(library.profile).toEqual(profile);
  expect(await db.datasets.get('old-lesson')).toBeUndefined();
  expect(await db.snapshots.get(snapshot.id)).toEqual(snapshot);
  expect(db.backendDB().objectStoreNames.contains('assets')).toBe(false);
});

it.each([false, true])('preserves the active dataset after a corrupt or missing content file (missing=%s)', async missing => {
  await importContentPack(await archive(dataset));
  await saveNote('student', '仍然存在');
  const before = await readLibrary();
  const next = await archive(dataset, { version: '1.0.2' });
  await expect(importContentPack(await changeContentFile(next, missing))).rejects.toThrow('文件损坏');
  expect(await readLibrary()).toEqual(before);
  expect(await db.datasets.count()).toBe(1);
  await importContentPack(next);
  expect((await readLibrary()).packs[0].version).toBe('1.0.2');
});

it('resumes bundled installation after a missing pack and keeps the packs already installed', async () => {
  const secondId = 'book-supplement';
  const second = await archive(dataset, {
    id: secondId, members: [{ id: 'supplement', version: '1.0.1', order: 2 }],
    dependencies: [{ id: lessonId, version: '1.0.1' }],
  });
  const first = await archive(dataset);
  await expect(importContentPack(second)).rejects.toThrow('请先导入依赖内容包');
  const targets = [bookPackId, secondId].map(id => ({ id, version: '1.0.1', file: `${id}.zip` }));
  let available = false;
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const file = url.split('/').at(-1)!;
    requests.push(file);
    if (file === 'catalog.json') return Response.json({ schemaVersion: 1, packs: targets });
    if (file === targets[0].file) return new Response(first);
    if (file === targets[1].file && available) return new Response(second);
    return new Response(null, { status: 404 });
  });
  const attempt = seedBundledPack();
  expect(seedBundledPack()).toBe(attempt);
  await expect(attempt).rejects.toThrow('内置教材包缺失');
  const [installed] = (await readLibrary()).packs;
  expect(installed.id).toBe(bookPackId);
  await saveNote('student', '安装中断时的笔记');
  db.close();
  await db.open();
  available = true;
  requests.length = 0;
  await seedBundledPack();
  expect(requests).toEqual(['catalog.json', targets[1].file]);
  const { packs, profile } = await readLibrary();
  expect(packs.map(pack => pack.id)).toEqual([bookPackId, secondId]);
  expect(packs[0].generation).toBe(installed.generation);
  expect(profile.notes.student).toBe('安装中断时的笔记');
});

it('restores a backup without its content pack, rejects a bad checksum and supports undo', async () => {
  await importContentPack(await archive(dataset));
  await toggleFavorite('student');
  await saveNote('student', '备份笔记');
  await setLessonProgress(lessonId, 3, false);
  await startSession(3, ['student']);
  await rateCard('student', 4);
  const original = (await readLibrary()).profile;
  const backup = await exportBackup();
  await db.delete();
  await db.open();
  await saveNote('teacher', '恢复前笔记');
  expect(await restoreBackup(backup)).toEqual({ missingPacks: ['测试教材'] });
  expect((await readLibrary()).profile).toEqual({
    ...original, requiredPacks: [{ id: bookPackId, version: '1.0.1', title: '测试教材' }],
  });
  const files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  files['checksum.txt'] = strToU8('0'.repeat(64));
  const restored = (await readLibrary()).profile;
  await expect(restoreBackup(new Blob([new Uint8Array(zipSync(files))]))).rejects.toThrow('备份校验失败');
  expect((await readLibrary()).profile).toEqual(restored);
  await undoRestore();
  expect((await readLibrary()).profile.notes).toEqual({ teacher: '恢复前笔记' });
});
