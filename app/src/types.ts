import type { Card } from 'ts-fsrs';
export type ContentStatus = 'searchable' | 'learnable' | 'verified';
export interface Book { id: string; title: string; filename: string; pageCount: number; description?: string }
export interface Source { id: string; bookId: string; pdfPage: number; printedPage?: string; section?: string }
export interface TextbookContent {
  id: string; bookId: string; lessonId?: string; reading?: string; meaning: string; explanation?: string;
  examples: { japanese: string; chinese: string }[]; status: ContentStatus; sourceIds: string[];
}
export interface Entry {
  id: string; type: 'vocabulary' | 'grammar'; term: string; reading?: string; meaning: string;
  explanation?: string; examples: { japanese: string; chinese: string }[];
  level?: string; levelSource?: string; status: ContentStatus; sourceIds: string[];
  supplemental?: boolean;
  textbookContents?: TextbookContent[];
}
export interface LessonSection { id: string; title: string; kind: 'text' | 'vocabulary' | 'grammar' | 'exercise' | 'answers' | 'notes'; text: string; sourceIds: string[] }
export interface BookSection extends LessonSection { bookId: string; status: ContentStatus; order: number }
export interface Lesson { id: string; bookId: string; number: number; title: string; status: ContentStatus; entryIds: string[]; quizIds: string[]; sections: LessonSection[]; coverageNote?: string }
export interface Quiz { id: string; lessonId: string; type: 'choice' | 'cloze'; prompt: string; options?: string[]; answers: string[]; explanation: string; status: ContentStatus; sourceIds: string[]; entryIds: string[]; supplemental?: boolean }
export interface ContentDataset { books: Book[]; entries: Entry[]; sources: Source[]; lessons: Lesson[]; quizzes: Quiz[]; bookSections?: BookSection[] }
export interface PackManifest { schemaVersion: 4; id: string; version: string; title: string; createdAt?: string; contentFile: string; dependencies: { id: string; version: string }[]; files: { path: string; sha256: string; bytes: number }[]; members: { id: string; version: string; order: number }[] }
export interface InstalledPack extends PackManifest { installedAt: string; generation: string }
export interface ReviewCard { entryId: string; card: Card; archived?: boolean }
export interface ReviewEvent { id: string; entryId: string; at: string; rating: number; wasNew: boolean }
export interface AnswerEvent { id: string; quizId: string; answer: string; correct: boolean; at: string }
export interface StudySession {
  entryIds: string[]; index: number; minutes: number; startedAt: string; completed: number;
  planned?: { reviewCount: number; newCount: number; estimatedSeconds: number };
}
export interface Profile {
  settings: { dailyNewLimit: number; defaultMinutes: number; targetLevel: string; startLessonId?: string; furigana: boolean };
  favorites: string[]; notes: Record<string, string>; lessonProgress: Record<string, { section: number; completed: boolean }>;
  cards: ReviewCard[]; reviews: ReviewEvent[]; answers: AnswerEvent[]; session: StudySession | null;
  masteredEntryIds?: string[];
  quizSession?: { quizIds: string[]; index: number; answer: string; result: boolean | null } | null;
  requiredPacks?: { id: string; version: string; title?: string }[];
}
