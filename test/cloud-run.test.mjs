/** @file Cloud deployment tests never contact a registry, database, Firebase project, or live release. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cloudRunInputs, deployCloudRun } from '../src/cloud-run.mjs';
const spec = { provider: 'cloud-run', service: 'app', repository: 'images', region: 'us-west1', migrationJob: 'migrate', jobs: ['accounts'] };
const publication = { image: 'ghcr.io/example/app', digest: 'sha256:' + 'a'.repeat(64) };
const release = { run: '123', origin: 'https://app.example.invalid', healthPath: '/healthz' };
const env = { GCP_PROJECT_ID: 'example-testing', GITHUB_ACTOR: 'actor', GHCR_TOKEN: 'secret-sentinel', GITHUB_RUN_ATTEMPT: '2' };

/** Provide explicit provider evidence while recording commands and allowing one bounded fault. */
function harness(fault) {
  const calls = [], value = cloudRunInputs(spec, publication, release, env);
  let authfile;
  return {
    calls,
    /** Record a command and return synthetic provider evidence. */
    execute(binary, args, options) {
      calls.push([binary, args]);
      assert.ok(!args.join(' ').includes(env.GHCR_TOKEN));
      if (args.includes('--authfile')) authfile = args[args.indexOf('--authfile') + 1];
      if (fault?.(binary, args)) throw new Error(env.GHCR_TOKEN);
      if (args.includes('print-access-token')) return 'short-lived-token';
      if (binary === 'skopeo' && args[0] === 'inspect') return publication.digest;
      if (args.includes('revisions')) return JSON.stringify({ status: { imageDigest: value.image + '@' + publication.digest, conditions: [{ type: 'Ready', status: 'True' }] } });
      if (args.includes('describe')) return JSON.stringify({ status: { traffic: [{ tag: value.tag, revisionName: value.revision, url: 'https://preview.run.app' }] } });
      if (binary === 'firebase') {
        const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
        assert.equal(config.hosting.rewrites[0].run.serviceId, spec.service);
        assert.equal(config.hosting.site, env.GCP_PROJECT_ID);
      }
      assert.equal(options.timeout, 900000);
      return '';
    },
    /** Verify credential cleanup after both successful and failed operations. */
    assertClean() { assert.equal(fs.existsSync(authfile), false); }
  };
}

test('invalid identity or mutable image is rejected before provider operations', () => {
  assert.match(cloudRunInputs(spec, publication, release, env).revision, /r123-a2$/);
  for (const changed of [{ GCP_PROJECT_ID: '' }, { GITHUB_RUN_ATTEMPT: '../bad' }]) assert.throws(() => cloudRunInputs(spec, publication, release, { ...env, ...changed }));
  assert.throws(() => cloudRunInputs(spec, { ...publication, digest: 'latest' }, release, env));
  assert.throws(() => cloudRunInputs(spec, publication, { ...release, origin: 'http://example.invalid' }, env));
});

test('migration and exact revision readiness precede jobs, traffic, Hosting, and success', async () => {
  const harnessed = harness(), fetches = [];
  const result = await deployCloudRun(spec, publication, release, env, harnessed.execute, async url => { fetches.push(url); return { ok: true }; });
  const calls = harnessed.calls.map(([binary, args]) => binary + ' ' + args.join(' '));
  /** Locate a provider phase for ordering assertions. */
  const index = text => calls.findIndex(call => call.includes(text));
  assert.ok(index('jobs execute migrate --wait') < index('services update app'));
  assert.ok(index('revisions describe') < index('jobs update accounts'));
  assert.ok(index('jobs update accounts') < index('services update-traffic'));
  assert.ok(index('services update-traffic') < index('firebase deploy'));
  assert.deepEqual(fetches, ['https://preview.run.app/healthz', release.origin + '/healthz']);
  assert.equal(result.healthy, true);
  harnessed.assertClean();
});

test('failed migration never updates a service or advances traffic', async () => {
  const harnessed = harness((_binary, args) => args.includes('execute'));
  await assert.rejects(deployCloudRun(spec, publication, release, env, harnessed.execute), error => /uncertain/.test(error.message) && !error.message.includes(env.GHCR_TOKEN));
  assert.ok(!harnessed.calls.some(([, args]) => args.includes('services')));
  harnessed.assertClean();
});

test('failed isolated readiness never promotes traffic or Hosting', async () => {
  const harnessed = harness();
  await assert.rejects(deployCloudRun(spec, publication, release, env, harnessed.execute, async () => ({ ok: false })), /uncertain/);
  assert.ok(!harnessed.calls.some(([binary, args]) => binary === 'firebase' || args.includes('update-traffic')));
  harnessed.assertClean();
});
