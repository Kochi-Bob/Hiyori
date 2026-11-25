import Dexie, { type Table } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { createEmptyCard, fsrs, type Grade } from 'ts-fsrs';
import type { ContentDataset, Entry, InstalledPack, PackManifest, Profile, Source } from './types';
import { buildStudyPlan } from './study-plan';
import { memberOrder } from '../../content/book-packs.json';

const emptyContent = (): ContentDataset => ({ books: [], entries: [], lessons: [], sources: [], quizzes: [], bookSections: [] });
// OCR source archives live under app/public/packs-waiting and are not learning packs.
// Hide any copies left in IndexedDB from older installs or manual imports.
const isWaitingPack = (id: string) => id.startsWith('txt-corpus-');
const memberRanks = new Map(memberOrder.map((id, index) => [id, index]));
type DatasetRow = { id: string; data: ContentDataset | ContentDataset[] };
export const initialProfile = (): Profile => ({
  settings: { dailyNewLimit: 10, defaultMinutes: 5, targetLevel: 'N4', furigana: true },
  favorites: [], notes: {}, lessonProgress: {}, cards: [], reviews: [], answers: [], session: null, masteredEntryIds: [], quizSession: null, requiredPacks: [],
});

class LibraryDB extends Dexie {
  packs!: Table<InstalledPack, string>;
  datasets!: Table<DatasetRow, string>;
  assets!: Table<{ id: string; blob: Blob }, string>;
  profiles!: Table<{ id: string; data: Profile }, string>;
  snapshots!: Table<{ id: string; data: Profile; at: string }, string>;
  constructor(name = 'hiyori-local-v1') {
    super(name);
    this.version(1).stores({ packs: 'id', datasets: 'id', assets: 'id', profiles: 'id', snapshots: 'id' });
  }
}
export const db = new LibraryDB();
const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false });
const statuses = ['searchable', 'learnable', 'verified'];
const sectionKinds = ['text', 'vocabulary', 'grammar', 'exercise', 'answers', 'notes'];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonempty);
const safePath = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.startsWith('/') && !p.includes(':') && p.split('/').every(x => x !== '..' && x !== '.' && x !== '');
export function normalizeSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, '');
}
function hydrateProfile(profile: Profile): Profile {
  // Same-sense duplicates share one stable ID across lessons and reference books.
  // Keep historical cards archived; notes and explicit user choices follow the shared ID.
  const aliases: Record<string, string> = {
    'vocab-b1-l04-019': 'vocab-kyodai',
    'vocab-b1-l04-020': 'vocab-ryoshin',
    'vocab-b1-l04-021': 'vocab-imoto',
    'grammar-blue-n5-092': 'red-n5-vocab-50b399899146',
    'grammar-blue-n5-040': 'red-n5-vocab-df69db4e7a90',
    'vocab-blue-n5-greeting-23': 'red-n5-vocab-b3a01ad2df25',
    'grammar-blue-n5-110-u1': 'red-n5-vocab-e5cb1ea93b6d',
    'grammar-blue-n5-088-u2': 'red-n5-vocab-80c03ca8ef4a',
    'grammar-blue-n5-087-u1': 'red-n5-vocab-3a1899d1f7eb',
    'grammar-blue-n5-026-u1': 'red-n5-vocab-c2d9997fb3d9',
    'grammar-blue-n5-026-u2': 'red-n5-vocab-92c2b80e187e',
    'grammar-blue-n5-063': 'red-n5-vocab-c38dc5a83a97',
    'grammar-blue-n5-85-にん': 'red-n5-vocab-076fa7e6f345',
    'grammar-blue-n5-074': 'red-n5-vocab-83f7fd4cfcf5',
    'grammar-blue-n5-104': 'red-n5-vocab-071969e5463c',
    'grammar-blue-n5-094': 'red-n5-vocab-e10566a52915',
    'grammar-blue-n5-113': 'red-n5-vocab-b88e5ca19acf',
    'grammar-blue-n5-082-1': 'red-n5-vocab-c1fdb2ca1817',
    'grammar-blue-n5-117': 'red-n5-vocab-12c6e3f71e8b',
    'grammar-blue-n5-025': 'red-n5-vocab-f8b41840d34e',
    'grammar-blue-n5-076': 'red-n4-vocab-ba10709a10d9',
    'grammar-blue-n5-071': 'red-n5-vocab-e75017b2855b',
    'grammar-blue-n5-072': 'red-n4-vocab-831e169abd74',
    'grammar-blue-n5-096': 'red-n4-vocab-2d7eed5945ed',
    'grammar-blue-n5-067': 'red-n5-vocab-bd87ccb9f3ea',
    'vocab-blue-n5-greeting-28': 'red-n4-vocab-b3e280af965d',
    'grammar-blue-n5-061': 'red-n5-vocab-a3c4b25e85bb',
    'grammar-blue-n4-031-u1': 'red-n4-vocab-4b50f151eac6',
    'red-n4-vocab-3d206ac4af88': 'red-n5-vocab-2e2898ac6d6b',
    'red-n4-vocab-2d1c4f6143c9': 'red-n4-vocab-d3665e159799',
    'grammar-blue-n4-112': 'red-n4-vocab-3947becb39e9',
    'grammar-blue-n4-088': 'red-n4-vocab-4e9002a579ca',
  };
  const notes = { ...profile.notes };
  for (const [from, to] of Object.entries(aliases)) {
    if (notes[from]) notes[to] = notes[to] && notes[to] !== notes[from] ? `${notes[to]}\n\n${notes[from]}` : notes[from];
    delete notes[from];
  }
  const remap = (ids: string[]) => [...new Set(ids.map(id => aliases[id] || id))];
  const session = profile.session ? { ...profile.session, entryIds: remap(profile.session.entryIds), index: remap(profile.session.entryIds.slice(0, profile.session.index)).length } : null;
  return { ...profile, notes, favorites: remap(profile.favorites), session, masteredEntryIds: remap(profile.masteredEntryIds || []), cards: profile.cards.map(row => ({ ...row, ...(aliases[row.entryId] ? { archived: true } : {}), card: { ...row.card, due: new Date(row.card.due), ...(row.card.last_review ? { last_review: new Date(row.card.last_review) } : {}) } })) };
}
function skipMasteredCards(profile: Profile) {
  const mastered = new Set(profile.masteredEntryIds || []);
  while (profile.session && profile.session.index < profile.session.entryIds.length && mastered.has(profile.session.entryIds[profile.session.index])) profile.session.index++;
}
export function mergeContent(parts: ContentDataset[]): ContentDataset {
  const merged = emptyContent();
  const statusRank = { searchable: 0, learnable: 1, verified: 2 };
  const sourceAssets = new Map<string, string>();
  for (const key of ['books', 'entries', 'lessons', 'sources', 'quizzes', 'bookSections'] as const) {
    const rows = new Map<string, any>();
    for (const part of parts) for (const item of part[key] ?? []) {
      const old = rows.get(item.id);
      if (key === 'bookSections' && old) assert(canonical(old) === canonical(item), `教材栏目 ID 冲突：${item.id}`);
      if (key === 'sources') {
        const source = item as Source;
        // Sequential upgrades may mix legacy image-backed and current text-only sources.
        // Removing an optional asset does not change the identity of the textbook page.
        const asset = sourceAssets.get(source.id);
        assert((!old || (old.bookId === source.bookId && old.pdfPage === source.pdfPage))
          && (!asset || !source.asset || asset === source.asset), `原页 ID 冲突：${item.id}`);
        if (source.asset) sourceAssets.set(source.id, source.asset);
      }
      if (key === 'entries' && old) {
        const entry = item as Entry;
        assert(old.type === entry.type && old.term === entry.term && old.reading === entry.reading, `知识 ID 冲突：${entry.id}`);
        const textbookContents = new Map((old.textbookContents || []).map((block: NonNullable<Entry['textbookContents']>[number]) => [block.id, block]));
        for (const block of entry.textbookContents || []) {
          const previous = textbookContents.get(block.id) as NonNullable<Entry['textbookContents']>[number] | undefined;
          assert(!previous || (previous.bookId === block.bookId && previous.lessonId === block.lessonId), `教材内容 ID 冲突：${block.id}`);
          textbookContents.set(block.id, block);
        }
        // A later course upgrade must not replace a checked reference definition
        // with an unchecked transcription of the same knowledge item.
        const preferred = statusRank[entry.status] >= statusRank[old.status as Entry['status']] ? { ...old, ...entry } : { ...entry, ...old };
        rows.set(item.id, { ...preferred, ...(textbookContents.size ? { textbookContents: [...textbookContents.values()] } : {}), sourceIds: [...new Set([...old.sourceIds, ...entry.sourceIds])], examples: [...old.examples, ...entry.examples].filter((e, i, arr) => arr.findIndex(x => x.japanese === e.japanese && x.chinese === e.chinese) === i) });
      } else rows.set(item.id, item);
    }
    (merged[key] as unknown[]) = [...rows.values()];
  }
  const bookOrder = new Map([
    'beginner-1', 'beginner-2', 'intermediate-1', 'intermediate-2',
    'advanced-1', 'advanced-2', 'red', 'blue',
  ].map((id, index) => [id, index]));
  merged.books!.sort((a, b) =>
    (bookOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
    (bookOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  merged.lessons!.sort((a, b) =>
    (bookOrder.get(a.bookId) ?? Number.MAX_SAFE_INTEGER) -
    (bookOrder.get(b.bookId) ?? Number.MAX_SAFE_INTEGER) ||
    a.number - b.number ||
    a.id.localeCompare(b.id),
  );
  const sources = new Map(merged.sources.map(source => [source.id, source]));
  const page = (section: NonNullable<ContentDataset['bookSections']>[number]) => Math.min(...section.sourceIds.map(id => sources.get(id)?.pdfPage ?? Infinity));
  merged.bookSections!.sort((a, b) => page(a) - page(b) || a.order - b.order || a.id.localeCompare(b.id));
  return merged;
}
// Each installed pack row points at an immutable dataset row (a fresh generation ID per
// import), so the ordered generation list identifies the merged content exactly.
// Profile-only writes then reuse the same content object instead of re-merging every book,
// which also keeps React memoization keyed on `content` stable.
let contentCache: { db: string; key: string; content: ContentDataset } | undefined;
export async function readLibrary() {
  return db.transaction('r', db.packs, db.datasets, db.profiles, async () => {
    const packs = (await db.packs.toArray()).filter(pack => !isWaitingPack(pack.id)).sort((a, b) => a.installedAt.localeCompare(b.installedAt));
    const key = packs.map(p => p.generation).join('\n');
    let content: ContentDataset;
    if (contentCache?.db === db.name && contentCache.key === key) content = contentCache.content;
    else {
      const datasets = await db.datasets.bulkGet(packs.map(p => p.generation));
      content = mergeContent(orderedDatasets(packs, datasets));
      contentCache = { db: db.name, key, content };
    }
    return { content, packs, profile: hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile()), ready: true };
  });
}
export function orderedDatasets(packs: PackManifest[], rows: (DatasetRow | undefined)[]) {
  // On consolidation, keep the original catalog precedence across books.
  const grouped = packs.some(pack => pack.members);
  const parts = packs.flatMap((pack, index) => {
    const data = rows[index]?.data;
    if (!data) return [];
    if (Array.isArray(data)) return data.map((part, i) => ({ data: part, order: pack.members![i].order }));
    return [{ data, order: grouped ? memberRanks.get(pack.id) ?? Infinity : 0 }];
  });
  return parts.sort((a, b) => a.order - b.order).map(part => part.data);
}
export function useLibrary() {
  return useLiveQuery(readLibrary, [], { content: emptyContent(), packs: [] as InstalledPack[], profile: initialProfile(), ready: false });
}
async function editProfile(edit: (p: Profile) => void) {
  await db.transaction('rw', db.profiles, async () => {
    const p = hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile());
    edit(p);
    await db.profiles.put({ id: 'main', data: p });
  });
}
export async function updateSettings(patch: Partial<Profile['settings']>) {
  await editProfile(p => {
    if (patch.dailyNewLimit !== undefined) assert(Number.isInteger(patch.dailyNewLimit) && patch.dailyNewLimit >= 0 && patch.dailyNewLimit <= 100, '每日新卡数量须为 0–100');
    if (patch.defaultMinutes !== undefined) assert([3, 5, 10].includes(patch.defaultMinutes), '学习时长须为 3、5 或 10 分钟');
    p.settings = { ...p.settings, ...patch };
  });
}
export const toggleFavorite = (id: string) => editProfile(p => { p.favorites = p.favorites.includes(id) ? p.favorites.filter(x => x !== id) : [...p.favorites, id]; });
export const saveNote = (id: string, text: string) => editProfile(p => { p.notes[id] = text.slice(0, 10000); });
export const setLessonProgress = (id: string, section: number, completed: boolean) => id === 'beginner-1-lesson-21'
  ? db.transaction('rw', db.packs, db.profiles, async () => {
    const p = hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile());
    const version = installedVersion(await db.packs.toArray(), id);
    p.lessonProgress[id] = { section, completed, ...(version ? { sectionVersion: version } : {}) };
    await db.profiles.put({ id: 'main', data: p });
  })
  : editProfile(p => { p.lessonProgress[id] = { section, completed }; });
export async function setEntryMastered(entryId: string, mastered: boolean) {
  const { content } = await readLibrary();
  assert(content.entries.some(e => e.id === entryId), '该知识条目的内容包尚未安装');
  await editProfile(p => {
    const ids = new Set(p.masteredEntryIds || []);
    if (mastered) ids.add(entryId); else ids.delete(entryId);
    p.masteredEntryIds = [...ids];
    skipMasteredCards(p);
  });
}
export async function startSession(minutes: number, entryIds?: string[]) {
  assert([3, 5, 10].includes(minutes), '请选择 3、5 或 10 分钟');
  const { content } = await readLibrary();
  await editProfile(p => {
    const now = new Date();
    const available = content.entries.filter(e => !entryIds || entryIds.includes(e.id));
    const plan = buildStudyPlan(minutes, available, p, now);
    assert(plan.entryIds.length, plan.limitation === 'daily-limit' ? '今日新卡额度已用完，当前没有到期复习' : '当前没有到期复习或可学新卡');
    p.session = {
      entryIds: plan.entryIds, index: 0, minutes, startedAt: now.toISOString(), completed: 0,
      planned: { reviewCount: plan.reviewCount, newCount: plan.newCount, estimatedSeconds: plan.estimatedSeconds },
    };
  });
}
export async function rateCard(entryId: string, rating: 1 | 2 | 3 | 4) {
  assert([1, 2, 3, 4].includes(rating), '无效的复习评分');
  const { content } = await readLibrary();
  assert(content.entries.some(e => e.id === entryId && e.status === 'verified'), '这张卡片尚未校对或内容包未安装');
  await editProfile(p => {
    assert(!p.masteredEntryIds?.includes(entryId), '这张卡已标记掌握，不再参与复习');
    assert(p.session?.entryIds[p.session.index] === entryId, '这张卡已提交，请继续下一张');
    const now = new Date();
    const old = p.cards.find(c => c.entryId === entryId);
    const result = scheduler.next(old?.card ?? createEmptyCard(now), now, rating as Grade);
    const row = { entryId, card: result.card, archived: false };
    p.cards = [...p.cards.filter(c => c.entryId !== entryId), row];
    p.reviews.push({ id: crypto.randomUUID(), entryId, at: now.toISOString(), rating, wasNew: !old });
    p.session!.index++;
    p.session!.completed++;
    skipMasteredCards(p);
  });
}
export const endSession = () => editProfile(p => { p.session = null; });
export async function startQuizSession(quizIds: string[]) {
  const { content } = await readLibrary();
  assert(quizIds.length > 0 && new Set(quizIds).size === quizIds.length && quizIds.every(id => content.quizzes.some(q => q.id === id && q.status === 'verified')), '没有可用的已核对题目');
  await editProfile(p => { p.quizSession = { quizIds, index: 0, answer: '', result: null }; });
}
export const updateQuizSession = (patch: Partial<NonNullable<Profile['quizSession']>>) => editProfile(p => {
  assert(p.quizSession, '没有正在进行的测验');
  const next = { ...p.quizSession, ...patch };
  assert(Number.isInteger(next.index) && next.index >= 0 && next.index <= next.quizIds.length && typeof next.answer === 'string' && (next.result === null || typeof next.result === 'boolean'), '测验位置无效');
  p.quizSession = next;
});
export const endQuizSession = () => editProfile(p => { p.quizSession = null; });
export async function submitAnswer(quizId: string, answer: string) {
  const { content } = await readLibrary();
  const quiz = content.quizzes.find(q => q.id === quizId);
  assert(quiz?.status === 'verified', '这道题的答案尚未核对');
  const correct = quiz.answers.some(a => normalizeSearch(a) === normalizeSearch(answer));
  await editProfile(p => {
    if (p.quizSession) {
      assert(p.quizSession.quizIds[p.quizSession.index] === quizId && p.quizSession.result === null, '这道题已经提交或不在当前测验中');
      p.quizSession.answer = answer;
      p.quizSession.result = correct;
    }
    p.answers.push({ id: crypto.randomUUID(), quizId, answer, correct, at: new Date().toISOString() });
  });
  return correct;
}

export function validateContent(data: unknown, assetPaths: Set<string>, dependencyContent = emptyContent(), allowTextOnlySources = false): asserts data is ContentDataset {
  assert(isObject(data), '教材内容格式错误');
  for (const key of ['books', 'entries', 'sources', 'lessons', 'quizzes']) {
    assert(Array.isArray(data[key]), `缺少内容列表：${key}`);
    const seen = new Set<string>();
    for (const item of data[key] as unknown[]) {
      assert(isObject(item) && nonempty(item.id) && !seen.has(item.id), `${key} 含无效或重复 ID`);
      seen.add(item.id);
    }
  }
  assert(data.bookSections === undefined || Array.isArray(data.bookSections), '教材栏目必须为数组');
  const sectionIds = new Set<string>();
  for (const section of (data.bookSections ?? []) as unknown[]) {
    assert(isObject(section) && nonempty(section.id) && !sectionIds.has(section.id), '教材栏目含无效或重复 ID');
    sectionIds.add(section.id);
    assert(nonempty(section.title) && nonempty(section.text) && sectionKinds.includes(section.kind as string) && nonempty(section.bookId) && statuses.includes(section.status as string) && Number.isInteger(section.order) && (section.order as number) >= 0, `教材栏目无效：${section.id}`);
    assert(strings(section.sourceIds) && section.sourceIds.length > 0, `教材栏目来源缺失：${section.id}`);
  }
  const d = data as unknown as ContentDataset;
  const combined = mergeContent([dependencyContent, d]);
  const books = new Map(combined.books.map(x => [x.id, x]));
  const sources = new Set(combined.sources.map(x => x.id));
  const entries = new Set(combined.entries.map(x => x.id));
  const lessons = new Set(combined.lessons.map(x => x.id));
  const quizzes = new Set(combined.quizzes.map(x => x.id));
  const sourceRows = new Map(combined.sources.map(x => [x.id, x]));
  const lessonRows = new Map(combined.lessons.map(x => [x.id, x]));
  const refs = (v: unknown, set: Set<string>, label: string) => assert(strings(v) && v.every(id => set.has(id)), `${label}引用缺失`);
  for (const b of d.books) assert(nonempty(b.title) && nonempty(b.filename) && Number.isInteger(b.pageCount) && b.pageCount > 0, '书籍信息无效');
  for (const s of d.sources) {
    assert(books.has(s.bookId) && Number.isInteger(s.pdfPage) && s.pdfPage > 0 && s.pdfPage <= books.get(s.bookId)!.pageCount, `原页页码无效：${s.id}`);
    if (s.asset === undefined) assert(allowTextOnlySources, `旧版内容包来源缺少原页图片：${s.id}`);
    else assert(safePath(s.asset) && s.asset.startsWith('assets/') && assetPaths.has(s.asset), `原页图片缺失或路径无效：${s.id}`);
  }
  for (const e of d.entries) {
    assert(['vocabulary', 'grammar'].includes(e.type) && nonempty(e.term) && nonempty(e.meaning) && statuses.includes(e.status), `条目无效：${e.id}`);
    assert(Array.isArray(e.examples) && e.examples.every(x => nonempty(x.japanese) && typeof x.chinese === 'string'), `例句格式错误：${e.id}`);
    refs(e.sourceIds, sources, '条目来源');
    assert(e.supplemental || e.sourceIds.length > 0, `条目未标明来源：${e.id}`);
    if (e.textbookContents !== undefined) {
      assert(Array.isArray(e.textbookContents), `教材内容格式错误：${e.id}`);
      const seen = new Set<string>();
      for (const block of e.textbookContents) {
        assert(isObject(block) && nonempty(block.id) && !seen.has(block.id), `教材内容包含无效或重复 ID：${e.id}`);
        seen.add(block.id);
        assert(books.has(block.bookId) && nonempty(block.meaning) && statuses.includes(block.status), `教材内容无效：${block.id}`);
        assert((block.reading === undefined || typeof block.reading === 'string') && (block.explanation === undefined || typeof block.explanation === 'string'), `教材内容文本无效：${block.id}`);
        assert(block.lessonId === undefined || (nonempty(block.lessonId) && lessonRows.get(block.lessonId)?.bookId === block.bookId), `教材内容课次引用缺失或教材不符：${block.id}`);
        assert(Array.isArray(block.examples) && block.examples.every(x => isObject(x) && nonempty(x.japanese) && typeof x.chinese === 'string'), `教材例句格式错误：${block.id}`);
        refs(block.sourceIds, sources, '教材内容来源');
        assert(block.sourceIds.length > 0 && block.sourceIds.every(id => sourceRows.get(id)?.bookId === block.bookId), `教材内容来源缺失或教材不符：${block.id}`);
      }
    }
  }
  for (const l of d.lessons) {
    assert(books.has(l.bookId) && Number.isInteger(l.number) && nonempty(l.title) && statuses.includes(l.status) && Array.isArray(l.sections), `课次无效：${l.id}`);
    refs(l.entryIds, entries, '课程知识'); refs(l.quizIds, quizzes, '课程练习');
    for (const s of l.sections) {
      assert(nonempty(s.id) && nonempty(s.title) && typeof s.text === 'string', '课程段落无效');
      refs(s.sourceIds, sources, '段落来源');
    }
  }
  for (const section of d.bookSections ?? []) {
    assert(books.has(section.bookId), `教材栏目书籍不存在：${section.id}`);
    refs(section.sourceIds, sources, '教材栏目来源');
    assert(section.sourceIds.every(id => sourceRows.get(id)?.bookId === section.bookId), `教材栏目来源教材不符：${section.id}`);
  }
  for (const q of d.quizzes) {
    assert(lessons.has(q.lessonId) && ['choice', 'cloze'].includes(q.type) && nonempty(q.prompt) && statuses.includes(q.status) && typeof q.explanation === 'string', `题目无效：${q.id}`);
    assert(strings(q.answers) && (q.status !== 'verified' || q.answers.length > 0), `题目答案缺失：${q.id}`);
    if (q.type === 'choice') assert(strings(q.options) && q.options.length > 1 && q.answers.every(a => q.options!.includes(a)), `选择题选项无效：${q.id}`);
    refs(q.sourceIds, sources, '题目来源'); refs(q.entryIds, entries, '题目知识');
    assert(q.supplemental || q.sourceIds.length > 0, `题目未标明来源：${q.id}`);
  }
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function readZip(bytes: Uint8Array) {
  assert(bytes.length <= 100 * 1024 * 1024, '单个内容包不能超过 100 MB，请按课拆分');
  let total = 0, count = 0;
  const rejected: string[] = [];
  const files = unzipSync(bytes, { filter: f => {
    count++; total += f.originalSize;
    if (!safePath(f.name) || count > 3000 || f.originalSize > 25 * 1024 * 1024 || total > 300 * 1024 * 1024) { rejected.push(f.name); return false; }
    return true;
  } });
  assert(!rejected.length, '内容包路径或大小不符合限制');
  return files;
}
function compareVersions(a: string, b: string) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}
function installedVersion(packs: PackManifest[], id: string) {
  return packs.find(pack => pack.id === id)?.version ?? packs.flatMap(pack => pack.members ?? []).find(member => member.id === id)?.version;
}
export function satisfiesPack(packs: PackManifest[], required: { id: string; version: string }) {
  const version = installedVersion(packs, required.id);
  return version !== undefined && compareVersions(version, required.version) >= 0;
}

// Lesson 21 v1.0.2 moves the glossary tail into 生词 and removes one navigation tab.
// Coordinates follow the displayed layout; backup package minima stay independent.
function migrateLesson21Navigation(profile: Profile, sourceVersion?: string, targetVersion?: string) {
  const id = 'beginner-1-lesson-21', corrected = '1.0.2';
  const progress = profile.lessonProgress[id];
  const previous = progress?.sectionVersion ?? sourceVersion;
  if (!progress || !previous) return;
  let section = progress.section;
  if (targetVersion && compareVersions(previous, corrected) < 0 && compareVersions(targetVersion, corrected) >= 0 && section >= 8 && section <= 13) section = section === 8 ? 7 : section - 1;
  if (targetVersion && compareVersions(previous, corrected) >= 0 && compareVersions(targetVersion, corrected) < 0 && section >= 8 && section <= 12) section++;
  profile.lessonProgress[id] = { ...progress, section, sectionVersion: targetVersion ?? previous };
}

export async function importContentPack(file: Blob, expected?: { id: string; version: string; file: string }): Promise<string> {
  assert(file.size <= 100 * 1024 * 1024, '内容包超过 100 MB，请按课拆分');
  const files = readZip(new Uint8Array(await file.arrayBuffer()));
  assert(files['manifest.json'], expected ? `内置教材包清单缺失：${expected.file}` : '缺少内容包清单');
  const m = JSON.parse(strFromU8(files['manifest.json'])) as PackManifest;
  if (expected) assert(m.id === expected.id && m.version === expected.version, `内置教材包与目录声明不符：${expected.file}`);
  assert(m.schemaVersion === 1 || m.schemaVersion === 2 || m.schemaVersion === 3 || m.schemaVersion === 4, '不支持的内容包版本，请更新应用');
  assert(nonempty(m.id) && /^[a-z0-9][a-z0-9._-]*$/i.test(m.id) && /^\d+\.\d+\.\d+$/.test(m.version) && nonempty(m.title), '不支持的内容包版本或格式');
  assert(safePath(m.contentFile) && Array.isArray(m.files) && Array.isArray(m.dependencies), '内容包清单无效');
  const listed = new Set<string>();
  for (const item of m.files) {
    assert(safePath(item.path) && item.path !== 'manifest.json' && !listed.has(item.path), '清单包含重复或非法路径');
    listed.add(item.path);
    assert(files[item.path]?.length === item.bytes && /^[a-f0-9]{64}$/.test(item.sha256) && await sha256(files[item.path]) === item.sha256, `文件损坏：${item.path}`);
  }
  assert(listed.has(m.contentFile) && Object.keys(files).length === listed.size + 1, '内容包存在未校验的文件');
  const data: unknown = JSON.parse(strFromU8(files[m.contentFile]));
  const bundled = m.schemaVersion === 4;
  const validRequirement = (value: unknown) => isObject(value) && nonempty(value.id)
    && /^[a-z0-9][a-z0-9._-]*$/i.test(value.id) && typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version);
  assert(m.dependencies.every(validRequirement), '内容包依赖无效');
  if (bundled) {
    assert(Array.isArray(m.members) && m.members.length > 0 && Array.isArray(data) && data.length === m.members.length, '书包缺少有效的内容清单');
    const ids = new Set<string>(), ranks = new Set<number>();
    for (const member of m.members) {
      assert(validRequirement(member) && member.id !== m.id && !ids.has(member.id) && Number.isSafeInteger(member.order)
        && member.order >= 0 && !ranks.has(member.order), '书包包含无效或重复的内容条目');
      ids.add(member.id); ranks.add(member.order);
    }
    for (const part of data) {
      assert(isObject(part) && Array.isArray(part.bookSections), '书包内容缺少教材栏目数组');
      validateContent(part, listed, emptyContent(), true);
    }
  } else {
    assert(m.members === undefined && isObject(data), '教材内容格式错误');
    if (m.schemaVersion === 2 || m.schemaVersion === 3) assert(Array.isArray(data.bookSections), `版本 ${m.schemaVersion} 内容包缺少教材栏目数组`);
    else assert(data.bookSections === undefined || (Array.isArray(data.bookSections) && data.bookSections.length === 0), '教材栏目需要版本 2 内容包');
  }

  const generation = `${m.id}/${crypto.randomUUID()}`;
  return db.transaction('rw', db.packs, db.datasets, db.assets, db.profiles, db.snapshots, async () => {
    const packs = (await db.packs.toArray()).filter(pack => !isWaitingPack(pack.id)).sort((a, b) => a.installedAt.localeCompare(b.installedAt));
    const existing = packs.find(pack => pack.id === m.id);
    if (existing) assert(compareVersions(m.version, existing.version) >= 0, '不能用旧版覆盖新版内容包');
    const covering = packs.find(pack => pack.members?.some(member => member.id === m.id));
    if (covering) {
      assert(!bundled && satisfiesPack([covering], m), '请导入更新的整书内容包');
      return `已安装 ${covering.title}`;
    }
    const members = new Map(m.members?.map(member => [member.id, member]));
    for (const member of existing?.members ?? []) {
      assert(satisfiesPack([m], member), `更新会移除或降级书包内容：${member.id}`);
    }
    const retired = packs.filter(pack => pack.id === m.id || members.has(pack.id));
    for (const pack of retired) if (pack.id !== m.id) {
      assert(!pack.members && satisfiesPack([m], pack), `书包不能覆盖较新的内容包：${pack.title}`);
    }
    const retained = packs.filter(pack => !retired.includes(pack));
    const candidatePacks = [...retained, m];
    for (const pack of retained) for (const member of pack.members ?? []) {
      assert(!members.has(member.id) && !m.members?.some(item => item.order === member.order), '书包内容 ID 或顺序冲突');
    }
    for (const dep of m.dependencies) assert(satisfiesPack(retained, dep), `请先导入依赖内容包：${dep.id}`);
    for (const pack of retained) for (const dep of pack.dependencies) {
      assert(satisfiesPack(candidatePacks, dep), `升级会破坏内容包依赖：${pack.title}`);
    }
    if (existing?.version === m.version) {
      assert(existing.schemaVersion === m.schemaVersion && existing.contentFile === m.contentFile
        && canonical(existing.files) === canonical(m.files) && canonical(existing.members) === canonical(m.members)
        && canonical(existing.dependencies) === canonical(m.dependencies), '同一版本内容不同，请提升内容包版本号');
      return `已安装 ${m.title}`;
    }

    const retainedRows = await db.datasets.bulkGet(retained.map(pack => pack.generation));
    if (bundled) {
      const retiredRows = await db.datasets.bulkGet(retired.map(pack => pack.generation));
      const oldParts = orderedDatasets(retired, retiredRows);
      // A retired source can drop its optional image, but cannot change identity.
      mergeContent([...oldParts, ...(data as ContentDataset[])].map(part => ({ ...emptyContent(), sources: part.sources })));
    } else {
      validateContent(data, listed, mergeContent(orderedDatasets(retained, retainedRows)), m.schemaVersion === 3);
    }
    const incoming = { id: generation, data: data as DatasetRow['data'] };
    const candidate = mergeContent(orderedDatasets(candidatePacks, [...retainedRows, incoming]));
    const allAssets = new Set([...listed, ...retained.flatMap(pack => pack.files.map(file => file.path))]);
    validateContent(candidate, allAssets, emptyContent(), true);

    for (const path of listed) if (path.startsWith('assets/')) {
      await db.assets.put({ id: `${generation}/${path}`, blob: new Blob([new Uint8Array(files[path])], { type: /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg' }) });
    }
    await db.datasets.put(incoming);
    for (const pack of retired) {
      await db.assets.where('id').startsWith(`${pack.generation}/`).delete();
      await db.datasets.delete(pack.generation);
      await db.packs.delete(pack.id);
    }
    await db.packs.put({ ...m, generation, installedAt: new Date().toISOString() });
    const p = hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile());
    const lessonId = 'beginner-1-lesson-21';
    const previous = installedVersion(packs, lessonId);
    const next = installedVersion([m], lessonId);
    if (next) {
      migrateLesson21Navigation(p, previous, next);
      const snapshot = await db.snapshots.get('before-restore');
      if (snapshot?.data.lessonProgress[lessonId]) {
        migrateLesson21Navigation(snapshot.data, previous, next);
        await db.snapshots.put(snapshot);
      }
    }
    const ids = new Set(candidate.entries.map(entry => entry.id));
    p.cards = p.cards.map(card => ({ ...card, archived: !ids.has(card.entryId) }));
    await db.profiles.put({ id: 'main', data: p });
    return `已导入 ${m.title}`;
  });
}

function validateProfile(v: unknown): asserts v is Profile {
  assert(isObject(v) && isObject(v.settings) && Number.isInteger(v.settings.dailyNewLimit) && Number(v.settings.dailyNewLimit) >= 0 && Number(v.settings.dailyNewLimit) <= 100 && [3, 5, 10].includes(Number(v.settings.defaultMinutes)) && nonempty(v.settings.targetLevel) && typeof v.settings.furigana === 'boolean', '备份设置无效');
  assert(strings(v.favorites) && isObject(v.notes) && Object.values(v.notes).every(x => typeof x === 'string') && isObject(v.lessonProgress), '备份收藏、笔记或进度无效');
  if (v.masteredEntryIds !== undefined) assert(strings(v.masteredEntryIds) && new Set(v.masteredEntryIds).size === v.masteredEntryIds.length, '备份已掌握条目无效');
  for (const row of Object.values(v.lessonProgress)) assert(isObject(row) && Number.isInteger(row.section) && Number(row.section) >= 0 && typeof row.completed === 'boolean' && (row.sectionVersion === undefined || (typeof row.sectionVersion === 'string' && /^\d+\.\d+\.\d+$/.test(row.sectionVersion))), '备份课次进度无效');
  assert(Array.isArray(v.cards) && Array.isArray(v.reviews) && Array.isArray(v.answers), '备份学习记录无效');
  const seen = new Set<string>();
  for (const row of v.cards) {
    assert(isObject(row) && nonempty(row.entryId) && !seen.has(row.entryId) && isObject(row.card), '备份卡片无效');
    seen.add(row.entryId);
    const c = row.card;
    assert(typeof c.due === 'string' && Number.isFinite(Date.parse(c.due)) && [0, 1, 2, 3].includes(Number(c.state)), '备份卡片日期或状态无效');
    for (const key of ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses']) assert(typeof c[key] === 'number' && Number.isFinite(c[key]) && Number(c[key]) >= 0, '备份复习参数无效');
    if (c.last_review !== undefined) assert(typeof c.last_review === 'string' && Number.isFinite(Date.parse(c.last_review)), '备份复习日期无效');
  }
  for (const row of v.reviews) assert(isObject(row) && nonempty(row.id) && nonempty(row.entryId) && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) && [1, 2, 3, 4].includes(Number(row.rating)) && typeof row.wasNew === 'boolean', '备份复习日志无效');
  for (const row of v.answers) assert(isObject(row) && nonempty(row.id) && nonempty(row.quizId) && typeof row.answer === 'string' && typeof row.correct === 'boolean' && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)), '备份答题记录无效');
  if (v.session !== null) assert(isObject(v.session) && strings(v.session.entryIds) && Number.isInteger(v.session.index) && Number(v.session.index) >= 0 && Number(v.session.index) <= v.session.entryIds.length && [3, 5, 10].includes(Number(v.session.minutes)) && typeof v.session.startedAt === 'string' && Number.isFinite(Date.parse(v.session.startedAt)) && Number.isInteger(v.session.completed), '备份学习会话无效');
  if (isObject(v.session) && v.session.planned !== undefined) {
    const plan = v.session.planned;
    assert(isObject(plan) && ['reviewCount', 'newCount', 'estimatedSeconds'].every(key => Number.isInteger(plan[key]) && Number(plan[key]) >= 0)
      && Number(plan.reviewCount) + Number(plan.newCount) === (v.session.entryIds as string[]).length
      && Number(plan.estimatedSeconds) <= Number(v.session.minutes) * 60, '备份学习安排无效');
  }
  if (v.quizSession !== undefined && v.quizSession !== null) assert(isObject(v.quizSession) && strings(v.quizSession.quizIds) && Number.isInteger(v.quizSession.index) && Number(v.quizSession.index) >= 0 && Number(v.quizSession.index) <= v.quizSession.quizIds.length && typeof v.quizSession.answer === 'string' && (v.quizSession.result === null || typeof v.quizSession.result === 'boolean'), '备份测验会话无效');
  if (v.requiredPacks !== undefined) assert(Array.isArray(v.requiredPacks) && v.requiredPacks.every(p => isObject(p) && nonempty(p.id) && typeof p.version === 'string' && /^\d+\.\d+\.\d+$/.test(p.version)), '备份所需内容包无效');
}
export async function exportBackup(): Promise<Blob> {
  const state = await readLibrary();
  const requirements = new Map((state.profile.requiredPacks || []).filter(required =>
    !state.packs.some(pack => pack.members?.some(member => member.id === required.id && compareVersions(member.version, required.version) >= 0)),
  ).map(p => [p.id, p]));
  for (const p of state.packs) if (!requirements.has(p.id) || compareVersions(p.version, requirements.get(p.id)!.version) >= 0) requirements.set(p.id, { id: p.id, version: p.version, title: p.title });
  const payload = strToU8(JSON.stringify({ schemaVersion: 1, kind: 'hiyori-backup', createdAt: new Date().toISOString(), profile: state.profile, requiredPacks: [...requirements.values()] }));
  const files = zipSync({ 'backup.json': payload, 'checksum.txt': strToU8(await sha256(payload)) });
  return new Blob([new Uint8Array(files)], { type: 'application/zip' });
}
export async function restoreBackup(file: Blob): Promise<{ missingPacks: string[] }> {
  const files = readZip(new Uint8Array(await file.arrayBuffer()));
  assert(files['backup.json'] && files['checksum.txt'] && await sha256(files['backup.json']) === strFromU8(files['checksum.txt']), '备份校验失败，原记录未改变');
  const backup = JSON.parse(strFromU8(files['backup.json']));
  assert(backup.schemaVersion === 1 && backup.kind === 'hiyori-backup' && Array.isArray(backup.requiredPacks), '不支持的备份版本');
  validateProfile(backup.profile);
  const missingPacks: string[] = [];
  for (const dep of backup.requiredPacks) assert(isObject(dep) && nonempty(dep.id) && nonempty(dep.version) && /^\d+\.\d+\.\d+$/.test(dep.version), '备份内容包列表无效');
  await db.transaction('rw', db.packs, db.profiles, db.snapshots, async () => {
    const packs = await db.packs.toArray();
    for (const dep of backup.requiredPacks) if (!satisfiesPack(packs, dep)) missingPacks.push(typeof dep.title === 'string' ? dep.title : dep.id);
    const old = hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile());
    const currentLesson21Version = installedVersion(packs, 'beginner-1-lesson-21');
    migrateLesson21Navigation(old, currentLesson21Version, currentLesson21Version);
    await db.snapshots.put({ id: 'before-restore', data: old, at: new Date().toISOString() });
    const restored = hydrateProfile({ ...backup.profile, requiredPacks: backup.requiredPacks });
    migrateLesson21Navigation(restored, backup.requiredPacks.find((pack: { id: string; version: string }) => pack.id === 'beginner-1-lesson-21')?.version, currentLesson21Version);
    skipMasteredCards(restored);
    await db.profiles.put({ id: 'main', data: restored });
  });
  return { missingPacks };
}
export async function undoRestore() {
  await db.transaction('rw', db.profiles, db.snapshots, db.packs, async () => {
    const snapshot = await db.snapshots.get('before-restore');
    assert(snapshot, '尚无恢复前快照');
    const version = installedVersion(await db.packs.toArray(), 'beginner-1-lesson-21');
    const current = hydrateProfile((await db.profiles.get('main'))?.data ?? initialProfile());
    const restored = hydrateProfile(snapshot.data);
    migrateLesson21Navigation(current, version, version);
    migrateLesson21Navigation(restored, undefined, version);
    await db.profiles.put({ id: 'main', data: restored });
    await db.snapshots.put({ id: 'before-restore', data: current, at: new Date().toISOString() });
  });
}
let seeding: Promise<{ id: string; version: string }[]> | undefined;
export function seedBundledPack(): Promise<{ id: string; version: string }[]> {
  seeding ??= (async () => {
    try {
      // Every URL is an installed local resource on desktop and Android.
      const response = await fetch(`${import.meta.env.BASE_URL}packs/catalog.json`);
      assert(response.ok, '内置教材目录缺失');
      const catalog: unknown = await response.json();
      assert(isObject(catalog) && catalog.schemaVersion === 1 && Array.isArray(catalog.packs), '内置教材目录格式无效');
      const ids = new Set<string>(), files = new Set<string>();
      const targets: { id: string; version: string; file: string }[] = [];
      for (const item of catalog.packs) {
        assert(isObject(item) && nonempty(item.id) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.id) && nonempty(item.version) && /^\d+\.\d+\.\d+$/.test(item.version) && nonempty(item.file) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.zip$/.test(item.file), '内置教材目录条目无效');
        assert(!ids.has(item.id) && !files.has(item.file), '内置教材目录包含重复 ID 或文件');
        ids.add(item.id); files.add(item.file);
        targets.push({ id: item.id, version: item.version, file: item.file });
      }
      for (const target of targets) {
        const active = await db.packs.get(target.id);
        if (active && compareVersions(active.version, target.version) >= 0) continue;
        const response = await fetch(`${import.meta.env.BASE_URL}packs/${target.file}`);
        assert(response.ok, `内置教材包缺失：${target.file}`);
        await importContentPack(await response.blob(), target);
      }
      return targets.map(({ id, version }) => ({ id, version }));
    } catch (error) {
      throw new Error(`内置教材加载失败：${error instanceof Error ? error.message : String(error)}。现有内容与记录已保留，请在“我的”中补装内容包。`);
    }
  })().finally(() => { seeding = undefined; });
  return seeding;
}
