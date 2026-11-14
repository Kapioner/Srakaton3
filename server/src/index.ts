import { existsSync } from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, REPO_ROOT } from './config.ts';
import { warmUp } from './dataset.ts';
import { report } from './queries.ts';
import { apiRoutes } from './routes/api.ts';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });
await app.register(compress);
await app.register(apiRoutes);

// Live FIRMS feed + forecast under /api/live (from the API_backend branch). Off unless LIVE_ENABLED=true,
// so a demo without internet, or a problem in the live part, never affects the archive API.
if (process.env.LIVE_ENABLED === 'true') {
  try {
    const { registerLive } = await import('./livefeed/plugin.ts');
    await registerLive(app);
  } catch (err) {
    app.log.error(`live feed disabled: ${(err as Error).message}`);
  }
}

// In production the same process serves the built frontend (npm run build).
const webDist = path.join(REPO_ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  `DuckDB limits: memory ${config.duckdb.memoryLimit}, ${config.duckdb.threads} threads, query timeout ${config.limits.queryTimeoutMs / 1000} s`,
);
// Compute dataset metadata in the background so the first page load is fast. The whole-dataset report
// scans every detection (~40 s on the world dataset), so it is precomputed right after and then cached.
void warmUp((msg) => app.log.info(msg)).then(async () => {
  const t0 = performance.now();
  try {
    await report({ bbox: null, from: null, to: null });
    app.log.info(`report (whole dataset) cached in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    app.log.info(`report warm-up skipped: ${(err as Error).message}`);
  }
});
