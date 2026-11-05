import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConcepts } from '../scripts/load-concepts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsPaths = ['config.js', 'prompts.js', 'scoring.js', 'score-session.js', 'storage.js', 'audio.js', 'app.js'];

test('构建产物为脚本和模块导入添加内容版本，避免浏览器复用旧评分代码', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd:root, stdio:'ignore' });
  const sources = await Promise.all(jsPaths.map(async path => [path, await readFile(resolve(root, 'public', path), 'utf8')]));
  const version = createHash('sha256')
    .update(sources.map(([path, body]) => `/${path}\0${body}`).join('\0'))
    .digest('hex').slice(0, 12);
  const bundle = await readFile(resolve(root, 'dist/server/index.js'), 'utf8');
  const concepts = await loadConcepts(new URL('../', import.meta.url));

  assert.ok(bundle.includes(`src=\\"/app.js?v=${version}\\"`));
  assert.ok(bundle.includes(`from './config.js?v=${version}'`));
  assert.ok(bundle.includes(`from './prompts.js?v=${version}'`));
  assert.ok(bundle.includes(`from './score-session.js?v=${version}'`));
  for (const concept of concepts) assert.ok(bundle.includes(`\"id\":\"${concept.id}\"`), `构建产物缺少 ${concept.name}`);
});
