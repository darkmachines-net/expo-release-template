/** @file Deploys a confirmed immutable image through migrations, Cloud Run readiness, and revision-pinned Firebase Hosting. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './engine.mjs';
import { run } from './io.mjs';

/** Validate provider destinations and the confirmed publication receipt before admitting cloud credentials. */
export function gcpInputs(spec, published, plan) {
  assert(spec.provider === 'gcp' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(spec.project) && /^[a-z]+-[a-z0-9]+[0-9]$/.test(spec.region), 'Invalid GCP project or region.');
  for (const key of ['api', 'worker', 'migrationJob', 'hostingSite']) assert(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(spec[key]), 'Invalid GCP resource name.');
  assert(spec.registry.startsWith(`${spec.region}-docker.pkg.dev/${spec.project}/`) && /^[a-z0-9/.-]+$/.test(spec.registry), 'Registry must belong to the deployment project and region.');
  const origin = new URL(spec.origin);
  assert(origin.protocol === 'https:' && origin.origin === spec.origin, 'Hosting verification requires an exact HTTPS origin.');
  assert(published?.image === plan.config.server.image && published.version === plan.versions.server && /^sha256:[a-f0-9]{64}$/.test(published.digest), 'GCP deployment requires the confirmed image publication receipt.');
  return { image: `${spec.registry}@${published.digest}`, source: `${published.image}@${published.digest}` };
}

/** Confirm service rollout and the revision digest; runtime startup probes must already have succeeded. */
export function verifyRun(service, revision, image) {
  const name = service.status?.latestReadyRevisionName;
  assert(name && name === service.status.latestCreatedRevisionName && service.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'), 'Cloud Run revision is not ready.');
  assert(revision.metadata?.name === name && revision.status?.imageDigest === image, 'Cloud Run is running a different image.');
  return name;
}

/** Resolve the unique linux/amd64 manifest Cloud Run executes while retaining the published index as deployment provenance. */
export function runtimeImage(image, manifest) {
  if (!manifest.manifests) { assert(manifest.config?.digest, 'Invalid image manifest.'); return image; }
  const platform = manifest.manifests.filter(value => value.platform?.os === 'linux' && value.platform?.architecture === 'amd64');
  assert(platform.length === 1 && /^sha256:[a-f0-9]{64}$/.test(platform[0].digest), 'Image must contain one linux/amd64 manifest.');
  return image.split('@')[0] + '@' + platform[0].digest;
}

/** Execute once per unconfirmed deployment attempt; never roll back a database or publish Hosting before readiness. */
export async function deployGcp(spec, published, plan, env = process.env, execute = run, fetcher = fetch) {
  const value = gcpInputs(spec, published, plan), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-gcp-'));
  let resolvedImage;
  /** Capture credential-bearing command output and bound every external command. */
  const command = (binary, args, options = {}) => execute(binary, args, { env, timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  /** Run gcloud against the declared project and region without changing its default configuration. */
  const cloud = args => command('gcloud', [...args, `--project=${spec.project}`, '--quiet', '--format=json']);
  /** Read back the exact successfully probed Cloud Run revision. */
  const ready = name => {
    const service = JSON.parse(cloud(['run', 'services', 'describe', name, `--region=${spec.region}`]));
    const revision = JSON.parse(cloud(['run', 'revisions', 'describe', service.status.latestReadyRevisionName, `--region=${spec.region}`]));
    return { service, revision: verifyRun(service, revision, resolvedImage) };
  };
  /** Check application and schema health on the selected HTTPS endpoint without following redirects. */
  const health = async (origin, revision) => {
    const response = await fetcher(`${origin}/api/ready`, { redirect: 'error', signal: AbortSignal.timeout(55000), headers: { 'Cache-Control': 'no-cache' } });
    const data = await response.json();
    assert(response.ok && data.status === 'ok' && data.version === plan.versions.server && data.revision === revision, 'Deployed application version, revision or schema readiness differs.');
  };
  try {
    const token = command('gcloud', ['auth', 'print-access-token']).trim(), registryHost = spec.registry.split('/')[0], auth = path.join(directory, 'auth.json');
    assert(token && env.GHCR_TOKEN && env.GITHUB_ACTOR, 'Registry publication credentials are required.');
    fs.writeFileSync(auth, JSON.stringify({ auths: { [registryHost]: { auth: Buffer.from(`oauth2accesstoken:${token}`).toString('base64') }, 'ghcr.io': { auth: Buffer.from(`${env.GITHUB_ACTOR}:${env.GHCR_TOKEN}`).toString('base64') } } }), { mode: 0o600 });
    const tag = `${spec.registry}:run-${plan.run}`;
    command('skopeo', ['copy', '--all', '--preserve-digests', '--authfile', auth, `docker://${value.source}`, `docker://${tag}`]);
    assert(command('skopeo', ['inspect', '--authfile', auth, '--format', '{{.Digest}}', `docker://${tag}`]).trim() === published.digest, 'Registry copy changed the immutable image digest.');
    resolvedImage = runtimeImage(value.image, JSON.parse(command('skopeo', ['inspect', '--raw', '--authfile', auth, `docker://${value.image}`])));
    cloud(['run', 'jobs', 'update', spec.migrationJob, `--region=${spec.region}`, `--image=${value.image}`]);
    const migrated = JSON.parse(cloud(['run', 'jobs', 'execute', spec.migrationJob, `--region=${spec.region}`, '--wait']));
    assert(migrated.status?.conditions?.some(c => c.type === 'Completed' && c.status === 'True'), 'Migration execution did not complete.');
    cloud(['run', 'services', 'update', spec.worker, `--region=${spec.region}`, `--image=${value.image}`]);
    const worker = ready(spec.worker);
    cloud(['run', 'services', 'update-traffic', spec.worker, `--region=${spec.region}`, `--to-revisions=${worker.revision}=100`]);
    const tagName = `release-${plan.run}`;
    cloud(['run', 'services', 'update', spec.api, `--region=${spec.region}`, `--image=${value.image}`, '--no-traffic', `--tag=${tagName}`]);
    const api = ready(spec.api), url = api.service.status.traffic?.find(t => t.tag === tagName && t.revisionName === api.revision)?.url;
    assert(url?.startsWith('https://') && new URL(url).hostname.endsWith('.run.app'), 'Missing verified revision URL.');
    await health(url, api.revision);
    cloud(['run', 'services', 'update-traffic', spec.api, `--region=${spec.region}`, `--to-revisions=${api.revision}=100`]);
    fs.mkdirSync(path.join(directory, 'public'));
    fs.writeFileSync(path.join(directory, 'firebase.json'), JSON.stringify({ hosting: { site: spec.hostingSite, public: 'public', rewrites: [{ source: '**', run: { serviceId: spec.api, region: spec.region, pinTag: true } }] } }));
    command('firebase', ['deploy', '--only', 'hosting', '--project', spec.project, '--config', path.join(directory, 'firebase.json'), '--non-interactive', '--json'], { cwd: directory });
    assert(ready(spec.api).revision === api.revision, 'API changed during Hosting publication.');
    await health(spec.origin, api.revision);
    return { image: value.image, apiRevision: api.revision, workerRevision: worker.revision, migration: migrated.metadata?.name, healthy: true, origin: spec.origin };
  } catch { throw new Error('GCP deployment failed or is uncertain. Native/OTA delivery is blocked for this attempt; a fresh release remains available.'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
