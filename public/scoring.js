import { CONFIG } from './config.js';

const sentences = text => text.split(/[。！？!?；;\n]+/).map(x => x.trim()).filter(Boolean);
const compact = text => text.replace(/[\s，。！？!?；;：“”"'、（）()]/g, '');

export function isNoRetell(transcript, config = CONFIG) {
  const retell = transcript.filter(x => x.role === 'user' && x.phase === 'retell').map(x => x.text).join(' ');
  const stripped = compact(retell);
  return !stripped || /^(不知道|不清楚|不会|忘了|没听懂|不知道怎么说|不想说)$/.test(stripped) ||
    sentences(retell).length <= config.noRetellMaxSentences;
}

function copiedRatio(text, source, config) {
  const windowSize = config.parroting.windowChars;
  if (text.length < windowSize || source.length < windowSize) return 0;
  const sourceWindows = new Set();
  for (let start = 0; start + windowSize <= source.length; start++) sourceWindows.add(source.slice(start, start + windowSize));
  const coverageDelta = new Int32Array(text.length + 1);
  for (let start = 0; start + windowSize <= text.length; start++) {
    if (sourceWindows.has(text.slice(start, start + windowSize))) {
      coverageDelta[start]++;
      coverageDelta[start + windowSize]--;
    }
  }
  let active = 0, covered = 0;
  for (let index = 0; index < text.length; index++) {
    active += coverageDelta[index];
    if (active) covered++;
  }
  return covered / text.length;
}

export function isParroting(transcript, concept, config = CONFIG) {
  const retell = compact(transcript.filter(x => x.role === 'user' && x.phase === 'retell').map(x => x.text).join(''));
  if (retell.length < config.parroting.minRetellChars) return false;
  const source = [concept.definition, ...concept.talk_outline.beats, ...transcript.filter(x => x.role === 'tutor').map(x => x.text)].map(compact).join('');
  return copiedRatio(retell, source, config) >= config.parroting.minMatchRatio;
}

export function normalizeJudge(raw, concept, transcript, config = CONFIG) {
  if (!raw || !Array.isArray(raw.points)) throw new Error('评分结果格式不正确');
  const noRetell = isNoRetell(transcript, config);
  const parroting = isParroting(transcript, concept, config) || raw.flags?.includes('parroting');
  const retellText = compact(transcript.filter(x => x.role === 'user' && x.phase === 'retell').map(x => x.text).join(''));
  const followupText = compact(transcript.filter(x => x.role === 'user' && x.phase === 'followup').map(x => x.text).join(''));
  const tutorText = compact(transcript.filter(x => x.role === 'tutor').map(x => x.text).join(''));
  let invalidScore = false;
  const points = concept.key_points.map((_, offset) => {
    const p = raw.points.find(x => Number(x.index) === offset + 1) || {};
    const evidence = typeof p.evidence === 'string' ? p.evidence : '';
    const contradicted = (Array.isArray(raw.misconceptions_stated) ? raw.misconceptions_stated : []).some(x => x.evidence && evidence &&
      (evidence.includes(x.evidence) || x.evidence.includes(evidence)));
    const quote = compact(evidence);
    const supportedByRetell = quote.length >= config.minEvidenceQuoteChars && retellText.includes(quote);
    const supportedByFollowup = quote.length >= config.minEvidenceQuoteChars && followupText.includes(quote) && !(quote.length >= config.minTutorOverlapEvidenceChars && tutorText.includes(quote));
    const evidenceIsParroting = copiedRatio(quote, tutorText, config) >= config.parroting.minMatchRatio;
    const candidateScore = Number(p.score);
    const validScore = Number.isInteger(candidateScore) && candidateScore >= 0 && candidateScore <= 2;
    if (!validScore) invalidScore = true;
    const rawScore = validScore ? candidateScore : 0;
    const evidenceAdjustedScore = rawScore === 2 && quote.length < config.minEvidenceCharsForFullScore ? 1 : rawScore;
    const score = contradicted ? 0 : supportedByRetell ? evidenceAdjustedScore :
      config.followupSupplement?.enabled && supportedByFollowup ? Math.min(config.followupSupplement.maxPerPoint, rawScore) : 0;
    return { index: offset + 1, score: noRetell ? 0 : evidenceIsParroting ? Math.min(score, 1) : score,
      evidence, note: typeof p.note === 'string' ? p.note : '' };
  });
  const flags = [...new Set([...(Array.isArray(raw.flags) ? raw.flags : []), ...(noRetell ? ['no_retell'] : []), ...(parroting ? ['parroting'] : []), ...(invalidScore ? ['needs_review'] : [])])];
  return {
    points, total: points.reduce((sum, p) => sum + p.score, 0),
    distinct_points_covered: points.filter(p => p.score > 0).length,
    misconceptions_stated: Array.isArray(raw.misconceptions_stated) ? raw.misconceptions_stated : [],
    followup: raw.followup && ['good','ok','missed','not_asked'].includes(raw.followup.result) ? raw.followup : { result:'not_asked', note:'' },
    flags,
    feedback_for_user: {
      did_well: String(raw.feedback_for_user?.did_well || ''),
      missing: String(raw.feedback_for_user?.missing || ''),
      correct_if_needed: String(raw.feedback_for_user?.correct_if_needed || '')
    }
  };
}

export function statusAfter(judge, config = CONFIG) {
  return judge.total >= config.spoken.minTotal && judge.distinct_points_covered >= config.spoken.minDistinctPoints &&
    config.spoken.forbiddenFlags.every(flag => !judge.flags.includes(flag)) ? 'spoken' : 'none';
}
