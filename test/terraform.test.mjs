/** @file Exercise isolated Terraform, encrypted plans and confidential failure recovery, no-op detection and approval boundaries offline. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTerraform, applyTerraform, readTerraformPlan, readTerraformDiagnostic, verifyTerraformApproval } from '../src/terraform.mjs';
import { loadConfig } from '../src/consumer/config.mjs';
import { writeJson, seal, run } from '../src/io.mjs';
import { temporary, plan } from './helpers.mjs';

/** Return an isolated Terraform root and a command double that only writes disposable plan bytes. */
function fixture(t, code = 2) {
  const root = temporary(t), directory = path.join(root, 'artifacts'), value = plan();
  value.config.profiles.production.terraform = { directory: 'infra', version: '1.13.5', planEnvironment: 'plan', applyEnvironment: 'apply' };
  fs.mkdirSync(path.join(root, 'infra')); fs.writeFileSync(path.join(root, 'infra/.terraform.lock.hcl'), '# pinned');
  const env = { TERRAFORM_PLAN_KEY: Buffer.alloc(32, 7).toString('base64'), TERRAFORM_VARS_JSON: '{"password":"private-input"}',
    GOOGLE_APPLICATION_CREDENTIALS: '/adc.json', EXPO_TOKEN: 'publication-secret', GITHUB_TOKEN: 'github-secret',
    TF_CLI_ARGS: '-destroy', TF_VAR_password: 'wrong', TF_WORKSPACE: 'wrong' };
  const calls = [], work = [];
  return { root, directory, value, env, calls, work,
    /** Model Terraform's exit codes and saved-plan interface while asserting credential isolation. */
    execute(command, args, options) {
      calls.push(args); assert.equal(command, 'terraform'); assert.equal(options.cwd, path.join(root, 'infra'));
      assert.equal(options.env.GOOGLE_APPLICATION_CREDENTIALS, '/adc.json'); assert.equal(options.env.TF_WORKSPACE, 'default');
      for (const key of ['EXPO_TOKEN', 'GITHUB_TOKEN', 'TF_CLI_ARGS', 'TF_VAR_password', 'TERRAFORM_PLAN_KEY', 'TERRAFORM_VARS_JSON']) assert.equal(options.env[key], undefined);
      work.push(path.dirname(options.env.TF_DATA_DIR));
      if (args[0] === 'version') return '{"terraform_version":"1.13.5"}';
      if (args[0] === 'plan') {
        assert.ok(args.includes('-refresh=true') && args.includes('-detailed-exitcode') && args.includes('-lock-timeout=5m'));
        const variables = args.find(arg => arg.startsWith('-var-file=')).slice(10);
        assert.deepEqual(JSON.parse(fs.readFileSync(variables, 'utf8')), { password: 'private-input' });
        fs.writeFileSync(args.find(arg => arg.startsWith('-out=')).slice(5), 'exact saved bytes containing private-input');
        if (code !== 0) throw Object.assign(new Error('secret diagnostic'), { status: code });
      }
      if (args[0] === 'show') return '# resource.field changes\n(sensitive value)';
      if (args[0] === 'apply') {
        assert.equal(fs.readFileSync(args.at(-1), 'utf8'), 'exact saved bytes containing private-input');
        assert.deepEqual(args.slice(0, -1), ['apply', '-input=false', '-no-color', '-lock-timeout=5m']);
      }
      return '';
    }
  };
}

test('changed plans encrypt sensitive bytes and apply exactly the reviewed plan with locked state', t => {
  const f = fixture(t);
  assert.equal(planTerraform(f.root, f.value, f.directory, f.env, f.execute).changes, true);
  assert.ok(!fs.readFileSync(path.join(f.directory, 'plan.enc')).includes(Buffer.from('private-input')));
  assert.deepEqual(fs.readdirSync(f.directory), ['plan.enc']);
  assert.equal(fs.existsSync(`${f.directory}.failure.enc`), false, 'A changed plan is not a failed command.');
  assert.equal(readTerraformPlan(f.directory, f.value, f.env).changes, true);
  const result = applyTerraform(f.root, f.value, f.directory, f.env, f.execute);
  assert.equal(result.changed, true); assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.map(args => args[0]), ['version', 'init', 'plan', 'show', 'version', 'init', 'apply']);
  for (const directory of f.work) assert.equal(fs.existsSync(directory), false);
  assert.ok(f.calls.filter(args => args[0] === 'init').every(args => args.includes('-lockfile=readonly')));
});

test('empty diff skips apply and needs neither provider credentials nor new variable inputs', t => {
  const f = fixture(t, 0);
  assert.equal(planTerraform(f.root, f.value, f.directory, f.env, f.execute).changes, false);
  const saved = readTerraformPlan(f.directory, f.value, f.env);
  assert.equal(saved.changes, false);
  assert.equal(applyTerraform(f.root, f.value, f.directory, { TERRAFORM_PLAN_KEY: f.env.TERRAFORM_PLAN_KEY }, () => assert.fail('no-op ran Terraform')).changed, false);
});

test('a retried workflow plan restores authenticated change outputs and review text without running Terraform', t => {
  const f = fixture(t, 0), state = path.join(f.root, 'state'), directory = path.join(f.root, 'artifacts/terraform');
  delete f.value.config.mobile.platforms; f.value.terraform = true; f.value.operations.push('production/apply/terraform');
  planTerraform(f.root, f.value, directory, f.env, f.execute);
  writeJson(path.join(f.root, 'release.config.json'), f.value.config); writeJson(path.join(state, 'plan.json'), f.value);
  const output = path.join(f.root, 'output'), summary = path.join(f.root, 'summary');
  run(process.execPath, [fileURLToPath(new URL('../bin/worker.mjs', import.meta.url)), 'terraform-plan', f.root, state], {
    cwd: f.root, env: { ...process.env, TERRAFORM_PLAN_KEY: f.env.TERRAFORM_PLAN_KEY, TERRAFORM_VARS_JSON: 'invalid',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: f.value.repository,
      GITHUB_SHA: f.value.source, TOOLKIT_SHA: f.value.toolkit, GITHUB_RUN_ID: f.value.run, GITHUB_RUN_ATTEMPT: '2',
      RELEASE_PROFILE: 'production', RELEASE_REUSE: 'true', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }
  });
  assert.match(fs.readFileSync(output, 'utf8'), /changes=false/);
  assert.match(fs.readFileSync(summary, 'utf8'), /no changes.*\n<pre># resource.field changes/);
});

test('failed plans retain only encrypted diagnostics, block usable artifacts and clean sensitive temporary inputs', t => {
  for (const code of [1, 3, null]) {
    const f = fixture(t, code);
    assert.throws(() => planTerraform(f.root, f.value, f.directory, f.env, f.execute), error =>
      error.message.includes('Terraform plan failed') && !error.message.includes('secret diagnostic'));
    assert.equal(fs.existsSync(f.directory), false);
    const file = `${f.directory}.failure.enc`;
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('secret diagnostic')));
    assert.deepEqual(readTerraformDiagnostic(file, f.value, f.env), { command: 'plan', code, stdout: '', stderr: 'secret diagnostic' });
    for (const directory of f.work) assert.equal(fs.existsSync(directory), false);
    assert.ok(!f.calls.some(args => ['show', 'apply'].includes(args[0])));
  }
});

test('stale or failed apply is attempted once and cleans decrypted bytes without re-planning', t => {
  const f = fixture(t); planTerraform(f.root, f.value, f.directory, f.env, f.execute);
  let attempts = 0;
  assert.throws(() => applyTerraform(f.root, f.value, f.directory, f.env, (binary, args, options) => {
    f.execute(binary, args, options);
    if (args[0] === 'apply') { attempts++; throw Object.assign(new Error('stale saved plan'), { status: 1 }); }
    return args[0] === 'version' ? '{"terraform_version":"1.13.5"}' : '';
  }), /Terraform apply failed/);
  assert.equal(attempts, 1); assert.equal(f.calls.filter(args => args[0] === 'plan').length, 1);
  assert.equal(readTerraformDiagnostic(`${f.directory}.failure.enc`, f.value, f.env).stderr, 'stale saved plan');
  assert.equal(readTerraformPlan(f.directory, f.value, f.env).changes, true, 'Failure evidence must not change the sealed plan.');
  for (const directory of f.work) assert.equal(fs.existsSync(directory), false);
});

test('initialization failure diagnostics are bounded and authenticate identity, key and purpose before decryption', t => {
  const f = fixture(t), file = `${f.directory}.failure.enc`;
  assert.throws(() => planTerraform(f.root, f.value, f.directory, f.env, (command, args, options) => {
    if (args[0] === 'init') throw Object.assign(new Error('private provider detail'), {
      status: 1, stdout: Buffer.from('x'.repeat(1048600)), stderr: Buffer.from('secret provider error')
    });
    return f.execute(command, args, options);
  }), /Terraform init failed/);
  const diagnostic = readTerraformDiagnostic(file, f.value, f.env);
  assert.equal(diagnostic.command, 'init'); assert.equal(diagnostic.stdout.length, 1048576);
  assert.equal(diagnostic.stderr, 'secret provider error');
  assert.throws(() => readTerraformDiagnostic(file, { ...f.value, run: 'other' }, f.env));
  assert.throws(() => readTerraformDiagnostic(file, f.value, { TERRAFORM_PLAN_KEY: Buffer.alloc(32, 8).toString('base64') }));
  const encrypted = fs.readFileSync(file), bytes = Buffer.from(encrypted); bytes[30] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => readTerraformDiagnostic(file, f.value, f.env));
  planTerraform(f.root, f.value, f.directory, f.env, f.execute);
  assert.throws(() => readTerraformDiagnostic(path.join(f.directory, 'plan.enc'), f.value, f.env));
  fs.writeFileSync(path.join(f.directory, 'plan.enc'), encrypted); seal(f.directory, f.value, 'terraform');
  assert.throws(() => readTerraformPlan(f.directory, f.value, f.env));
  for (const directory of f.work) assert.equal(fs.existsSync(directory), false);
});

test('tampered ciphertext or identity cannot forge a no-change result even after resealing', t => {
  const f = fixture(t); planTerraform(f.root, f.value, f.directory, f.env, f.execute);
  for (const patch of [{ run: 'other' }, { source: 'e'.repeat(40) }, { toolkit: 'f'.repeat(40) }, { profile: 'beta' }]) {
    const changed = { ...f.value, ...patch }; seal(f.directory, changed, 'terraform');
    assert.throws(() => readTerraformPlan(f.directory, changed, f.env));
  }
  seal(f.directory, f.value, 'terraform');
  assert.throws(() => readTerraformPlan(f.directory, f.value, { ...f.env, TERRAFORM_PLAN_KEY: Buffer.alloc(32, 8).toString('base64') }));
  const file = path.join(f.directory, 'plan.enc'), bytes = fs.readFileSync(file); bytes[30] ^= 1; fs.writeFileSync(file, bytes);
  seal(f.directory, f.value, 'terraform');
  assert.throws(() => applyTerraform(f.root, f.value, f.directory, f.env, () => assert.fail('tampered artifact reached provider')));
});

test('missing locks, wrong Terraform versions and malformed secrets stop before planning', t => {
  const f = fixture(t);
  for (const patch of [{ TERRAFORM_PLAN_KEY: '' }, { TERRAFORM_VARS_JSON: 'null' }, { TERRAFORM_VARS_JSON: '[]' }])
    assert.throws(() => planTerraform(f.root, f.value, f.directory, { ...f.env, ...patch }, () => assert.fail('invalid inputs ran provider')));
  assert.throws(() => planTerraform(f.root, f.value, f.directory, { ...f.env, TERRAFORM_VARS_JSON: 'private-sentinel' }),
    error => !error.message.includes('private-sentinel') && error.message.includes('not valid JSON'));
  assert.throws(() => planTerraform(f.root, f.value, f.directory, f.env, () => '{"terraform_version":"1.12.0"}'), /version differs/);
  fs.rmSync(path.join(f.root, 'infra/.terraform.lock.hcl'));
  assert.throws(() => planTerraform(f.root, f.value, f.directory, f.env, () => assert.fail('missing lock ran provider')), /lockfile/);
});

test('Terraform configuration requires its own reviewer boundary and a contained source directory', async t => {
  const f = fixture(t), value = structuredClone(f.value.config); delete value.mobile.platforms;
  writeJson(path.join(f.root, 'release.config.json'), value); assert.ok(loadConfig(f.root));
  for (const patch of [{ directory: '../escape' }, { applyEnvironment: 'production' }, { applyEnvironment: 'plan' }, { applyEnvironment: 'server' }]) {
    const changed = structuredClone(value); Object.assign(changed.profiles.production.terraform, patch);
    writeJson(path.join(f.root, 'release.config.json'), changed); assert.throws(() => loadConfig(f.root));
  }
  /** Return a GitHub environment response with only the specified protection rules. */
  const client = protection_rules => ({
    /** Read the environment without contacting GitHub. */
    api: async () => ({ protection_rules })
  });
  for (const rules of [[], [{ type: 'wait_timer' }], [{ type: 'required_reviewers', reviewers: [] }]])
    await assert.rejects(verifyTerraformApproval(client(rules), { applyEnvironment: 'apply' }), /requires reviewers/);
  await verifyTerraformApproval(client([{ type: 'required_reviewers', reviewers: [{}] }]), { applyEnvironment: 'apply' });
});
