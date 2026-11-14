import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal stand-in for the FIRMS active-fire file server, with ETag support. */
export async function startFakeFirms(files: Record<string, string>) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url!);
    const body = files[req.url!];
    if (body === undefined) return res.writeHead(404).end('not found');
    const etag = `"${body.length}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
    res.writeHead(200, { 'Content-Type': 'text/csv', ETag: etag }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
export const acqDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const acqTime = (d: Date) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
