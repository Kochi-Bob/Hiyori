import 'fake-indexeddb/auto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  db, exportBackup, importContentPack, mergeContent, rateCard, readLibrary, restoreBackup, saveNote,
  seedBundledPack, setEntryMastered, setLessonProgress, sha256, startQuizSession,
  startSession, submitAnswer, toggleFavorite, undoRestore, updateQuizSession,
} from '../app/src/store';
import type { ContentDataset, PackManifest } from '../app/src/types';

const lessonId = 'beginner-1-lesson-21';
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

async function archive(data: ContentDataset | ContentDataset[], patch: Partial<PackManifest> = {}, extra: Record<string, Uint8Array> = {}) {
  const files = { 'content.json': strToU8(JSON.stringify(data)), ...extra };
  const manifest: PackManifest = {
    id: lessonId, title: '测试教材', version: '1.0.1', schemaVersion: 3, contentFile: 'content.json', dependencies: [],
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

it('upgrades an image-backed legacy pack to a grouped pack and migrates saved navigation once', async () => {
  const asset = 'assets/page.png';
  const legacy = await archive({ ...dataset, sources: [{ ...source, asset }] }, { schemaVersion: 2 }, { [asset]: new Uint8Array([1]) });
  await importContentPack(legacy);
  await setLessonProgress(lessonId, 10, true);
  await saveNote('student', '随手记');
  await toggleFavorite('student');
  const grouped: Partial<PackManifest> = {
    id: 'book-beginner-1', schemaVersion: 4, version: '2.0.0',
    members: [{ id: lessonId, version: '1.0.2', order: 1 }],
  };
  const conflict = await archive([{ ...dataset, sources: [{ ...source, pdfPage: 2 }] }], grouped);
  const before = await readLibrary();
  await expect(importContentPack(conflict)).rejects.toThrow('原页 ID 冲突');
  expect(await readLibrary()).toEqual(before);
  expect(await db.assets.count()).toBe(1);

  const upgrade = await archive([dataset], grouped);
  await importContentPack(upgrade);
  await importContentPack(upgrade);
  const { packs, content, profile } = await readLibrary();
  expect(packs.map(p => p.id)).toEqual(['book-beginner-1']);
  expect(content.sources).toEqual([source]);
  expect(await db.assets.count()).toBe(0);
  expect(await db.datasets.count()).toBe(1);
  expect(profile.lessonProgress[lessonId]).toEqual({ section: 9, completed: true, sectionVersion: '1.0.2' });
  expect(profile.notes.student).toBe('随手记');
  expect(profile.favorites).toEqual(['student']);
});

it('merges mixed source records and detects conflicting assets across text-only copies', () => {
  const first = { ...dataset, sources: [{ ...source, asset: 'assets/first.png' }] };
  const conflicting = { ...dataset, sources: [{ ...source, asset: 'assets/second.png' }] };
  expect(mergeContent([first, dataset]).sources).toEqual([source]);
  expect(mergeContent([dataset, first]).sources).toEqual(first.sources);
  expect(() => mergeContent([first, dataset, conflicting])).toThrow('原页 ID 冲突');
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
  const secondId = 'supplement';
  const second = await archive(dataset, { id: secondId, dependencies: [{ id: lessonId, version: '1.0.1' }] });
  const first = await archive(dataset);
  await expect(importContentPack(second)).rejects.toThrow('请先导入依赖内容包');
  const targets = [lessonId, secondId].map(id => ({ id, version: '1.0.1', file: `${id}.zip` }));
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
  expect(installed.id).toBe(lessonId);
  await saveNote('student', '安装中断时的笔记');
  db.close();
  await db.open();
  available = true;
  requests.length = 0;
  await seedBundledPack();
  expect(requests).toEqual(['catalog.json', targets[1].file]);
  const { packs, profile } = await readLibrary();
  expect(packs.map(pack => pack.id)).toEqual([lessonId, secondId]);
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
    ...original, requiredPacks: [{ id: lessonId, version: '1.0.1', title: '测试教材' }],
  });
  const files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  files['checksum.txt'] = strToU8('0'.repeat(64));
  const restored = (await readLibrary()).profile;
  await expect(restoreBackup(new Blob([new Uint8Array(zipSync(files))]))).rejects.toThrow('备份校验失败');
  expect((await readLibrary()).profile).toEqual(restored);
  await undoRestore();
  expect((await readLibrary()).profile.notes).toEqual({ teacher: '恢复前笔记' });
});
