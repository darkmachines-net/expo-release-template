/** @file Verify cross-commit Dev client reuse, native identity isolation, provider recovery and explicit build semantics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { developmentBuild, verifyDevelopmentBuild } from '../src/development-build.mjs';
import { publishDevelopment } from '../src/development.mjs';
import { performDevelopment } from '../src/development-history.mjs';
import { config, temporary } from './helpers.mjs';
import { readJson, writeJson, seal } from '../src/io.mjs';

/** Pair a new OTA source with an older compatible EAS client. */
function fixture() {
  const cfg = config(), runtime = 'c'.repeat(40), applicationId = 'app.example.mobile.development';
  cfg.development = { easProfile: 'development', environment: 'preview', channel: 'development' };
  const plan = { config: cfg, repository: cfg.repository, operation: 'auto', platform: 'android', source: 'a'.repeat(40),
    toolkit: 'b'.repeat(40), run: '1', runtime, bundle: 'd'.repeat(64), buildRequired: true, channel: 'development', workflowSource: 'a'.repeat(40) };
  const info = { app: 'source-app', env: {}, applicationId, runtimeVersion: runtime,
    expo: { android: { package: applicationId }, ios: { bundleIdentifier: applicationId }, runtimeVersion: runtime, extra: { eas: { projectId: cfg.mobile.projectId } } } };
  const build = { id: 'existing', status: 'FINISHED', app: { id: cfg.mobile.projectId }, gitCommitHash: 'e'.repeat(40),
    appIdentifier: applicationId, buildProfile: 'development', platform: 'ANDROID', distribution: 'INTERNAL',
    runtime: { version: runtime }, fingerprint: { hash: runtime } };
  return { plan, info, build };
}

for (const platform of ['android', 'ios']) test(`${platform} reuses a compatible older commit and publishes the new commit's sealed OTA`, async t => {
  const { plan, info, build } = fixture(); plan.platform = platform; build.platform = platform.toUpperCase();
  let inert;
  const result = await developmentBuild(info, plan, (args, cwd) => {
    assert.equal(args[0], 'build:list'); assert.equal(args.includes('--git-commit-hash'), false);
    assert.equal(args[args.indexOf('--fingerprint-hash') + 1], info.runtimeVersion);
    assert.equal(args[args.indexOf('--runtime-version') + 1], info.runtimeVersion);
    assert.notEqual(cwd, info.app); inert = cwd;
    assert.equal(readJson(path.join(cwd, 'app.json')).expo.extra.eas.projectId, plan.config.mobile.projectId);
    return [build];
  });
  assert.equal(result, build); assert.equal(fs.existsSync(inert), false);
  const directory = temporary(t);
  writeJson(path.join(directory, 'development.json'), { platform, expo: info.expo, updatesVersion: '58.0.2' });
  fs.writeFileSync(path.join(directory, 'bundle.js'), 'new commit bundle'); seal(directory, plan, 'development');
  publishDevelopment(plan, directory, args => {
    assert.equal(args[args.indexOf('--message') + 1], `preview:${plan.source}`);
    return [{ group: 'current-source', platform, runtimeVersion: info.runtimeVersion }];
  }, result);
});

test('incompatible, expired and unsuccessful clients cannot suppress a fresh build', async () => {
  const { plan, info, build } = fixture();
  const changes = [{ status: 'ERRORED' }, { status: 'CANCELED' }, { status: 'PENDING_CANCEL' }, { expirationDate: '2000-01-01' },
    { app: { id: 'other' } }, { appIdentifier: 'app.example.mobile' }, { buildProfile: 'beta' }, { platform: 'IOS' },
    { distribution: 'STORE' }, { isForIosSimulator: true }, { runtime: { version: 'f'.repeat(40) } }, { fingerprint: { hash: 'f'.repeat(40) } }];
  const calls = [], finished = { ...build, id: 'new', gitCommitHash: plan.source };
  const result = await developmentBuild(info, plan, (args, cwd) => {
    calls.push(args[0]);
    if (args[0] === 'build:list') return changes.map(change => ({ ...build, ...change }));
    if (args[0] === 'build') { assert.equal(cwd, info.app); assert.ok(args.includes('--no-wait')); return [{ id: 'new' }]; }
    assert.equal(args[1], 'new'); return finished;
  });
  assert.equal(result, finished); assert.deepEqual(calls, ['build:list', 'build', 'build:view']);
});

test('matching in-progress clients are awaited without submitting another build', async () => {
  const { plan, info, build } = fixture(); let reads = 0, waits = 0;
  const result = await developmentBuild(info, plan, args => {
    if (args[0] === 'build:list') return [{ ...build, status: 'IN_PROGRESS' }];
    assert.equal(args[0], 'build:view'); return ++reads === 1 ? { ...build, status: 'IN_PROGRESS' } : build;
  }, async milliseconds => { assert.equal(milliseconds, 15000); waits++; });
  assert.equal(result, build); assert.equal(waits, 1);
});

test('finished clients on later pages take precedence over pending clients', async () => {
  const { plan, info, build } = fixture(); let pages = 0;
  assert.equal(await developmentBuild(info, plan, args => {
    assert.equal(args[0], 'build:list'); assert.equal(args[args.indexOf('--offset') + 1], String(pages * 50));
    return ++pages === 1 ? Array.from({ length: 50 }, () => ({ ...build, status: 'IN_QUEUE' })) : [build];
  }), build);
  assert.equal(pages, 2);
});

test('failed provider reads and malformed lists stop without requesting a build', async () => {
  const { plan, info } = fixture();
  for (const response of [null, { error: 'unauthorized' }, new Error('offline')]) {
    await assert.rejects(developmentBuild(info, plan, args => {
      assert.equal(args[0], 'build:list'); if (response instanceof Error) throw response; return response;
    }), /Malformed|offline/);
  }
});

test('explicit builds and newly created automatic clients retain exact-source verification', async () => {
  const { plan, info, build } = fixture();
  for (const operation of ['auto', 'build']) {
    let creates = 0;
    await assert.rejects(developmentBuild(info, { ...plan, operation }, args => {
      if (args[0] === 'build:list') { assert.equal(operation, 'auto'); return []; }
      if (args[0] === 'build') { creates++; return [{ id: build.id }]; }
      return build;
    }), /identity or preview runtime/);
    assert.equal(creates, 1);
  }
  assert.throws(() => verifyDevelopmentBuild(build, { ...plan, operation: 'build' }, info.expo), /identity or preview runtime/);
});

test('a lost GitHub success write recovers the completed EAS client on retry without another build', async () => {
  const { plan, info, build } = fixture(); const records = []; let failStatus = true, lists = 0;
  const client = {
    /** Return intents, including the operation whose status write was lost. */
    async pages() { return records; },
    /** Persist intents while simulating an unacknowledged first success status. */
    async api(method, route, body) {
      if (route === 'deployments') { const record = { id: records.length + 1, ...body }; records.push(record); return record; }
      if (method === 'GET') return [];
      if (failStatus) { failStatus = false; throw new Error('lost success write'); }
      assert.equal(body.state, 'success');
    }
  };
  /** Recover directly from EAS even when the GitHub baseline is absent. */
  const execute = async () => {
    const result = await developmentBuild(info, plan, args => { assert.equal(args[0], 'build:list'); lists++; return [build]; });
    return `https://expo.dev/builds/${result.id}`;
  };
  await assert.rejects(performDevelopment(client, plan, 'build', execute, '1'), /lost success write/);
  await assert.rejects(performDevelopment(client, plan, 'build', execute, '1'), /already attempted/);
  await performDevelopment(client, plan, 'build', execute, '2');
  assert.equal(lists, 2);
});
