import type { Entry, Profile } from './types';

// Product estimates for planning a short session, not a timer or a speed target.
export const REVIEW_SECONDS = 20;
export const NEW_CARD_SECONDS = 45;

export interface StudyPlan {
  entryIds: string[];
  reviewCount: number;
  newCount: number;
  estimatedSeconds: number;
  budgetSeconds: number;
  dueCount: number;
  newAvailable: number;
  dailyNewRemaining: number;
  limitation: 'budget' | 'daily-limit' | 'available-content';
}

const localDate = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function buildStudyPlan(minutes: number, entries: Entry[], profile: Profile, now = new Date()): StudyPlan {
  if (![3, 5, 10].includes(minutes)) throw new Error('请选择 3、5 或 10 分钟');
  const mastered = new Set(profile.masteredEntryIds || []);
  const available = entries.filter(entry => entry.status === 'verified' && !mastered.has(entry.id));
  const ids = new Set(available.map(entry => entry.id));
  const due = profile.cards.filter(row => !row.archived && ids.has(row.entryId) && new Date(row.card.due) <= now)
    .sort((a, b) => new Date(a.card.due).getTime() - new Date(b.card.due).getTime());
  const known = new Set(profile.cards.map(row => row.entryId));
  const fresh = available.filter(entry => !known.has(entry.id));
  const usedToday = profile.reviews.filter(review => review.wasNew && localDate(new Date(review.at)) === localDate(now)).length;
  const dailyNewRemaining = Math.max(0, profile.settings.dailyNewLimit - usedToday);
  const budgetSeconds = minutes * 60;
  const reviewCount = Math.min(due.length, Math.floor(budgetSeconds / REVIEW_SECONDS));
  const newCount = Math.min(fresh.length, dailyNewRemaining, Math.floor((budgetSeconds - reviewCount * REVIEW_SECONDS) / NEW_CARD_SECONDS));
  const estimatedSeconds = reviewCount * REVIEW_SECONDS + newCount * NEW_CARD_SECONDS;
  const allEligibleIncluded = reviewCount === due.length && newCount === Math.min(fresh.length, dailyNewRemaining);
  const limitation = estimatedSeconds < budgetSeconds && allEligibleIncluded
    ? fresh.length > dailyNewRemaining ? 'daily-limit' : 'available-content'
    : 'budget';
  return {
    entryIds: [...due.slice(0, reviewCount).map(row => row.entryId), ...fresh.slice(0, newCount).map(entry => entry.id)],
    reviewCount, newCount, estimatedSeconds, budgetSeconds,
    dueCount: due.length, newAvailable: fresh.length, dailyNewRemaining, limitation,
  };
}
