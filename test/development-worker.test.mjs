/** @file Exercise automatic Dev selection/export with a disposable Git source and credential-rejecting Expo SDK fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { developmentPlan, developmentWorker } from '../src/development.mjs';
import { writeJson, readJson } from '../src/io.mjs';
import { config, repository, temporary } from './helpers.mjs';

test('automatic worker exports only changed mobile inputs and restores selection outputs on a job retry', async t => {
  const repo = repository(t), cfg = config(), toolkit = 'b'.repeat(40), runtime = 'c'.repeat(40);
  delete cfg.mobile.platforms;
  cfg.development = { easProfile: 'development', environment: 'preview', approvalEnvironment: 'internal', channel: 'development',
    promotionEnvironment: 'beta', platforms: ['android', 'ios'], publicEnvironment: { EXPO_RELEASE_VARIANT: 'development' } };
  repo.save('release.config.json', JSON.stringify(cfg));
  repo.save('package.json', '{"private":true}');
  repo.save('eas.json', JSON.stringify({ build: { development: { developmentClient: true, distribution: 'internal', autoIncrement: false,
    environment: 'preview', env: cfg.development.publicEnvironment } } }));
  const expo = { owner: cfg.mobile.owner, slug: cfg.mobile.slug, android: { package: 'app.example.mobile.development' },
    runtimeVersion: { policy: 'fingerprint' }, extra: { eas: { projectId: cfg.mobile.projectId } } };
  repo.save('node_modules/expo/package.json', '{"name":"expo"}');
  repo.save('node_modules/expo-dev-client/package.json', '{"name":"expo-dev-client"}');
  repo.save('node_modules/expo-updates/package.json', '{"name":"expo-updates","version":"58.0.2"}');
  repo.save('node_modules/expo/bin/cli', `/** @file Reject source credentials and emit representative config or bundle bytes. */
const fs=require('fs'),path=require('path');
if(process.env.EXPO_TOKEN||process.env.GITHUB_TOKEN)throw new Error('Source received credentials');
if(process.argv[2]==='config')console.log(${JSON.stringify(JSON.stringify(expo))});
else {const directory=process.argv.at(-1);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'bundle.js'),'exported bytes');}
`);
  repo.save('node_modules/expo-updates/bin/cli', `/** @file Return a stable native runtime for source-only worker tests. */
console.log(JSON.stringify({runtimeVersion:${JSON.stringify(runtime)}}));
`);
  repo.save('app/main.js', 'first mobile source');
  const source = repo.commit(), cwd = process.cwd();
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: cfg.repository,
    GITHUB_SHA: source, TOOLKIT_SHA: toolkit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RELEASE_REUSE: 'false',
    EXPO_TOKEN: 'must-not-reach-source', GITHUB_TOKEN: 'must-not-reach-source', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => { process.chdir(cwd); for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  Object.assign(process.env, env);
  const plan = developmentPlan(cfg, { repository: cfg.repository, source, toolkit, run: '123' },
    { operation: 'auto', platform: 'android', attempt: '1', channel: 'development' });
  plan.environment = {};
  let history = {};
  for (const changed of [true, false]) {
    const job = temporary(t); process.chdir(job);
    process.env.GITHUB_OUTPUT = path.join(job, 'outputs'); process.env.GITHUB_STEP_SUMMARY = path.join(job, 'summary');
    writeJson('state/development.json', { ...plan, history });
    await developmentWorker('export', repo.root, path.join(job, 'state'));
    const selected = readJson('artifacts/development-plan.json');
    assert.equal(selected.buildRequired, changed); assert.equal(selected.updateRequired, changed);
    assert.equal(fs.existsSync('artifacts/development/bundle.js'), changed);
    history = { build: { input: selected.runtime }, update: { input: selected.bundle } };
    process.env.RELEASE_REUSE = 'true';
    await developmentWorker('export', repo.root, path.join(job, 'state'));
    assert.equal(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), `build=${changed}\nupdate=${changed}\nbuild=${changed}\nupdate=${changed}\n`);
    process.env.RELEASE_REUSE = 'false';
  }
});
