/** @file Build commits, retry plan reuse, serverless configuration and unsafe preparation rejection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, hook, exportBundle } from '../src/consumer/source.mjs';
import { configured, loadConfig } from '../src/consumer/config.mjs';
import { selectRelease } from '../src/engine.mjs';
import { run, writeJson, sourceEnvironment, readJson } from '../src/io.mjs';
import { fileURLToPath } from 'node:url';
import { repository, config, observation, temporary, plan } from './helpers.mjs';

/** Prepare a server-only source fixture so commit behavior needs no provider or Expo installation. */
function source(t, unsafe = false) {
  const repo = repository(t), value = config(); delete value.mobile;
  value.metadataFiles = ['version.json']; value.hooks = { prepare: [process.execPath, 'prepare.mjs'] };
  repo.save('server/main.js', 'source'); repo.save('version.json', '{"version":"1.2.3"}');
  repo.save('prepare.mjs', `/** @file Test-only metadata hook. */
import fs from 'node:fs';
const {plan}=JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync('${unsafe ? 'server/main.js' : 'version.json'}',JSON.stringify({version:plan.versions.server}));
console.log('{}');
`);
  const commit = repo.commit(); const branch = repo.git(['branch', '--show-current']); repo.git(['checkout', '--detach', '-q', commit]);
  const context = { source: commit, run:'123', toolkit:'c'.repeat(40), history:{}, environments:{production:{}} };
  return { ...repo, config:value, context, branch };
}

test('versions are stamped into a child commit while the default branch stays unchanged', t => {
  const repo = source(t);
  const result = prepare(repo.root,repo.config,repo.context,'production',false);
  assert.notEqual(result.build,repo.context.source); assert.equal(repo.git(['rev-parse',`${result.build}^`]),repo.context.source);
  assert.equal(repo.git(['rev-parse',repo.branch]),repo.context.source);
  assert.equal(repo.git(['show',`${result.build}:version.json`]),'{"version":"1.2.4"}');
  assert.equal(repo.git(['show',`${repo.context.source}:version.json`]),'{"version":"1.2.3"}');
  assert.equal(repo.git(['diff','--name-only',repo.context.source,result.build]),'version.json');
});

test('a retried preparation restores the exact build commit and versions without invoking source hooks', t => {
  const root = temporary(t), state = temporary(t), value = plan();
  delete value.config.mobile.platforms;
  value.config.install = [['must-not-execute']];
  value.config.hooks = { prepare: ['must-not-execute'] };
  writeJson(path.join(root, 'release.config.json'), value.config);
  writeJson(path.join(state, 'plan.json'), value);
  fs.writeFileSync(path.join(state, 'build.bundle'), 'original immutable bundle');
  const output = path.join(state, 'outputs');
  const env = { ...sourceEnvironment(), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: value.repository, GITHUB_SHA: value.source, TOOLKIT_SHA: value.toolkit, GITHUB_RUN_ID: value.run,
    GITHUB_RUN_ATTEMPT: '2', RELEASE_PROFILE: value.profile, RELEASE_REUSE: 'true', RELEASE_REBUILD: 'true', GITHUB_OUTPUT: output };
  for (const phase of ['install', 'prepare']) run(process.execPath, [fileURLToPath(new URL('../bin/worker.mjs', import.meta.url)), phase, root, state], { env });
  assert.deepEqual(readJson(path.join(state, 'plan.json')), value);
  assert.equal(fs.readFileSync(path.join(state, 'build.bundle'), 'utf8'), 'original immutable bundle');
  assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`build=${value.build}`));
  value.run = 'other'; writeJson(path.join(state, 'plan.json'), value);
  assert.throws(() => run(process.execPath, [fileURLToPath(new URL('../bin/worker.mjs', import.meta.url)), 'prepare', root, state], { env, stdio: 'pipe' }));
});

test('preparation cannot change application code or publish from an attached branch', t => {
  const repo = source(t,true);
  assert.throws(() => prepare(repo.root,repo.config,repo.context,'production',false), /outside declared metadata/);
  assert.equal(repo.git(['rev-parse','HEAD']),repo.context.source);
  repo.git(['checkout','--','server/main.js']); repo.git(['checkout','-q',repo.branch]);
  assert.throws(() => prepare(repo.root,repo.config,repo.context,'production',false), /clean detached/);
});

test('selected source identity and clean checkout are required before hooks execute', t => {
  const repo = source(t);
  assert.throws(() => prepare(repo.root,repo.config,{...repo.context,source:'d'.repeat(40)},'production',false), /selected source/);
  repo.save('server/main.js','uncommitted');
  assert.throws(() => prepare(repo.root,repo.config,repo.context,'production',false), /clean detached/);
});

test('application hook receives only JSON request data and public source environment', t => {
  const root = temporary(t); fs.writeFileSync(path.join(root,'hook.mjs'), `/** @file Test credential boundary. */
import fs from 'node:fs';console.log(JSON.stringify({request:JSON.parse(fs.readFileSync(0,'utf8')),token:process.env.EXPO_TOKEN,public:process.env.PUBLIC_ORIGIN}));`);
  const previous = process.env.EXPO_TOKEN; process.env.EXPO_TOKEN='secret-sentinel';
  try {
    const result=hook(root,{hooks:{inspect:[process.execPath,'hook.mjs']}},'inspect',{source:'commit'},{PUBLIC_ORIGIN:'test'});
    assert.equal(result.request.action,'inspect'); assert.equal(result.request.source,'commit');
    assert.equal(result.token,undefined); assert.equal(result.public,'test');
  } finally { if(previous===undefined)delete process.env.EXPO_TOKEN;else process.env.EXPO_TOKEN=previous; }
});

test('minimal serverless Expo fixture selects only its enabled Android release path', () => {
  const root = new URL('../examples/expo-only/',import.meta.url);
  const value=configured(loadConfig(root.pathname.replace(/^\/([A-Z]:)/,'$1')));
  const input=observation();input.fingerprints.beta={android:'a'.repeat(40)};
  const result=selectRelease(value,'beta',input);
  assert.equal(result.server,false);assert.equal(result.versions.mobile,'1.0.0');assert.deepEqual(result.operations,['beta/build/android']);
});

test('OTA inspection and export use the same explicit profile/platform with no publishing token', t => {
  const repo = repository(t), release = plan(), output = path.join(repo.root, 'export');
  const expo = { owner: 'owner', slug: 'app', version: '1.0.0', runtimeVersion: '1',
    extra: { eas: { projectId: release.config.mobile.projectId } }, android: { package: 'app.example.mobile' } };
  repo.save('package.json', '{"private":true}');
  repo.save('node_modules/expo/package.json', '{"name":"expo"}');
  repo.save('node_modules/expo-updates/package.json', '{"name":"expo-updates","version":"57.0.8"}');
  repo.save('node_modules/expo/bin/cli', `/** @file Test SDK executable boundary. */
const fs=require('node:fs'),path=require('node:path');
if(process.env.EAS_BUILD_PLATFORM!=='android'||process.env.EAS_BUILD_PROFILE!=='production'||process.env.EXPO_TOKEN)throw Error('wrong source environment');
if(process.argv[2]==='config')console.log(JSON.stringify(${JSON.stringify(expo)}));
else { const directory=process.argv[process.argv.indexOf('--output-dir')+1];fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'bundle.js'),'exact bundle'); }
`);
  repo.save('node_modules/@expo/fingerprint/package.json', '{"name":"@expo/fingerprint","main":"index.js"}');
  repo.save('node_modules/@expo/fingerprint/index.js', `/** @file Test SDK fingerprint boundary. */
exports.createFingerprintAsync=async()=>({hash:'${'a'.repeat(40)}'});`);
  const previous = process.env.EXPO_TOKEN; process.env.EXPO_TOKEN = 'publication-secret';
  try {
    exportBundle(repo.root, release, 'android', output);
    assert.equal(fs.readFileSync(path.join(output, 'bundle.js'), 'utf8'), 'exact bundle');
    const metadata = JSON.parse(fs.readFileSync(path.join(output, 'expo-release.json')));
    assert.equal(metadata.runtime, '1'); assert.equal(metadata.version, '1.0.0');
  } finally { if (previous === undefined) delete process.env.EXPO_TOKEN; else process.env.EXPO_TOKEN = previous; }
});
