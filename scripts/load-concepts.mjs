import { readFile } from 'node:fs/promises';

export const CONCEPT_FILES = [
  'intro20_v0.2.json',
  'batch1_v0.2.json',
  'batch2_v0.2.json',
  'batch3_v0.2.json',
  'batch4_v0.2.json',
  'batch5_v0.2.json'
];

export async function loadConcepts(root = new URL('../', import.meta.url)) {
  const files = await Promise.all(CONCEPT_FILES.map(async file => ({
    file,
    items: JSON.parse(await readFile(new URL(`data/${file}`, root), 'utf8'))
  })));
  const intro = files.find(item => item.file === CONCEPT_FILES[0]).items
    .toSorted((a, b) => a.intro_order - b.intro_order);
  const batches = files.slice(1).flatMap(item => item.items)
    .toSorted((a, b) => a.batch - b.batch || a.batch_order - b.batch_order);
  return [...intro, ...batches];
}
