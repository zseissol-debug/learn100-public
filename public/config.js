export const CONFIG = Object.freeze({
  appName: 'Learn100',
  tutorName: '小练',
  voiceModel: '1.2.6.1',
  voice: 'zh_female_vv_jupiter_bigtts',
  judgeModel: 'deepseek-v4-1-flash-economy-261017',
  callLimitSeconds: 600,
  followupSupplement: { enabled: true, maxPerPoint: 1 },
  minEvidenceQuoteChars: 2,
  minEvidenceCharsForFullScore: 16,
  minTutorOverlapEvidenceChars: 10,
  parroting: { windowChars: 10, minRetellChars: 24, minMatchRatio: 0.6 },
  spoken: { minTotal: 3, minDistinctPoints: 2, forbiddenFlags: ['no_retell'] },
  lit: { requiresNextDayReview: true, hintViewedCeiling: 'spoken' },
  noRetellMaxSentences: 1,
  maxSessionBytes: 2_000_000
});
