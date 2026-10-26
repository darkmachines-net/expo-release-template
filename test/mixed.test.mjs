/** @file Mixed Android/iOS builds preserve paired signing, counters, profile destinations and independent completion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, nativeMatrix, verifyCounters } from '../src/consumer/config.mjs';
import { nativeArtifacts } from '../src/worker.mjs';
import { commandBuild } from '../src/build.mjs';
import { verifyBuild, verifyBuildFloors, submit } from '../src/eas.mjs';
import { writeJson, seal } from '../src/io.mjs';
import { selectRelease } from '../src/engine.mjs';
import { config, plan, temporary } from './helpers.mjs';

/** Model Calibrate's command-built phone/watch pair and cloud-built iOS sibling. */
function mixed() {
  const value = config();
  value.mobile.builder = 'command'; value.mobile.pairCodeFloor = 18;
  value.mobile.targets = [
    ...['phone', 'wear'].map(id => ({ id, platform: 'android', applicationId: 'app.example.mobile' })),
    { id: 'ios', platform: 'ios', applicationId: 'app.example.ios', builder: 'eas', buildNumberFloor: 0 },
  ];
  value.hooks = Object.fromEntries(['buildPrepare', 'build', 'verify'].map(name => [name, ['node', 'hook.mjs']]));
  delete value.mobile.platforms;
  return value;
}

test('mixed builders use beta testing and production destinations from each profile', async () => {
  const value = plan({ config: mixed(), pair: [19,20] }), destinations = {};
  value.config.profiles.beta = { ...value.config.profiles.production, environment: 'preview', channel: 'beta', easProfile: 'beta' };
  for (const profile of ['beta','production']) {
    value.config.profiles[profile].submitProfiles = {};
    for (const target of value.config.mobile.targets) {
      const name = `${target.id}-${profile}`;
      value.config.profiles[profile].submitProfiles[target.id] = name;
      const track = profile === 'beta' ? 'internal' : 'production';
      destinations[name] = target.platform === 'ios' ? { ios: { ascAppId: '12345' } }
        : { android: { track: target.id === 'wear' ? `wear:${track}` : track, releaseStatus: profile === 'beta' ? 'completed' : 'draft' } };
    }
  }
  for (const profile of ['beta','production']) for (const target of value.config.mobile.targets) {
    const expected = `${target.id}-${profile}`;
    await submit({ ...value, profile }, target, target.platform === 'ios' ? { buildId: 'cloud-build' } : { file: `${target.id}.aab` }, destinations,
      (args, root) => {
        if (args[0] === 'submit:list') return [];
        assert.equal(args[args.indexOf('--profile')+1], expected);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'eas.json'))).submit[expected], destinations[expected]);
        assert.ok(args.includes(target.platform === 'ios' ? '--id' : '--path'));
        return 'https://expo.dev/accounts/owner/projects/app/submissions/12345678-1234-1234-1234-123456789012';
      });
  }
});

test('the matrix groups command builds and preserves independent cloud builds', t => {
  const root = temporary(t), value = mixed();
  writeJson(path.join(root, 'release.config.json'), value);
  assert.deepEqual(nativeMatrix(loadConfig(root)), [
    { id: 'pair', platform: 'android', builder: 'command' }, { ...value.mobile.targets[2], builder: 'eas' },
  ]);
  assert.deepEqual(nativeMatrix(config()).map(t => t.builder), ['eas', 'eas']);
  for (const mutate of [
    v => { v.mobile.targets[2].builder = 'command'; },
    v => { v.mobile.targets[0].id = 'pair'; },
    v => { v.mobile.targets[2].buildNumberFloor = 20; },
    v => { delete v.mobile.pairCodeFloor; },
    v => { delete v.hooks.verify; },
  ]) {
    const invalid = mixed(); mutate(invalid); writeJson(path.join(root, 'release.config.json'), invalid);
    assert.throws(() => loadConfig(root));
  }
});

test('mixed builds require reserved local counters and leave remote counters untouched', () => {
  const value = mixed(), eas = { cli: { appVersionSource: 'local' } }, profile = { autoIncrement: false };
  verifyCounters(value, eas, profile);
  verifyBuildFloors(value, () => { throw new Error('Remote counter should not be read'); });
  for (const invalid of [{ autoIncrement: true }, { autoIncrement: false, ios: { autoIncrement: 'buildNumber' } },
    { autoIncrement: false, android: { autoIncrement: true } }, {}]) assert.throws(() => verifyCounters(value, eas, invalid), /local reserved/);
  assert.throws(() => verifyCounters(value, { cli: { appVersionSource: 'remote' } }, profile), /local reserved/);
  assert.throws(() => verifyCounters(config(), eas, profile), /remote managed/);
});

test('the Android command hook seals only its pair, and incomplete pairs fail independently of iOS', t => {
  const root = temporary(t), artifacts = path.join(root, 'artifacts'), value = plan({ config: mixed(), pair: [19, 20] });
  value.config.hooks.build = [process.execPath, 'build.mjs']; delete value.config.hooks.verify;
  fs.writeFileSync(path.join(root, 'build.mjs'), `import fs from 'node:fs';import path from 'node:path';
    const request=JSON.parse(fs.readFileSync(0,'utf8'));
    if(process.env.EXPO_TOKEN)throw new Error('cloud credential leaked');
    for(const id of ['phone','wear']){const output=path.join(request.directory,id);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'native.aab'),'signed');}
    process.stdout.write(JSON.stringify({targets:['phone','wear']}));`);
  commandBuild(root, value, artifacts, { ANDROID_KEYSTORE_BASE64: Buffer.from('key').toString('base64'),
    ANDROID_STORE_PASSWORD: 'password', ANDROID_KEY_ALIAS: 'alias', ANDROID_KEY_PASSWORD: 'password', EXPO_TOKEN: 'cloud-secret' });
  assert.equal(fs.existsSync(path.join(artifacts, 'upload.keystore')), false);
  assert.deepEqual(nativeArtifacts(value, artifacts).map(t => t.id), ['phone', 'wear']);
  writeJson(path.join(artifacts, 'ios/build.json'), { id: 'cloud-build' }); seal(path.join(artifacts, 'ios'), value, 'ios');
  assert.deepEqual(nativeArtifacts(value, artifacts).map(t => t.id), ['phone', 'wear', 'ios']);
  fs.rmSync(path.join(artifacts, 'wear'), { recursive: true });
  fs.rmSync(path.join(artifacts, 'wear.json'));
  assert.throws(() => nativeArtifacts(value, artifacts), /incomplete/);
  fs.rmSync(path.join(artifacts, 'phone'), { recursive: true });
  fs.rmSync(path.join(artifacts, 'phone.json'));
  assert.deepEqual(nativeArtifacts(value, artifacts).map(t => t.id), ['ios']);
});

test('iOS EAS evidence must match the globally reserved phone code', () => {
  const value = plan({ config: mixed(), pair: [19, 20] }), target = value.config.mobile.targets[2];
  const build = { id: 'cloud', status: 'FINISHED', app: { id: value.config.mobile.projectId }, appIdentifier: target.applicationId,
    platform: 'IOS', gitCommitHash: value.build, buildProfile: 'production', appVersion: value.versions.mobile,
    appBuildVersion: '19', runtime: { version: value.runtime }, updateChannel: { name: 'production' },
    fingerprint: { hash: value.observation.fingerprints.production.ios } };
  assert.equal(verifyBuild(build, value, target), build);
  assert.throws(() => verifyBuild({ ...build, appBuildVersion: '18' }, value, target), /reserved phone code/);
});

test('internal and production keep separate successes while consuming one shared code sequence', () => {
  const value = mixed(); value.mobile.platforms = ['android', 'ios'];
  value.profiles.internal = { ...value.profiles.production, environment: 'preview', channel: 'internal', approvalEnvironment: 'preview' };
  const observation = plan().observation;
  observation.fingerprints.internal = observation.fingerprints.production;
  const history = { mobile: { version: '1.0.0', family: observation.family, pairCodeFloor: 24 }, baselines: {} };
  for (const target of value.mobile.targets) history.baselines[`production/build/${target.id}`] = { runtime: '1', fingerprint: observation.fingerprints.production[target.platform] };
  for (const platform of ['android', 'ios']) history.baselines[`production/js/${platform}`] = { input: observation.js[platform] };
  assert.equal(selectRelease(value, 'production', observation, history).native, false);
  const internal = selectRelease(value, 'internal', observation, history);
  assert.equal(internal.native, true); assert.deepEqual(internal.pair, [25, 26]);
  assert.ok(internal.operations.every(operation => operation.startsWith('internal/')));
});
