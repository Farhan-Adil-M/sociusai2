// Learner model: deterministic, transparent, explainable.
// mastery = correct / total per topic. No machine learning — a beginner can
// check every number by hand. Pure functions; persistence lives elsewhere.

/** Grading bands (internal; mastery ranges → next difficulty + revision line). */
const THRESHOLDS = {
  easyBelow: 0.5, // mastery < 0.5 → next questions are easy
  mediumBelow: 0.8, // 0.5 ≤ mastery < 0.8 → medium, else hard
  revisionBelow: 0.6, // needs revision when mastery < 0.6 …
  revisionMinAttempts: 3, // … and the student has tried at least 3 questions
};

export function difficultyFor(mastery) {
  if (mastery < THRESHOLDS.easyBelow) return 'easy';
  if (mastery < THRESHOLDS.mediumBelow) return 'medium';
  return 'hard';
}

export function needsRevision({ correct, total }) {
  if (total < THRESHOLDS.revisionMinAttempts) return false;
  return correct / total < THRESHOLDS.revisionBelow;
}

// Apply a graded attempt to one topic's stats. Returns the update to persist.
export function applyAttempt(topic, stats, attempt) {
  const before = stats && stats.total > 0 ? stats.correct / stats.total : null;
  const correct = (stats?.correct ?? 0) + attempt.correct;
  const total = (stats?.total ?? 0) + attempt.total;
  const after = correct / total;
  return {
    topic: topic.trim().toLowerCase(),
    correct,
    total,
    mastery: after,
    difficulty: difficultyFor(after),
    before,
    delta: before === null ? null : Number((after - before).toFixed(4)),
  };
}

// The difficulty to use when the frontend does not pass one explicitly.
export function chooseDifficulty(stats) {
  if (!stats || stats.total === 0) return 'medium';
  return difficultyFor(stats.correct / stats.total);
}

// Which topic should the student tackle next?
// Worst mastery among topics that need revision, else least recently practised.
export function suggestNext(topics) {
  if (!topics || topics.length === 0) return null;
  const flagged = topics.filter(needsRevision);
  const pool = flagged.length > 0 ? flagged : topics;
  const worst = [...pool].sort((a, b) => (a.correct / a.total) - (b.correct / b.total))[0];
  return { topic: worst.topic, difficulty: difficultyFor(worst.correct / worst.total) };
}
