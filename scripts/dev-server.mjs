import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import relay from '../outputs/api-speed-monitor/netlify/functions/relay.mjs';

const siteDirectory = fileURLToPath(new URL('../outputs/api-speed-monitor/', import.meta.url));
const port = Number(process.env.PORT) || 8787;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (incoming, outgoing) => {
  const origin = `http://localhost:${port}`;
  const requestUrl = new URL(incoming.url, origin);
  const abortController = new AbortController();
  outgoing.on('close', () => { if (!outgoing.writableEnded) abortController.abort(); });
  try {
    if (requestUrl.pathname === '/api/relay') {
      const request = new Request(requestUrl, {
        method: incoming.method,
        headers: incoming.headers,
        body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming),
        duplex: 'half',
        signal: abortController.signal
      });
      const response = await relay(request, { ip: incoming.socket.remoteAddress });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
      return;
    }
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      outgoing.writeHead(405);
      outgoing.end('Method not allowed');
      return;
    }
    const relativePath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    const assetPath = resolve(siteDirectory, `.${relativePath}`);
    if (!assetPath.startsWith(`${resolve(siteDirectory)}${sep}`) || relativePath.startsWith('/netlify/')) {
      outgoing.writeHead(403);
      outgoing.end('Forbidden');
      return;
    }
    const info = await stat(assetPath);
    if (!info.isFile()) throw new Error('Not found');
    outgoing.writeHead(200, { 'Content-Type': types[extname(assetPath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    outgoing.end(incoming.method === 'HEAD' ? undefined : await readFile(assetPath));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    outgoing.end('无法完成请求');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`狗厕预览：http://localhost:${port}`));
