/** @file Verify immutable source resolution, preview isolation, native variants, exact publication and separate store destinations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { developmentPlan, developmentProvider, resolveDevelopmentSource, developmentWorker, verifyDevelopmentProfile, publishDevelopment } from '../src/development.mjs';
import { seal, writeJson, readJson } from '../src/io.mjs';
import { submit } from '../src/eas.mjs';
import { localPreviewPlan, preview } from '../src/preview.mjs';
import { config, plan, temporary, repository } from './helpers.mjs';
const { developmentConfig } = createRequire(import.meta.url)('../src/consumer/expo.cjs');

/** Return an isolated development configuration sharing only its EAS project with store releases. */
function fixture() {
  const value = config();
  value.development = { easProfile: 'development', environment: 'preview', approvalEnvironment: 'preview',
    platforms: ['android', 'ios'], publicEnvironment: { EXPO_RELEASE_VARIANT: 'development' } };
  return value;
}

test('development plans target an explicit source and unique branch without release operations', () => {
  const value = fixture(), identity = { source: 'a'.repeat(40), toolkit: 'b'.repeat(40), run: '123', repository: value.repository };
  const preview = developmentPlan(value, identity, { source: 'c'.repeat(40), operation: 'update', platform: 'android', attempt: '2' });
  assert.equal(preview.branch, 'preview-123-2'); assert.equal(preview.source, 'c'.repeat(40));
  assert.equal(preview.versions, undefined); assert.equal(preview.operations, undefined);
  assert.equal(developmentProvider(value).profiles.development.channel, undefined);
  assert.equal(value.profiles.development, undefined);
  for (const change of [{ source: 'main' }, { operation: 'submit' }, { platform: 'web' }, { attempt: '0' }])
    assert.throws(() => developmentPlan(value, identity, { operation: 'build', platform: 'android', attempt: '1', ...change }));
});

test('development changes installed identity and uses fingerprint previews without changing release config', () => {
  const original = { name: 'App', slug: 'example', scheme: 'app', android: { package: 'app.example', intentFilters: [{}] },
    ios: { bundleIdentifier: 'app.example', associatedDomains: ['applinks:example.test'] },
    runtimeVersion: '3', updates: { url: 'https://example.test', requestHeaders: { 'expo-channel-name': 'beta', custom: 'kept' } } };
  assert.equal(developmentConfig(original, {}), original);
  const dev = developmentConfig(original, { EXPO_RELEASE_VARIANT: 'development' });
  assert.equal(dev.android.package, 'app.example.development'); assert.equal(dev.ios.bundleIdentifier, 'app.example.development');
  assert.equal(dev.scheme, 'example-dev'); assert.deepEqual(dev.runtimeVersion, { policy: 'fingerprint' });
  assert.deepEqual(dev.updates.requestHeaders, { custom: 'kept' });
  assert.equal(original.updates.requestHeaders['expo-channel-name'], 'beta');
  assert.deepEqual(dev.android.intentFilters, []); assert.deepEqual(dev.ios.associatedDomains, []);
});

test('development rejects store, channel, version and native platform overrides', () => {
  const spec = fixture().development;
  const profile = { developmentClient: true, distribution: 'internal', autoIncrement: false, environment: 'preview', env: spec.publicEnvironment };
  verifyDevelopmentProfile({ build: { development: profile } }, spec);
  for (const change of [{ channel: 'production' }, { distribution: 'store' }, { developmentClient: false }, { autoIncrement: true },
    { extends: 'production' }, { env: { EXPO_RELEASE_VARIANT: 'production' } }, { android: { gradleCommand: ':app:bundleRelease' } }])
    assert.throws(() => verifyDevelopmentProfile({ build: { development: { ...profile, ...change } } }, spec));
});

test('preview publishes verified bytes to its branch from an inert project and rejects tampering', t => {
  const cfg = fixture(), directory = path.join(temporary(t), 'bundle');
  const value = developmentPlan(cfg, { source: 'a'.repeat(40), toolkit: 'b'.repeat(40), run: '123', repository: cfg.repository },
    { operation: 'update', platform: 'android', attempt: '1' });
  const runtime = 'c'.repeat(40);
  writeJson(path.join(directory, 'development.json'), { platform: 'android', updatesVersion: '58.0.2',
    expo: { android: { package: 'app.example.mobile.development' }, runtimeVersion: runtime, extra: { eas: { projectId: cfg.mobile.projectId } }, plugins: ['untrusted-plugin'] } });
  fs.writeFileSync(path.join(directory, 'bundle.js'), 'preview bytes'); seal(directory, value, 'development');
  let calls = 0;
  publishDevelopment(value, directory, (args, root) => {
    calls++; assert.equal(args[args.indexOf('--branch') + 1], 'preview-123-1');
    assert.ok(!args.includes('--channel')); assert.ok(args.includes('--skip-bundler'));
    assert.equal(readJson(path.join(root, 'app.json')).expo.plugins, undefined);
    return [{ group: 'group', platform: 'android', runtimeVersion: runtime }];
  });
  assert.equal(calls, 1); fs.appendFileSync(path.join(directory, 'bundle.js'), 'tampered');
  assert.throws(() => publishDevelopment(value, directory, () => { throw new Error('must not publish'); }), /identity|digest/);
});

test('paired beta and production submissions select their own destination profiles', async () => {
  const value = plan(), target = { id: 'phone', platform: 'android', applicationId: 'app.example.mobile', submitProfile: 'legacy' };
  value.config.profiles.production.submitProfiles = { phone: 'phone-production' };
  const profiles = { legacy: { android: { track: 'internal' } }, 'phone-production': { android: { track: 'production', releaseStatus: 'draft' } } };
  await submit(value, target, { file: 'phone.aab' }, profiles, args => {
    assert.equal(args[args.indexOf('--profile') + 1], 'phone-production');
    return 'https://expo.dev/accounts/owner/projects/app/submissions/12345678-1234-1234-1234-123456789012';
  });
});

test('preview workflow exports without credentials and has no release, deployment or submission path', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/development.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(!JSON.stringify(workflow.jobs.export).includes('secrets.'));
  assert.ok(!JSON.stringify(workflow.jobs.publish).includes('development.mjs install'));
  assert.deepEqual(workflow.jobs.publish.needs, ['context', 'export']);
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    assert.ok(!/worker.mjs|eas submit|eas channel|git push/.test(step.run ?? ''));
    if (step.uses?.includes('download-artifact')) assert.equal(step.with['run-id'], undefined);
  }
});

test('local previews admit uncommitted work without allowing a beta or production destination', () => {
  const first = localPreviewPlan(fixture(), { source: 'a'.repeat(40), dirty: true, platform: 'android' });
  const second = localPreviewPlan(fixture(), { source: 'a'.repeat(40), dirty: true, platform: 'android' });
  assert.equal(first.dirty, true); assert.match(first.branch, /^preview-/); assert.notEqual(first.branch, second.branch);
  assert.equal(first.channel, undefined); assert.equal(first.versions, undefined);
  assert.throws(() => localPreviewPlan(fixture(), { source: 'a'.repeat(40), platform: 'web' }));
});

test('local export failure or changed native inputs cannot publish and temporary bytes are removed', t => {
  const repo = repository(t), cfg = fixture(); delete cfg.mobile.platforms;
  repo.save('release.config.json', JSON.stringify(cfg)); repo.commit(); repo.save('change.js', 'uncommitted');
  for (const mode of ['export-fails', 'native-changes', 'success']) {
    let reads = 0, published = 0, directory;
    const adapters = {
      /** Return reproducible public values without any remote call. */
      environments() { return { development: cfg.development.publicEnvironment }; },
      /** Simulate the native fingerprint before and after export. */
      inspect() { reads++; return { app: repo.root, cli: 'expo', env: {}, expo: {}, updatesVersion: '58.0.1',
        runtimeVersion: mode === 'native-changes' && reads > 1 ? 'changed' : 'original' }; },
      /** Write representative export bytes or fail before publication. */
      execute(_command, args) {
        directory = args.at(-1); fs.writeFileSync(path.join(directory, 'bundle.js'), 'preview');
        if (mode === 'export-fails') throw new Error('export failed');
      },
      /** Accept only the explicit dirty working-copy identity and sealed output. */
      publish(value, output) {
        published++; assert.equal(value.dirty, true); assert.match(value.branch, /^preview-/);
        assert.ok(fs.existsSync(output + '.json')); return { group: 'test' };
      }
    };
    if (mode === 'success') preview(repo.root, 'android', adapters);
    else assert.throws(() => preview(repo.root, 'android', adapters), /export failed|Native inputs changed/);
    assert.equal(published, mode === 'success' ? 1 : 0);
    assert.ok(!fs.existsSync(directory)); assert.ok(!fs.existsSync(directory + '.json'));
  }
});

test('source branches resolve from origin without local or tag ambiguity; full SHAs and blank input remain supported', t => {
  const repo = repository(t);
  repo.save('app.txt', 'original'); const original = repo.commit();
  repo.git(['update-ref', 'refs/remotes/origin/feature/audio', original]);
  repo.save('app.txt', 'local'); const local = repo.commit();
  repo.git(['branch', 'feature/audio', local]); repo.git(['tag', 'feature/audio', local]);
  repo.git(['tag', 'tag-only', local]);
  assert.equal(resolveDevelopmentSource(repo.root, ' feature/audio ', local), original);
  assert.equal(resolveDevelopmentSource(repo.root, original, local), original);
  assert.equal(resolveDevelopmentSource(repo.root, original.toUpperCase(), local), original);
  assert.equal(resolveDevelopmentSource(repo.root, '', local), local);
  for (const input of ['missing', 'tag-only', '../audio', 'feature/audio~1', '--help', 'a'.repeat(40)])
    assert.throws(() => resolveDevelopmentSource(repo.root, input, local), /existing branch.*full commit SHA/);
});

test('a retried context preserves its resolved commit when the source branch moves', async t => {
  const repo = repository(t), cfg = fixture(), toolkit = 'b'.repeat(40); delete cfg.mobile.platforms;
  repo.save('release.config.json', JSON.stringify(cfg));
  repo.save('package.json', JSON.stringify({ devDependencies: { '@mchartier/expo-release': 'git+https://github.com/darkmachines-net/expo-release-template.git#' + toolkit } }));
  repo.save('package-lock.json', JSON.stringify({ packages: { 'node_modules/@mchartier/expo-release': { resolved: 'git+https://github.com/darkmachines-net/expo-release-template.git#' + toolkit } } }));
  const source = repo.commit(); repo.git(['update-ref', 'refs/remotes/origin/feature/audio', source]);
  const state = temporary(t), env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: cfg.repository, GITHUB_SHA: source, TOOLKIT_SHA: toolkit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    PREVIEW_SOURCE: 'feature/audio', PREVIEW_OPERATION: 'build', PREVIEW_PLATFORM: 'android', RELEASE_REUSE: 'false', GITHUB_OUTPUT: path.join(state, 'outputs') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, env);
  await developmentWorker('context', repo.root, state);
  const first = readJson(path.join(state, 'development.json'));
  assert.equal(first.source, source); assert.equal(first.branch, 'preview-123-1');
  repo.save('app.txt', 'branch advances'); const newer = repo.commit();
  repo.git(['update-ref', 'refs/remotes/origin/feature/audio', newer]);
  process.env.RELEASE_REUSE = 'true'; process.env.GITHUB_RUN_ATTEMPT = '2';
  await developmentWorker('context', repo.root, state);
  assert.deepEqual(readJson(path.join(state, 'development.json')), first);
  assert.ok(fs.readFileSync(path.join(state, 'outputs'), 'utf8').trimEnd().endsWith('source=' + source));
});
