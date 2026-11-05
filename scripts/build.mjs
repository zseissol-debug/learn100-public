import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConcepts } from './load-concepts.mjs';

const root = new URL('../', import.meta.url);
const paths = ['index.html', 'style.css', 'config.js', 'prompts.js', 'scoring.js', 'score-session.js', 'storage.js', 'audio.js', 'app.js'];
const types = { html:'text/html; charset=utf-8', css:'text/css; charset=utf-8', js:'text/javascript; charset=utf-8' };
const assets = {};
for (const path of paths) {
  const body = await readFile(new URL(`public/${path}`, root), 'utf8');
  assets[`/${path}`] = { body, type: types[path.split('.').at(-1)] };
}
const jsAssets = Object.entries(assets).filter(([path]) => path.endsWith('.js'));
const assetVersion = createHash('sha256')
  .update(jsAssets.map(([path, asset]) => `${path}\0${asset.body}`).join('\0'))
  .digest('hex').slice(0, 12);
for (const [, asset] of jsAssets) {
  asset.body = asset.body.replace(/(from\s+['"])(\.\/[^'"]+\.js)(['"])/g, `$1$2?v=${assetVersion}$3`);
}
assets['/index.html'].body = assets['/index.html'].body.replace('src="/app.js"', `src="/app.js?v=${assetVersion}"`);
const concepts = await loadConcepts(root);
const worker = await readFile(new URL('worker/index.js', root), 'utf8');
const output = `const ASSETS = ${JSON.stringify(assets)};\nconst CONCEPTS = ${JSON.stringify(concepts)};\n${worker}`;
await mkdir(new URL('dist/server/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), output);
await mkdir(new URL('dist/.openai/', root), { recursive: true });
const manifest = await readFile(new URL('.openai/hosting.json', root), 'utf8').catch(() => '{}');
await writeFile(new URL('dist/.openai/hosting.json', root), manifest);
console.log(`Built ${concepts.length} concepts, ${Object.keys(assets).length} assets`);
