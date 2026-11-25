import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';
import { unambiguousTerms } from '../app/src/content-links';
import { buildSearchIndex, paginateSearch, searchEntries, searchReading } from '../app/src/search-index';
import { initialProfile } from '../app/src/store';
import { buildStudyPlan } from '../app/src/study-plan';
import type { ContentDataset, Entry } from '../app/src/types';

const entry = (id: string, fields: Partial<Entry> = {}): Entry => ({
  id, term: id, type: 'vocabulary', meaning: id, status: 'verified', sourceIds: [], examples: [], ...fields,
});

describe('study planning', () => {
  const now = new Date(2026, 10, 25, 12);
  const day = (offset: number) => new Date(2026, 10, 25 + offset, 12);
  const card = (entryId: string, offset: number, archived = false) => ({
    entryId, card: createEmptyCard(day(offset)), archived,
  });

  it('orders due cards, excludes ineligible entries and applies the local daily new-card limit', () => {
    const profile = initialProfile();
    profile.settings.dailyNewLimit = 2;
    profile.masteredEntryIds = ['mastered'];
    profile.cards = [card('due', 0), card('overdue', -1), card('future', 1), card('archived', -1, true), card('mastered', -1), card('missing', -1)];
    profile.reviews = [
      { id: 'today', entryId: 'due', at: day(0).toISOString(), wasNew: true, rating: 3 },
      { id: 'today-review', entryId: 'overdue', at: day(0).toISOString(), wasNew: false, rating: 3 },
      { id: 'yesterday', entryId: 'archived', at: day(-1).toISOString(), wasNew: true, rating: 3 },
    ];
    const entries = ['due', 'fresh', 'overdue', 'fresh-2', 'future', 'archived', 'mastered'].map(id => entry(id));
    entries.push(entry('unchecked', { status: 'learnable' }));
    expect(buildStudyPlan(3, entries, profile, now)).toMatchObject({
      entryIds: ['overdue', 'due', 'fresh'], reviewCount: 2, newCount: 1,
      dueCount: 2, newAvailable: 2, estimatedSeconds: 85, dailyNewRemaining: 1, limitation: 'daily-limit',
    });
  });

  it('spends the time budget on due cards before considering new cards', () => {
    const profile = initialProfile();
    profile.cards = Array.from({ length: 10 }, (_, i) => card(`due-${i}`, -1));
    const entries = [entry('fresh'), ...profile.cards.map(row => entry(row.entryId))];
    expect(buildStudyPlan(3, entries, profile, now)).toMatchObject({
      entryIds: profile.cards.slice(0, 9).map(row => row.entryId),
      dueCount: 10, reviewCount: 9, newCount: 0, estimatedSeconds: 180, limitation: 'budget',
    });
    expect(buildStudyPlan(10, entries, profile, now)).toMatchObject({
      reviewCount: 10, newCount: 1, limitation: 'available-content',
    });
    expect(() => buildStudyPlan(4, entries, profile, now)).toThrow();
  });
});

describe('search and reading links', () => {
  const student = entry('student', {
    term: '学生', reading: 'がくせい', meaning: '学生', level: 'N3', sourceIds: ['course-page'],
    textbookContents: [
      { id: 'red-definition', bookId: 'red', meaning: '在校生', examples: [], status: 'verified', sourceIds: ['red-page'] },
      { id: 'blue-definition', bookId: 'blue', meaning: '学生', examples: [], status: 'verified', sourceIds: ['blue-page'] },
    ],
  });
  const section = { id: 'text', title: '基本课文', kind: 'text' as const, text: '学生です。', sourceIds: ['course-page'] };
  const lesson = { id: 'lesson', bookId: 'beginner-1', number: 1, title: '第1课', status: 'verified' as const, entryIds: ['student'], quizIds: [], sections: [section] };
  const content: ContentDataset = {
    books: [], entries: [student], quizzes: [],
    sources: [
      { id: 'course-page', bookId: 'beginner-1', pdfPage: 1 },
      { id: 'red-page', bookId: 'red', pdfPage: 2 },
      { id: 'blue-page', bookId: 'blue', pdfPage: 3 },
    ],
    lessons: [lesson, { ...lesson, id: 'red-level', bookId: 'red', title: 'N5 词汇' }, { ...lesson, id: 'blue-level', bookId: 'blue', title: 'N4 语法' }],
    bookSections: [{ ...section, id: 'preface', bookId: 'beginner-1', status: 'verified', order: 1 }],
  };
  const index = buildSearchIndex(content);

  it('normalizes kana and width, indexes textbook-specific definitions, and uses the selected book’s level', () => {
    const filters = { book: 'red', level: 'N5', type: 'vocabulary' };
    for (const query of ['学生', 'がくせい', 'ガクセイ', ' ｶﾞｸ ｾｲ ', '在校生']) {
      expect(searchEntries(index, { ...filters, query })).toEqual([student]);
    }
    expect(searchEntries(index, { ...filters, query: '学生', book: 'blue' })).toEqual([]);
    expect(searchEntries(index, { ...filters, query: '学生', book: 'blue', level: 'N4' })).toEqual([student]);
    expect(searchEntries(index, { ...filters, query: '', type: 'grammar' })).toEqual([]);
  });

  it('returns standard textbook passages and preserves the section index for navigation', () => {
    const hits = searchReading(index, '学生', '');
    expect(hits.bodies.map(hit => [hit.lesson.id, hit.section.id, hit.index])).toEqual([['lesson', 'text', 0]]);
    expect(hits.sections.map(hit => hit.id)).toEqual(['preface']);
    expect(searchReading(index, '学生', 'red')).toEqual({ bodies: [], sections: [] });
    expect(searchReading(index, '　', '')).toEqual({ bodies: [], sections: [] });
  });

  it('clamps the requested page after filtering and handles empty results', () => {
    const entries = Array.from({ length: 101 }, (_, i) => entry(String(i)));
    expect(paginateSearch(entries, -1)).toMatchObject({ page: 0, start: 1, end: 100, pages: 2 });
    expect(paginateSearch(entries, 4)).toEqual({ entries: entries.slice(100), page: 1, start: 101, end: 101, pages: 2, total: 101 });
    expect(paginateSearch([], 4)).toEqual({ entries: [], page: 0, start: 0, end: 0, pages: 1, total: 0 });
  });

  it('links longer exact terms first and leaves ambiguous spellings unlinked', () => {
    const international = entry('international', { term: '留学生' });
    const ambiguous = [entry('life', { term: '生', reading: 'せい' }), entry('raw', { term: '生', reading: 'なま' })];
    expect(unambiguousTerms('留学生と学生。生。', [student, ...ambiguous, international])).toEqual([international, student]);
  });
});
