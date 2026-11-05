import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { judgePrompt } from '../public/prompts.js';
import { normalizeJudge } from '../public/scoring.js';
import { CONFIG } from '../public/config.js';

const key = process.env.ARK_API_KEY;
const concept = JSON.parse(await readFile(new URL('../data/intro20_v0.2.json', import.meta.url))).find(x => x.name === '幻觉');
const tutor = 'AI 一本正经地编出不存在的内容，语气很肯定。它是在猜下一句，不是查资料。书名和数字容易错。重要信息自己核查。';
const examples = [
  { name:'空白', retell:'不知道。', check:j => j.total === 0 && j.flags.includes('no_retell') },
  { name:'背话', retell:tutor, check:j => j.points.every(p => p.score <= 1) && j.flags.includes('parroting') },
  { name:'误区', retell:'用了付费版就不会有幻觉。重要的数字也不用查了。', check:j => j.misconceptions_stated.length > 0 },
  { name:'自己的话加例子', retell:'比如它推荐一本不存在的书，还把作者说得很肯定。我去图书馆找不到，因为它是在顺着文字猜，不是在查书目。所以碰到书名和年份，我会去可靠目录核实。', check:j => j.points.filter(p => p.score === 2).length >= 2 },
  { name:'错字', retell:'它会一本正经编出没有的书明。它顺着字接下去，不是在查。碰到重要数字我会自己核对。', check:j => j.points.some(p => p.score > 0) }
];

test('真实方舟模型：五类评分方向', { skip: !key && '设置 ARK_API_KEY 后运行' }, async t => {
  for (const item of examples) {
    await t.test(item.name, async () => {
      const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
        method:'POST', headers:{ authorization:`Bearer ${key}`, 'content-type':'application/json' },
        body:JSON.stringify({ model:CONFIG.judgeModel, temperature:0.1, thinking:{type:'disabled'}, response_format:{type:'json_object'},
          messages:[{role:'system',content:judgePrompt(concept)},
            {role:'user',content:JSON.stringify({ transcript:[{role:'tutor',phase:'talk',text:tutor,t:10},{role:'user',phase:'retell',text:item.retell,t:150}],hint_viewed:false,follow_ups:concept.follow_ups,follow_up_hints:concept.follow_up_hints })}] })
      });
      assert.equal(response.status, 200, `方舟返回 ${response.status}`);
      const payload = await response.json();
      const result = normalizeJudge(JSON.parse(payload.choices[0].message.content), concept,
        [{role:'tutor',phase:'talk',text:tutor},{role:'user',phase:'retell',text:item.retell}]);
      assert.ok(item.check(result), `${item.name} 方向不符：${JSON.stringify(result)}`);
    });
  }
});
