import type { ContentDataset, Entry } from './types';
import { normalizeSearch } from './store';
import { buildReferenceLevelIndex, entryReferenceLevels } from './reference-levels';

export interface SearchFilters { query: string; book: string; level: string; type: string }
export const SEARCH_PAGE_SIZE = 100;

export function paginateSearch(entries: Entry[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(entries.length / SEARCH_PAGE_SIZE));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const offset = page * SEARCH_PAGE_SIZE;
  return { entries: entries.slice(offset, offset + SEARCH_PAGE_SIZE), page, pages,
    start: entries.length ? offset + 1 : 0, end: Math.min(offset + SEARCH_PAGE_SIZE, entries.length), total: entries.length };
}

// Content changes rebuild the index; typing and learning-record changes only
// query it. Keep every field, source and ordering used by the original search.
export function buildSearchIndex(content: ContentDataset) {
  const sourceBooks = new Map(content.sources.map(source => [source.id, source.bookId]));
  const levels = buildReferenceLevelIndex(content.lessons);
  const entries = content.entries.map(entry => ({
    entry,
    text: normalizeSearch([entry.term, entry.reading, entry.meaning, entry.explanation,
      ...entry.examples.map(example => `${example.japanese} ${example.chinese}`),
      ...(entry.textbookContents || []).flatMap(block => [block.reading, block.meaning, block.explanation,
        ...block.examples.map(example => `${example.japanese} ${example.chinese}`)]),
    ].join(' ')),
    books: new Set([...entry.sourceIds, ...(entry.textbookContents || []).flatMap(block => block.sourceIds)]
      .map(id => sourceBooks.get(id)).filter((id): id is string => !!id)),
    levels: {
      all: entryReferenceLevels(entry, levels),
      red: entryReferenceLevels(entry, levels, 'red'),
      blue: entryReferenceLevels(entry, levels, 'blue'),
    },
  }));
  const bodies = content.lessons.filter(lesson => lesson.bookId !== 'red' && lesson.bookId !== 'blue')
    .flatMap(lesson => lesson.sections.map((section, index) => ({ lesson, section, index, text: normalizeSearch(section.text) })));
  const sections = (content.bookSections || []).filter(section => section.bookId !== 'red' && section.bookId !== 'blue')
    .map(section => ({ section, text: normalizeSearch(`${section.title} ${section.text}`) }));
  return { sourceBooks, entries, bodies, sections };
}

export function searchEntries(index: ReturnType<typeof buildSearchIndex>, filters: SearchFilters): Entry[] {
  const query = normalizeSearch(filters.query);
  return index.entries.filter(row => (!filters.type || row.entry.type === filters.type)
    && (!filters.level || row.levels[filters.book === 'red' || filters.book === 'blue' ? filters.book : 'all'].includes(filters.level))
    && (!filters.book || row.books.has(filters.book))
    && (!query || row.text.includes(query))).map(row => row.entry);
}

export function searchReading(index: ReturnType<typeof buildSearchIndex>, query: string, book: string) {
  const normalized = normalizeSearch(query);
  if (!normalized) return { bodies: [], sections: [] };
  return {
    bodies: index.bodies.filter(row => (!book || row.lesson.bookId === book) && row.text.includes(normalized)).slice(0, 30),
    sections: index.sections.filter(row => (!book || row.section.bookId === book) && row.text.includes(normalized)).slice(0, 30).map(row => row.section),
  };
}
