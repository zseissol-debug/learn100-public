import { judgePrompt } from './prompts.js';
import { normalizeJudge, statusAfter } from './scoring.js';

export function hasScoringTranscript(record) {
  return record.transcript.some(line => line.role === 'user' && ['retell','followup'].includes(line.phase) && line.text?.trim());
}

export async function scoreSessionRecord({ record, concept, request, persist, isCurrent }) {
  const recordId = record.id;
  let updated, error = null;
  try {
    const result = await request(judgePrompt(concept), {
      transcript: record.transcript,
      hint_viewed: record.hint_viewed,
      follow_ups: concept.follow_ups,
      follow_up_hints: concept.follow_up_hints
    });
    const raw = JSON.parse(result.content);
    const judge = normalizeJudge(raw, concept, record.transcript);
    updated = {
      ...record,
      judge_raw: raw,
      judge,
      token_usage: { ...record.token_usage, judge: result.usage },
      status_after: statusAfter(judge),
      error: null
    };
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error(String(cause));
    updated = { ...record, error: `评分失败：${error.message}` };
  }
  await persist(updated);
  return { record: updated, error, current: isCurrent ? isCurrent(recordId) : true };
}
