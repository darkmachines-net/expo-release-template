/** @file Tests immutable GCP rollout ordering and failure gates without cloud access, Docker, or provider credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deployGcp, gcpInputs, verifyRun, runtimeImage } from '../src/gcp.mjs';
import { plan } from './helpers.mjs';

/** Provide provider-shaped readback and command tracing for a complete gated deployment. */
function harness() {
  const release = plan(), digest = 'sha256:' + 'd'.repeat(64);
  const spec = { provider: 'gcp', project: 'example-project', region: 'us-central1', api: 'example-api', worker: 'example-worker', migrationJob: 'example-migrate', hostingSite: 'example-project', registry: 'us-central1-docker.pkg.dev/example-project/application/server', origin: 'https://example.app' };
  const published = { image: release.config.server.image, digest, version: release.versions.server }, image = spec.registry + '@' + digest, calls = [];
  /** Emulate only bounded provider readback; no commands are executed. */
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args.includes('print-access-token')) return 'synthetic-token';
    if (binary === 'skopeo' && args[0] === 'inspect') return args.includes('--raw') ? JSON.stringify({ config: { digest } }) : digest;
    if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') return JSON.stringify({ status: { latestReadyRevisionName: args[3] + '-revision', latestCreatedRevisionName: args[3] + '-revision', conditions: [{ type: 'Ready', status: 'True' }], traffic: [{ tag: 'release-' + release.run, revisionName: spec.api + '-revision', url: 'https://verified.run.app' }] } });
    if (args[1] === 'revisions') return JSON.stringify({ metadata: { name: args[3] }, status: { imageDigest: image } });
    if (args[1] === 'jobs' && args[2] === 'execute') return JSON.stringify({ metadata: { name: 'migration-execution' }, status: { conditions: [{ type: 'Completed', status: 'True' }] } });
    if (binary === 'firebase') {
      const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
      assert.deepEqual(config.hosting.rewrites, [{ source: '**', run: { serviceId: spec.api, region: spec.region, pinTag: true } }]);
    }
    return '{}';
  };
  /** Assert that revision health uses only the staged service or declared public origin. */
  const fetcher = async url => { calls.push({ health: url }); return { ok: true, /** Return synthetic provider JSON. */ json: async () => ({ status: 'ok', version: release.versions.server, revision: spec.api + '-revision' }) }; };
  return { release, spec, published, calls, execute, fetcher, env: { GHCR_TOKEN: 'fixture', GITHUB_ACTOR: 'fixture' } };
}
test('migrates, verifies exact API/worker images and readiness, then publishes pinned Hosting', async () => {
  const h = harness(), result = await deployGcp(h.spec, h.published, h.release, h.env, h.execute, h.fetcher);
  assert.equal(result.healthy, true); assert.equal(result.migration, 'migration-execution');
  const migration = h.calls.findIndex(c => c.args?.includes('execute')), worker = h.calls.findIndex(c => c.args?.includes(h.spec.worker) && c.args.includes('update'));
  const staged = h.calls.findIndex(c => c.health?.startsWith('https://verified')), hosting = h.calls.findIndex(c => c.binary === 'firebase');
  assert.ok(migration < worker && worker < staged && staged < hosting);
  assert.equal(h.calls.at(-1).health, h.spec.origin + '/api/ready');
  const auth = h.calls.find(c => c.binary === 'skopeo').args; assert.equal(fs.existsSync(auth[auth.indexOf('--authfile') + 1]), false);
});
test('verifies the platform digest selected from an immutable multi-platform index', () => {
  const image = 'registry.example/app@sha256:' + 'a'.repeat(64), digest = 'sha256:' + 'b'.repeat(64);
  const platform = { platform: { os: 'linux', architecture: 'amd64' }, digest };
  assert.equal(runtimeImage(image, { manifests: [platform, { platform: { os: 'unknown', architecture: 'unknown' } }] }), 'registry.example/app@' + digest);
  assert.throws(() => runtimeImage(image, { manifests: [platform, platform] }), /one linux/);
  assert.throws(() => runtimeImage(image, { manifests: [] }), /one linux/);
});
test('rejects missing or mismatched publication receipts before any cloud operation', async () => {
  const h = harness();
  for (const invalid of [undefined, { ...h.published, image: 'ghcr.io/other/app' }, { ...h.published, version: '0.0.0' }, { ...h.published, digest: 'latest' }]) await assert.rejects(deployGcp(h.spec, invalid, h.release, h.env, h.execute, h.fetcher), /confirmed image/);
  assert.equal(h.calls.length, 0);
  assert.throws(() => gcpInputs({ ...h.spec, registry: 'evil.invalid/image' }, h.published, h.release), /Registry/);
});
test('failed migrations and readiness stop Hosting and retain no automatic database rollback', async () => {
  for (const fail of ['migration', 'readiness']) {
    const h = harness();
    await assert.rejects(deployGcp(h.spec, h.published, h.release, h.env, (binary, args, options) => {
      if (fail === 'migration' && args.includes('execute')) throw new Error('migration failed');
      return h.execute(binary, args, options);
    }, async url => { if (fail === 'readiness') return { ok: false, /** Return synthetic provider JSON. */ json: async () => ({}) }; return h.fetcher(url); }), /Native\/OTA delivery is blocked/);
    assert.ok(!h.calls.some(c => c.binary === 'firebase' || c.args?.includes('rollback')));
  }
});
test('rejects stale readiness and wrong revision digests', () => {
  const service = { status: { latestReadyRevisionName: 'new', latestCreatedRevisionName: 'new', conditions: [{ type: 'Ready', status: 'True' }] } };
  assert.throws(() => verifyRun(service, { metadata: { name: 'new' }, status: { imageDigest: 'wrong' } }, 'expected'), /different image/);
  assert.throws(() => verifyRun({ status: { ...service.status, latestReadyRevisionName: 'old' } }, {}, 'expected'), /not ready/);
});
