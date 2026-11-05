import test from 'node:test';
import assert from 'node:assert/strict';
import { hasScoringTranscript, scoreSessionRecord } from '../public/score-session.js';
import { loadConcepts } from '../scripts/load-concepts.mjs';

const concepts = await loadConcepts(new URL('../', import.meta.url));
const concept = concepts.find(item => item.name === '幻觉');

test('只有复述或追问阶段有学习者转写时才提供重评按钮', () => {
  assert.equal(hasScoringTranscript({ transcript:[{ role:'user', phase:'opening', text:'我见过这个词。' }] }), false);
  assert.equal(hasScoringTranscript({ transcript:[{ role:'user', phase:'retell', text:'我还不确定。' }] }), true);
});

test('旧会话的迟到评分只保存到原记录，不覆盖当前新会话', async () => {
  const transcript = [{ role:'user', phase:'retell', text:'它会把没有的书名编得像真的。它顺着上下文续写，不是在查事实。我会去图书馆目录核对书名。' }];
  const original = { id:'old-call', concept_id:concept.id, transcript, hint_viewed:false, token_usage:{ judge:null }, judge:null };
  let current = original;
  const persisted = [];
  let resolveRequest;
  const pendingRequest = new Promise(resolve => { resolveRequest = resolve; });
  const scoring = scoreSessionRecord({
    record:original,
    concept,
    request:() => pendingRequest,
    persist:async record => { persisted.push(record); },
    isCurrent:id => current?.id === id
  });

  current = { id:'new-call', concept_id:concept.id, judge:null };
  resolveRequest({ content:JSON.stringify({
    points:concept.key_points.map((_, index) => ({ index:index + 1, score:2, evidence:transcript[0].text, note:'' })),
    flags:[], misconceptions_stated:[], followup:{ result:'not_asked', note:'' }, feedback_for_user:{}
  }), usage:{ total_tokens:12 } });

  const outcome = await scoring;
  assert.equal(outcome.current, false);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, 'old-call');
  assert.ok(persisted[0].judge);
  assert.equal(persisted[0].judge.total, 8);
  assert.equal(current.id, 'new-call');
  assert.equal(current.judge, null);
});
