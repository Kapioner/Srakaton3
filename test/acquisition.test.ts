import assert from 'node:assert/strict';
import test from 'node:test';
import { AcquisitionController } from '../src/live/modeController.js';
import { PollingScheduler } from '../src/live/scheduler.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A task that takes `ms` and counts runs and the peak number of concurrent runs. */
function slowTask(ms: number) {
  const stats = { runs: 0, active: 0, maxActive: 0 };
  const task = async () => {
    stats.runs++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    await sleep(ms);
    stats.active--;
  };
  return { task, stats };
}

test('realtime polls repeatedly; archive and forecast stop it; realtime resumes at once', async () => {
  const { task, stats } = slowTask(5);
  const scheduler = new PollingScheduler(task, async () => 20);
  const controller = new AcquisitionController(scheduler, null);

  controller.start();
  await sleep(80);
  assert.ok(stats.runs >= 3, `polled ${stats.runs} times`);

  assert.equal(controller.setMode('archive').acquiring, false);
  await sleep(10); // let the run in flight finish
  const frozen = stats.runs;
  await sleep(80);
  assert.equal(stats.runs, frozen, 'no runs while browsing the archive');

  controller.setMode('forecast');
  await sleep(50);
  assert.equal(stats.runs, frozen, 'no runs while using the forecast');

  assert.equal(controller.setMode('realtime').acquiring, true);
  await sleep(2);
  assert.equal(stats.runs, frozen + 1, 'resuming fetches immediately');
  controller.shutdown();
});

test('rapid mode switching never runs two loops at once', async () => {
  const { task, stats } = slowTask(15);
  const scheduler = new PollingScheduler(task, async () => 5);
  const controller = new AcquisitionController(scheduler, null);
  controller.start();
  for (let i = 0; i < 20; i++) {
    controller.setMode(i % 2 ? 'realtime' : 'archive');
    controller.refreshNow();
    await sleep(3);
  }
  controller.setMode('realtime');
  await sleep(100);
  assert.equal(stats.maxActive, 1);
  controller.shutdown();
});

test('a forgotten pause falls back to realtime', async () => {
  const { task, stats } = slowTask(1);
  const scheduler = new PollingScheduler(task, async () => 60_000);
  const controller = new AcquisitionController(scheduler, null);
  controller.start();
  await sleep(5);

  // resumeAfterMinutes is in minutes; 0.001 min = 60 ms keeps the test fast.
  const paused = controller.setMode('archive', 0.001);
  assert.ok(paused.resumeAt);
  const runs = stats.runs;
  await sleep(120);
  assert.equal(controller.current.mode, 'realtime');
  assert.equal(stats.runs, runs + 1);
  controller.shutdown();
});
