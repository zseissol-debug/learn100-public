import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConcepts } from '../scripts/load-concepts.mjs';
import { CONFIG } from '../public/config.js';
import { normalizeJudge, statusAfter } from '../public/scoring.js';
import { tutorPrompt, judgePrompt } from '../public/prompts.js';

const concepts = await loadConcepts(new URL('../', import.meta.url));
const concept = concepts.find(item => item.name === '幻觉');
const tutor = '幻觉是一本正经地编出不存在的事。它按最可能的词往下写，不是在查事实。数字、人名、书名和最近的事容易错。重要信息自己核查，或给它可靠资料。';
const transcript = retell => [
  { role:'tutor', phase:'talk', text:tutor, t:5 },
  { role:'user', phase:'retell', text:retell, t:150 }
];
const raw = (scores, evidence = '') => ({
  points:scores.map((score, index) => ({ index:index+1, score, evidence, note:'' })),
  flags:[], misconceptions_stated:[], followup:{ result:'not_asked', note:'' }, feedback_for_user:{}
});

test('全部 100 个概念的数据与教学顺序符合约定', () => {
  assert.equal(concepts.length, 100);
  assert.equal(new Set(concepts.map(item => item.id)).size, 100, '概念 ID 必须唯一');
  const orderByName = new Map(concepts.map((item, index) => [item.name, index]));
  for (const item of concepts) {
    for (const prerequisite of item.prerequisites || []) {
      assert.ok(orderByName.has(prerequisite), `${item.name} 的前置概念不存在：${prerequisite}`);
      assert.ok(orderByName.get(prerequisite) < orderByName.get(item.name), `${item.name} 的前置概念排在教学顺序之后：${prerequisite}`);
    }
    assert.equal(item.key_points.length, 4, `${item.name} 应有四个要点`);
    for (const [index, point] of item.key_points.entries()) {
      assert.ok(String(point.scoring?.['1'] || '').trim(), `${item.name} 第 ${index + 1} 点缺少 1 分标准`);
      assert.ok(String(point.scoring?.['2'] || '').trim(), `${item.name} 第 ${index + 1} 点缺少 2 分标准`);
    }
    if (item.volatile === true) assert.ok(item.web_checks?.length, `${item.name} 标记易变但没有 web_checks`);
  }
  const zones = new Map();
  for (const item of concepts) zones.set(item.zone, (zones.get(item.zone) || 0) + 1);
  assert.equal(zones.size, 10, '应有十个主题组');
  assert.ok([...zones.values()].every(count => count === 10), '每个主题组应有十个概念');
});

test('全部 100 个概念都能拼出提示词，导师不见评分细则', () => {
  for (const [index, item] of concepts.entries()) {
    const tutorText = tutorPrompt(item, concepts[index + 1]?.name || '');
    assert.ok(tutorText.includes(item.name));
    assert.ok(!tutorText.includes(item.scoring_note));
    assert.ok(judgePrompt(item).includes(item.scoring_note));
    if (item.familiar === false) assert.match(tutorText, /没有开场问题/);
    if (concepts[index + 1]) assert.ok(tutorText.includes(concepts[index + 1].name));
  }
});

test('空白或拒答：零分且 no_retell', () => {
  const result = normalizeJudge(raw([2,2,2,2], '不知道'), concept, transcript('不知道'));
  assert.equal(result.total, 0); assert.ok(result.flags.includes('no_retell'));
});

test('背话：每个要点最高 1 分', () => {
  const result = normalizeJudge(raw([2,2,2,2], tutor), concept, transcript(tutor));
  assert.ok(result.points.every(point => point.score <= 1));
  assert.ok(result.flags.includes('parroting'));
});

test('说出误区：引用该错误说法的要点不给分', () => {
  const quote = '用了付费版就不会有幻觉';
  const result = normalizeJudge({ ...raw([0,0,0,2], quote), misconceptions_stated:[{ wrong:concept.misconceptions[1].wrong, evidence:quote }] },
    concept, transcript(`${quote}。所以重要内容我都不需要核查。`));
  assert.equal(result.points[3].score, 0); assert.equal(result.misconceptions_stated.length, 1);
});

test('自己的话加例子：可保留至少两个 2 分要点', () => {
  const spoken = '它说书名像真的，结果我一查图书馆根本没有。因为它只是顺着句子往下猜，所以读起来顺，不等于有出处。我会先去出版社网站核实。';
  const result = normalizeJudge(raw([2,2,0,2], spoken), concept, transcript(spoken));
  assert.ok(result.points.filter(point => point.score === 2).length >= 2); assert.equal(statusAfter(result), 'spoken');
});

test('转写错字：有足够语义证据时不因字形扣分', () => {
  const spoken = '它会一本正经编出根本没有的书明，听着很肯定。它是顺着前面的字往下接，不是真去查。我会先去图书馆查一下。';
  const result = normalizeJudge({ ...raw([2,2,0,2], spoken), flags:['asr_noisy'] }, concept, transcript(spoken));
  assert.equal(result.points[0].score, 2); assert.ok(result.flags.includes('asr_noisy'));
});

test('追问只能作为单个要点的 1 分补充，且可以通过配置关闭', () => {
  assert.deepEqual(CONFIG.followupSupplement, { enabled:true, maxPerPoint:1 });
  const retell = '我知道它会根据上下文生成回答，但我还不能解释它具体怎样一步步产生内容。我可以再想想其他的部分。';
  const followup = '它会根据前面已经出現的文字，逐步预测下一个词，再接着生成后面的内容。';
  const fullTranscript = [...transcript(retell), { role:'user', phase:'followup', text:followup, t:190 }];
  const withSupplement = normalizeJudge(raw([0,2,0,0], followup), concept, fullTranscript);
  assert.equal(withSupplement.points[1].score, 1);
  assert.equal(withSupplement.total, 1);
  const disabled = normalizeJudge(raw([0,2,0,0], followup), concept, fullTranscript,
    { ...CONFIG, followupSupplement:{ enabled:false, maxPerPoint:1 } });
  assert.equal(disabled.points[1].score, 0);
});

test('导师原话和追问回答不能替代复述证据', () => {
  const result = normalizeJudge(raw([2,2,2,2], tutor), concept, [
    { role:'tutor', phase:'talk', text:tutor },
    { role:'user', phase:'retell', text:'我听到了导师的说法，但还没有完全想明白。我想再自己理一理它的意思。' },
    { role:'user', phase:'followup', text:tutor }
  ]);
  assert.equal(result.total, 0);
});

test('很短的证据不能支撑 2 分', () => {
  const spoken = '它会一本正经编出根本没有的书名，听着很肯定。它是顺着前面的字往下接，不是真去查。我会先去图书馆查一下。';
  const result = normalizeJudge(raw([2,0,0,0], '编出'), concept, transcript(spoken));
  assert.ok(result.points[0].score <= 1);
});

test('背诵原话前加短前缀仍会被识别', () => {
  const spoken = `我先想一想再复述一下刚才导师讲的内容吧${tutor}`;
  const result = normalizeJudge(raw([2,2,2,2], spoken), concept, transcript(spoken));
  assert.ok(result.flags.includes('parroting'));
  assert.ok(result.points.every(point => point.score <= 1));
});

test('超过简短字数的单句拒答仍按 no_retell 归零', () => {
  const spoken = '我不知道这个概念到底指什么，也无法解释它的作用和判断方式，所以我现在确实没有办法复述。';
  assert.ok(spoken.length > 28, '样例应超过旧实现的简短拒答长度');
  const result = normalizeJudge(raw([2,2,2,2], spoken), concept, transcript(spoken));
  assert.equal(result.total, 0);
  assert.ok(result.flags.includes('no_retell'));
});

test('判官返回非整数要点分时归零并要求复核', () => {
  const spoken = '它会把没有的书名编得像真的。它根据上下文接着写，不是在查事实。我会再找可靠来源核对。';
  const result = normalizeJudge(raw([1.5,2,0,0], spoken), concept, transcript(spoken));
  assert.equal(result.points[0].score, 0);
  assert.ok(result.flags.includes('needs_review'));
});

test('没有开场问的概念不会产生开场提问', () => {
  for (const item of concepts.filter(value => value.familiar === false)) assert.equal(item.opening_question, null);
});
