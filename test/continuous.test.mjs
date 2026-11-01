/** @file Verify conditional Dev preparation, independent successful baselines, retry isolation and the beta promotion barrier. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { developmentScope, developmentHistory, selectDevelopment, performDevelopment } from '../src/development-history.mjs';
import { verifyPromotionEnvironments } from '../src/continuous.mjs';
import { config } from './helpers.mjs';

/** Return a source-bound automatic development candidate. */
function candidate() {
  const value = config();
  value.development = { channel: 'development', promotionEnvironment: 'beta', easProfile: 'development', environment: 'preview' };
  return { config: value, platform: 'android', source: 'a'.repeat(40), toolkit: 'b'.repeat(40), run: '1', runtime: 'native-A', bundle: 'bundle-A' };
}

/** Model GitHub deployment intents and confirmed statuses without executing provider operations. */
function provider() {
  const records = [], statuses = new Map();
  return { records, statuses,
    /** List newest deployments first, as the GitHub API does. */
    async pages() { return records.toReversed(); },
    /** Create operation intents or read/write their confirmed provider status. */
    async api(method, route, body) {
      if (route === 'deployments') { const record = { id: records.length + 1, ...body }; records.push(record); return record; }
      const id = Number(route.split('/')[1]);
      if (method === 'GET') return statuses.has(id) ? [statuses.get(id)] : [];
      statuses.set(id, body); return body;
    }
  };
}

test('first native inputs build and publish, JS-only changes publish, and unchanged mobile inputs do neither', () => {
  const history = { build: { input: 'native-A' }, update: { input: 'bundle-A' } };
  assert.deepEqual(selectDevelopment('native-A', 'bundle-A'), { build: true, update: true });
  assert.deepEqual(selectDevelopment('native-A', 'bundle-A', history), { build: false, update: false });
  assert.deepEqual(selectDevelopment('native-A', 'bundle-B', history), { build: false, update: true });
  assert.deepEqual(selectDevelopment('native-B', 'bundle-A', history), { build: true, update: true });
  assert.deepEqual(selectDevelopment('native-A', 'bundle-A', { build: history.build }), { build: false, update: true });
});

test('confirmed native success survives OTA failure and does not block a fresh candidate', async () => {
  const client = provider(), plan = candidate();
  await performDevelopment(client, plan, 'build', async () => 'https://expo.dev/builds/client', '1');
  await assert.rejects(performDevelopment(client, plan, 'update', async () => { throw new Error('lost acknowledgement'); }, '1'), /lost acknowledgement/);
  await assert.rejects(performDevelopment(client, plan, 'update', async () => assert.fail('duplicate'), '1'), /already attempted/);
  const history = await developmentHistory(client, plan);
  assert.equal(history.build.input, 'native-A'); assert.equal(history.update, undefined);
  assert.deepEqual(selectDevelopment(plan.runtime, plan.bundle, history), { build: false, update: true });
  const fresh = { ...plan, run: '2' };
  await performDevelopment(client, fresh, 'update', async () => 'https://expo.dev/updates/latest', '1');
  assert.deepEqual(selectDevelopment(plan.runtime, plan.bundle, await developmentHistory(client, fresh)), { build: false, update: false });
  assert.deepEqual(await developmentHistory(client, { ...plan, platform: 'ios' }), {});
});

test('job retries reuse confirmed operations and only repeat an unconfirmed operation in a later attempt', async () => {
  const client = provider(), plan = candidate();
  let calls = 0;
  /** Count provider executions so successful retries cannot enqueue another client. */
  const execute = async () => { calls++; return 'https://expo.dev/builds/client'; };
  await performDevelopment(client, plan, 'build', execute, '1');
  assert.equal(await performDevelopment(client, plan, 'build', execute, '2'), 'https://expo.dev/builds/client');
  assert.equal(calls, 1);
  await assert.rejects(performDevelopment(client, { ...plan, runtime: 'changed' }, 'build', execute, '2'), /identity changed/);
  await assert.rejects(performDevelopment(client, plan, 'update', async () => { throw new Error('network'); }, '1'));
  await performDevelopment(client, plan, 'update', async () => 'https://expo.dev/updates/retry', '2');
  assert.equal((await developmentHistory(client, plan)).update.input, plan.bundle);
  assert.notEqual(developmentScope(plan), developmentScope({ ...plan, platform: 'ios' }));
});

test('promotion requires actual reviewers while development runs without reviewer approval', () => {
  const gated = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }] };
  verifyPromotionEnvironments(gated, { protection_rules: [] });
  for (const invalid of [undefined, {}, { protection_rules: [] }, { protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }])
    assert.throws(() => verifyPromotionEnvironments(invalid, {}), /required reviewers/);
  assert.throws(() => verifyPromotionEnvironments(gated, gated), /reviewer-free/);
});

test('development succeeds before the approval gate and no beta/server job can bypass approval or a failed platform', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const jobs = workflow.jobs;
  assert.equal(workflow.concurrency, undefined, 'Waiting for beta must not block newer Dev candidates.');
  assert.equal(jobs.development.with.operation, 'auto');
  assert.equal(jobs.development.strategy['fail-fast'], false);
  assert.deepEqual(jobs['approve-beta'].needs, ['context', 'development']);
  assert.equal(jobs['approve-beta'].environment.name, '${{ needs.context.outputs.approval }}');
  assert.equal(jobs.delivery.uses, './.github/workflows/delivery.yml');
  const allowed = new Function('needs', 'cancelled', `return (${jobs.delivery.if.replaceAll('needs.approve-beta', 'needs.approval')});`);
  for (const continuous of [true, false]) for (const context of ['success', 'failure']) for (const development of ['success', 'failure', 'cancelled', 'skipped'])
    for (const approval of ['success', 'failure', 'cancelled', 'skipped']) for (const cancelled of [false, true]) {
      assert.equal(allowed({ context: { result: context, outputs: { continuous: String(continuous) } }, development: { result: development }, approval: { result: approval } }, () => cancelled),
        !cancelled && context === 'success' && (continuous ? development === 'success' && approval === 'success' : development === 'skipped' && approval === 'skipped'));
    }
  const delivery = YAML.parse(fs.readFileSync(new URL('../.github/workflows/delivery.yml', import.meta.url), 'utf8'));
  assert.deepEqual(delivery.concurrency, { group: 'expo-release', 'cancel-in-progress': false, queue: 'max' });
  assert.ok(delivery.jobs.context.steps.some(step => step.run?.includes('worker.mjs context')), 'Read current successful release baselines only after approval.');
});
