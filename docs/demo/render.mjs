#!/usr/bin/env node
// Renders docs/demo/slides.html to docs/demo/slide-1.png ... slide-7.png (1920x1080) with headless Edge or Chrome.
//   node docs/demo/render.mjs            # all slides
//   node docs/demo/render.mjs 3 5        # only slides 3 and 5
// Browser path: BROWSER env var, else the usual Edge/Chrome install locations.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.error('No Edge/Chrome found. Set BROWSER=/path/to/chrome');
  process.exit(1);
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'firecal-slides-'));
const slides = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1, 2, 3, 4, 5, 6, 7];
const page = pathToFileURL(path.join(here, 'slides.html')).href;

for (const n of slides) {
  const out = path.join(here, `slide-${n}.png`);
  execFileSync(browser, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--allow-file-access-from-files',
    '--window-size=1920,1080',
    '--virtual-time-budget=8000',
    `--screenshot=${out}`,
    `${page}?n=${n}`,
  ], { stdio: 'ignore' });
  console.log(`slide ${n} -> ${path.relative(process.cwd(), out)}`);
}
