/** @file Check parallel artifact builds, server-gated client delivery, native credential boundaries and retry reuse. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/delivery.yml', import.meta.url), 'utf8'));
const setup = YAML.parse(fs.readFileSync(new URL('../.github/actions/setup/action.yml', import.meta.url), 'utf8'));
const jobs = workflow.jobs;

/** Read the fixed prerequisites from a GitHub job. */
function needs(name) { return [jobs[name].needs ?? []].flat(); }

/** Evaluate job readiness from terminal prerequisites and the workflow's conditions, including implicit success(). */
function ready(name, results, outputs, cancelled = false) {
  const dependencies = needs(name);
  if (dependencies.some(id => !['success', 'failure', 'cancelled', 'skipped'].includes(results[id]))) return false;
  const context = Object.fromEntries(dependencies.map(id => [id, { result: results[id], outputs: id === 'prepare' ? outputs : {} }]));
  const condition = jobs[name].if ?? 'true';
  if (!/\b(?:always|cancelled|success|failure)\(/.test(condition) && dependencies.some(id => results[id] !== 'success')) return false;
  const expression = condition.replace(/\bneeds\.([\w-]+)/g, (_match, id) => `needs[${JSON.stringify(id)}]`);
  return new Function('needs', 'always', 'cancelled', `return (${expression});`)(context, () => true, () => cancelled);
}

test('the single reusable release workflow has fixed jobs and repository serialization', () => {
  assert.ok(workflow.on.workflow_call); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs), ['profile', 'rebuild']);
  for (const name of ['prepare', 'reserve', 'server-build', 'server-publish', 'server-deploy', 'native-start', 'native-build', 'native-record', 'native-submit', 'ota-export', 'ota-publish']) assert.ok(jobs[name]);
  assert.ok(!JSON.stringify(workflow).includes('workflow_run'));
  for (const job of Object.values(jobs)) {
    const checkout = job.steps.find(step => step.with?.path === '.toolkit');
    assert.equal(checkout.with.repository, 'darkmachines-net/expo-release-template');
    assert.equal(checkout.with.ref, '${{ job.workflow_sha }}');
  }
});

test('reservation precedes every build and external operation', () => {
  for (const name of ['server-build','native-start','ota-export']) assert.ok(needs(name).includes('reserve'));
  assert.ok(needs('reserve').includes('prepare'));
  assert.ok(needs('server-publish').includes('server-build'));
  assert.ok(needs('server-deploy').includes('server-publish'));
  assert.ok(needs('native-build').includes('native-start'));
  assert.match(jobs['native-build'].if, /always\(\).*needs.native-start.result == 'success'/);
});

test('server, native and OTA artifacts can build together before any deployment completes', () => {
  const results = { context: 'success', prepare: 'success', reserve: 'success' };
  const outputs = { server: 'true', native: 'true', ota: '["android","ios"]' };
  for (const name of ['server-build', 'native-start', 'ota-export']) assert.equal(ready(name, results, outputs), true, name);
  assert.equal(ready('native-build', results, outputs), false, 'Native builds still need their recorded intents.');
  results['native-start'] = 'success';
  for (const server of [undefined, 'in_progress', 'failure', 'success']) {
    results['server-deploy'] = server;
    assert.equal(ready('native-build', results, outputs), true);
    assert.equal(ready('native-record', { ...results, 'native-build': 'success' }, outputs), true);
  }
  for (const reserve of ['failure', 'cancelled', 'skipped']) for (const name of ['server-build', 'native-start', 'ota-export'])
    assert.equal(ready(name, { ...results, reserve }, outputs), false, `${name}: ${reserve}`);
  assert.equal(ready('native-start', results, { ...outputs, native: 'false' }), false);
  assert.equal(ready('native-build', results, outputs, true), false);
});

test('client delivery stays blocked until the selected server succeeds, including failures and skipped server paths', () => {
  const results = { context: 'success', prepare: 'success', 'native-record': 'success', 'ota-export': 'success' };
  for (const server of ['true', 'false']) for (const status of [undefined, 'in_progress', 'success', 'failure', 'cancelled', 'skipped'])
    for (const cancelled of [false, true]) for (const name of ['native-submit', 'ota-publish']) {
      const terminal = ['success', 'failure', 'cancelled', 'skipped'].includes(status);
      assert.equal(ready(name, { ...results, 'server-deploy': status }, { server, native: 'true', submit: 'true' }, cancelled),
        !cancelled && terminal && (server === 'false' || status === 'success'), `${name}: ${server}/${status}/${cancelled}`);
    }
  const deployed = { ...results, 'server-deploy': 'success' };
  for (const status of ['failure', 'cancelled', 'skipped']) for (const name of ['native-submit', 'ota-publish'])
    assert.equal(ready(name, { ...deployed, 'native-record': status }, { server: 'true', native: 'true', submit: 'true' }), false);
  assert.equal(ready('ota-publish', { ...deployed, 'native-record': 'skipped' }, { server: 'true', native: 'false' }), true);
});

test('submission waits for native evidence and selected server deployment', () => {
  assert.ok(needs('native-submit').includes('native-record'));
  assert.ok(needs('native-submit').includes('server-deploy'));
  assert.match(jobs['native-submit'].if, /server != 'true'.*server-deploy.result == 'success'/);
  assert.match(jobs['native-submit'].environment, /submit_environment/);
});

test('OTA waits for compatible build evidence, not store submission completion', () => {
  assert.ok(needs('ota-publish').includes('native-record'));
  assert.ok(!needs('ota-publish').includes('native-submit'));
  assert.ok(needs('ota-publish').includes('server-deploy'));
  assert.match(jobs['ota-publish'].if, /native != 'true'.*native-record.result == 'success'/);
  assert.match(jobs['ota-publish'].if, /server != 'true'.*server-deploy.result == 'success'/);
});

test('partial matrix failures still record completed native builds', () => {
  assert.equal(jobs['native-build'].strategy['fail-fast'], false);
  assert.match(jobs['native-record'].if, /always\(\).*native-start.result == 'success'/);
  assert.ok(jobs['native-record'].steps.some(step => step.with?.['merge-multiple'] === true));
});

test('source validation, Docker production and OTA export have no publication credentials', () => {
  for (const name of ['prepare','server-build','ota-export']) {
    const text = JSON.stringify(jobs[name]);
    assert.ok(!text.includes('secrets.')); assert.ok(!text.includes('github.token'));
    assert.ok(!text.includes('write')); assert.ok(!text.includes('EXPO_TOKEN'));
  }
});

test('separate native steps scope signing and cloud authentication', () => {
  const steps = jobs['native-build'].steps;
  const native = steps.find(step => step.run?.endsWith('native-command'));
  const cloud = steps.find(step => step.run?.endsWith('native-cloud'));
  assert.deepEqual(Object.keys(native.env).sort(), ['ANDROID_KEYSTORE_BASE64','ANDROID_STORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD'].sort());
  assert.deepEqual(Object.keys(cloud.env), ['EXPO_TOKEN']);
  assert.equal(native.if, "matrix.target.builder == 'command'");
  assert.equal(cloud.if, "matrix.target.builder == 'eas'");
  assert.match(steps.find(step => step.uses === './.toolkit/.github/actions/setup').with.eas, /matrix.target.builder/);
  assert.match(jobs['native-record'].steps.find(step => step.uses === './.toolkit/.github/actions/setup').with.eas, /outputs.cloud/);
  assert.ok(steps.findIndex(step => step.run?.includes('android-tools')) < steps.indexOf(native));
  assert.ok(jobs['native-build'].environment);
});

test('publishers do not install or execute application dependencies', () => {
  for (const name of ['server-publish','server-deploy','native-record','native-submit','ota-publish']) {
    assert.ok(!jobs[name].steps.some(step => step.run?.includes('worker.mjs install')));
    assert.ok(jobs[name].steps.some(step => step.uses?.includes('download-artifact')) || name === 'server-deploy');
  }
  for (const name of ['server-publish','server-deploy','native-submit','ota-publish']) assert.ok(jobs[name].environment);
});

test('all artifacts are current-run downloads without arbitrary run or repository inputs', () => {
  for (const job of [...Object.values(jobs), { steps: setup.runs.steps }]) for (const step of job.steps) if (step.uses?.includes('download-artifact')) {
    for (const key of ['run-id','repository','github-token']) assert.equal(step.with?.[key], undefined);
  }
});

test('rerun producers restore their own completed artifacts and never overwrite successful output', () => {
  for (const name of ['context', 'environment', 'prepare', 'native-start', 'native-build', 'server-build', 'ota-export']) {
    const steps = jobs[name].steps;
    const upload = steps.find(step => step.uses?.includes('upload-artifact'));
    const restore = steps.find(step => step.uses === './.toolkit/.github/actions/setup');
    assert.equal(restore.with.reuse, upload.with.name);
    assert.equal(restore.with.directory ?? 'state', upload.with.path === 'state/native-intents.json' ? 'state' : upload.with.path);
    assert.equal(upload.if, "env.RELEASE_REUSE != 'true'");
    assert.equal(upload.with.overwrite, undefined);
  }
  const restore = setup.runs.steps.find(step => step.id === 'reuse');
  assert.match(restore.if, /github.run_attempt > 1/);
  assert.equal(restore['continue-on-error'], true);
  assert.equal(restore.with.path, '.release-restored');
  assert.ok(setup.runs.steps.some(step => step.run?.includes('cp -a .release-restored/.')));
});

test('upstream setup uses a full action SHA and a pinned EAS version before credentials', () => {
  const step = setup.runs.steps.find(step => step.uses?.startsWith('expo/expo-github-action@'));
  assert.match(step.uses, /@[a-f0-9]{40}$/); assert.equal(step.with['eas-version'], '25.3.0'); assert.equal(step.with.token, undefined);
  assert.ok(setup.runs.steps.some(step => step.run?.includes('npm ci --prefix .toolkit --ignore-scripts')));
  assert.ok(!fs.existsSync(new URL('../toolchain/package-lock.json', import.meta.url)));
});
