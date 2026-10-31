import { type Card, type LearningRecord, type Rating, type Skill, type ReviewRecord, localDay } from './model';

export interface MemoryState { due: number; intervalDays: number; ease: number; successes: number; lapses: number; reviews: number }
export interface ReviewTask { card: Card; skill: Skill; memory: MemoryState }
const DAY = 86_400_000;
/** Transparent v1 interval scheduler. This is intentionally not branded as FSRS. */
export function nextMemory(previous: MemoryState, at: number, rating: Rating): MemoryState {
  let { intervalDays, ease, successes, lapses } = previous;
  if (rating === 1) {
    successes = 0; lapses++; intervalDays = 0; ease = Math.max(1.3, ease - .2);
    return { due: at + 10 * 60_000, intervalDays, ease, successes, lapses, reviews: previous.reviews + 1 };
  }
  if (rating === 2) { intervalDays = Math.max(1, intervalDays * 1.2); ease = Math.max(1.3, ease - .15); }
  else {
    intervalDays = successes === 0 ? (rating === 4 ? 4 : 1) : successes === 1 ? (rating === 4 ? 8 : 3) : Math.max(1, intervalDays * ease * (rating === 4 ? 1.3 : 1));
    successes++;
    if (rating === 4) ease = Math.min(3.2, ease + .15);
  }
  intervalDays = Math.min(365, Math.round(intervalDays * 100) / 100);
  return { due: at + intervalDays * DAY, intervalDays, ease, successes, lapses, reviews: previous.reviews + 1 };
}
export function memoryFor(item: Card, skill: Skill, records: LearningRecord[]): MemoryState {
  let state: MemoryState = { due: Date.parse(item.createdAt), intervalDays: 0, ease: 2.5, successes: 0, lapses: 0, reviews: 0 };
  const seen = new Set<string>();
  const events = records.filter((r): r is ReviewRecord => r.type === 'review' && r.cardId === item.id && r.skill === skill).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    state = nextMemory(state, Date.parse(event.at), event.rating);
  }
  return state;
}
export function dueTasks(cards: Card[], records: LearningRecord[], now: Date, includeDemo: boolean): ReviewTask[] {
  return cards.filter(c => includeDemo || c.origin !== 'demo').flatMap(item => (['recognition', 'production'] as const).map(skill => ({ card: item, skill, memory: memoryFor(item, skill, records) })))
    .filter(t => t.memory.due <= now.getTime()).sort((a, b) => a.memory.due - b.memory.due || a.card.id.localeCompare(b.card.id) || a.skill.localeCompare(b.skill));
}
export function statistics(cards: Card[], records: LearningRecord[], now: Date, includeDemo: boolean) {
  const ids = new Set(cards.filter(c => includeDemo || c.origin !== 'demo').map(c => c.id));
  const seen = new Set<string>();
  const valid = records.filter(r => { if (!ids.has(r.cardId) || seen.has(r.id)) return false; seen.add(r.id); return true; });
  const today = valid.filter(r => localDay(new Date(r.at)) === localDay(now));
  const reviews = today.filter((r): r is ReviewRecord => r.type === 'review');
  return { cards: ids.size, todayReviews: reviews.length, todayPractices: today.filter(r => r.type === 'practice').length, recalled: reviews.filter(r => r.rating >= 3).length, due: dueTasks(cards, records, now, includeDemo).length };
}
