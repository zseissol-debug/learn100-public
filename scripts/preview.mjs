import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadConcepts } from './load-concepts.mjs';

const root = new URL('../', import.meta.url);
const contentTypes = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const concepts = await loadConcepts(root);
const server = createServer(async (request, response) => {
  const requestedPath = new URL(request.url, 'http://localhost').pathname;
  if (requestedPath === '/api/concepts') {
    response.writeHead(200, { 'content-type':'application/json; charset=utf-8' }).end(JSON.stringify(concepts));
    return;
  }
  const path = `/public${requestedPath === '/' ? '/index.html' : requestedPath}`;
  if (path.includes('..') || !path.startsWith('/public/')) { response.writeHead(404).end(); return; }
  try {
    const file = await readFile(new URL(`.${path}`, root));
    const ext = path.slice(path.lastIndexOf('.'));
    response.writeHead(200, { 'content-type': contentTypes[ext] || 'application/json; charset=utf-8' }).end(file);
  } catch { response.writeHead(404).end(); }
});
server.listen(4173, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:4173'));
