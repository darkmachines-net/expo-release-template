/** @file Plan and apply Terraform with isolated credentials, authenticated encrypted plans and failure diagnostics, and locked state. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assert } from './engine.mjs';
import { hash, run, within, sourceEnvironment, seal, verify } from './io.mjs';

/** Require a dedicated reviewer gate before planning; ordinary deployment approvals cannot authorize infrastructure. */
export async function verifyTerraformApproval(client, spec) {
  if (!spec) return;
  const environment = await client.api('GET', `environments/${encodeURIComponent(spec.applyEnvironment)}`);
  assert(environment?.protection_rules?.some(rule => rule.type === 'required_reviewers' && rule.reviewers?.length),
    'Terraform apply environment requires reviewers.');
}

/** Encrypt or authenticate a saved plan and its change flag against the entire immutable release identity. */
function crypt(bytes, plan, secret, decrypt = false) {
  assert(/^[A-Za-z0-9+/]{43}=$/.test(secret ?? ''), 'TERRAFORM_PLAN_KEY must encode 32 random bytes as base64.');
  const key = Buffer.from(secret, 'base64'), iv = decrypt ? bytes.subarray(0, 12) : randomBytes(12);
  const cipher = decrypt ? createDecipheriv('aes-256-gcm', key, iv) : createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(hash(plan)));
  if (decrypt) cipher.setAuthTag(bytes.subarray(12, 28));
  const result = Buffer.concat([cipher.update(decrypt ? bytes.subarray(28) : bytes), cipher.final()]);
  return decrypt ? result : Buffer.concat([iv, cipher.getAuthTag(), result]);
}

/** Verify current-run artifact identity and authenticated contents before trusting even its no-change flag. */
export function readTerraformPlan(directory, plan, env = process.env) {
  verify(directory, plan, 'terraform');
  const saved = JSON.parse(crypt(fs.readFileSync(path.join(directory, 'plan.enc')), plan, env.TERRAFORM_PLAN_KEY, true));
  assert(typeof saved.changes === 'boolean' && typeof saved.review === 'string' && typeof saved.binary === 'string' && saved.binary.length,
    'Malformed saved Terraform plan.');
  return saved;
}

/** Decrypt a failure diagnostic with the matching immutable release plan and environment key; treat its contents as confidential. */
export function readTerraformDiagnostic(file, plan, env = process.env) {
  return JSON.parse(crypt(fs.readFileSync(file), { plan, diagnostic: true }, env.TERRAFORM_PLAN_KEY, true));
}

/** Run private Terraform stages with Google ADC only; encrypt failures beside the artifact directory without changing saved plans. */
function session(root, plan, directory, env, execute, operation) {
  const spec = plan.config.profiles[plan.profile].terraform, cwd = within(root, spec.directory);
  assert(fs.existsSync(path.join(cwd, '.terraform.lock.hcl')), 'Commit the Terraform provider lockfile before release.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'release-terraform-'));
  const config = path.join(temporary, 'terraform.rc'); fs.writeFileSync(config, '');
  const environment = { ...sourceEnvironment({}, env), TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_WORKSPACE: 'default',
    TF_CLI_CONFIG_FILE: config, TF_DATA_DIR: path.join(temporary, 'data'), GOOGLE_APPLICATION_CREDENTIALS: env.GOOGLE_APPLICATION_CREDENTIALS };
  /** Encrypt bounded failure output separately from usable plans; never print provider errors or private inputs. */
  const terraform = (command, args = [], detailed = false) => {
    try { return { code: 0, text: execute('terraform', [command, ...args], { cwd, env: environment, stdio: 'pipe' }) }; }
    catch (error) {
      if (detailed && error.status === 2) return { code: 2 };
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      const diagnostic = { command, code: error.status ?? null, stdout: String(error.stdout ?? '').slice(-1048576),
        stderr: String(error.stderr ?? error.message ?? '').slice(-1048576) };
      fs.writeFileSync(`${directory}.failure.enc`, crypt(Buffer.from(JSON.stringify(diagnostic)), { plan, diagnostic: true }, env.TERRAFORM_PLAN_KEY));
      throw new Error(`Terraform ${command} failed; deployment is blocked (exit ${error.status ?? 'unknown'}).`);
    }
  };
  try {
    const version = JSON.parse(terraform('version', ['-json']).text);
    assert(version.terraform_version === spec.version, 'Terraform version differs from release configuration.');
    terraform('init', ['-input=false', '-no-color', '-lockfile=readonly']);
    return operation(terraform, temporary);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Refresh and encrypt the full plan; exit 0 skips apply, exit 2 requires review, other exits retain encrypted diagnostics and fail closed. */
export function planTerraform(root, plan, directory, env = process.env, execute = run) {
  crypt(Buffer.alloc(0), plan, env.TERRAFORM_PLAN_KEY);
  let variables;
  try { variables = JSON.parse(env.TERRAFORM_VARS_JSON ?? 'null'); }
  catch { throw new Error('TERRAFORM_VARS_JSON is not valid JSON.'); }
  assert(variables && typeof variables === 'object' && !Array.isArray(variables), 'TERRAFORM_VARS_JSON must be a complete JSON input object.');
  return session(root, plan, directory, env, execute, (terraform, temporary) => {
    const inputs = path.join(temporary, 'inputs.tfvars.json'), file = path.join(temporary, 'saved.tfplan');
    fs.writeFileSync(inputs, JSON.stringify(variables), { mode: 0o600 });
    const result = terraform('plan', ['-input=false', '-no-color', '-lock-timeout=5m', '-refresh=true', '-detailed-exitcode', `-var-file=${inputs}`, `-out=${file}`], true);
    const saved = { changes: result.code === 2, review: terraform('show', ['-no-color', file]).text, binary: fs.readFileSync(file).toString('base64') };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plan.enc'), crypt(Buffer.from(JSON.stringify(saved)), plan, env.TERRAFORM_PLAN_KEY));
    seal(directory, plan, 'terraform');
    return saved;
  });
}

/** Apply authenticated saved bytes under the receipt guard; retain encrypted failures without re-planning or altering the saved plan. */
export function applyTerraform(root, plan, directory, env = process.env, execute = run) {
  const saved = readTerraformPlan(directory, plan, env), binary = Buffer.from(saved.binary, 'base64');
  if (saved.changes) session(root, plan, directory, env, execute, (terraform, temporary) => {
    const file = path.join(temporary, 'saved.tfplan'); fs.writeFileSync(file, binary, { mode: 0o600 });
    terraform('apply', ['-input=false', '-no-color', '-lock-timeout=5m', file]);
  });
  return { changed: saved.changes, digest: hash(binary) };
}
