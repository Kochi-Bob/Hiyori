import type { Entry } from './types';

// A spelling alone cannot choose between different readings or meanings.
// Leave ambiguous text unlinked until a source-specific association is reviewed.
export function unambiguousTerms(text: string, entries: Entry[]): Entry[] {
  const byTerm = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.term || !text.includes(entry.term)) continue;
    const matches = byTerm.get(entry.term) || [];
    matches.push(entry);
    byTerm.set(entry.term, matches);
  }
  return [...byTerm.values()].filter(matches => matches.length === 1)
    .map(([entry]) => entry).sort((a,b) => b.term.length-a.term.length);
}
