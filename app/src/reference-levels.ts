import type { Entry, Lesson } from './types';

type ReferenceBook = 'red' | 'blue';
export type ReferenceLevelIndex = Map<string, Partial<Record<ReferenceBook, string[]>>>;

export function buildReferenceLevelIndex(lessons: Lesson[]): ReferenceLevelIndex {
  const index: ReferenceLevelIndex = new Map();
  for (const lesson of lessons) {
    if (lesson.bookId !== 'red' && lesson.bookId !== 'blue') continue;
    const level = lesson.title.match(/^(N[1-5])\s/)?.[1];
    if (!level) continue;
    for (const id of lesson.entryIds) {
      const books = index.get(id) || {};
      books[lesson.bookId] = [...new Set([...(books[lesson.bookId] || []), level])].sort();
      index.set(id, books);
    }
  }
  return index;
}

export function entryReferenceLevels(entry: Entry, index: ReferenceLevelIndex, bookId?: string): string[] {
  const books = index.get(entry.id);
  if (!books) return entry.level ? [entry.level] : [];
  if (bookId === 'red' || bookId === 'blue') return books[bookId] || [];
  return [...new Set(Object.values(books).flat())].sort();
}
