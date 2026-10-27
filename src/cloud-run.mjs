/** @file Deploy a confirmed immutable image to Cloud Run, with migration jobs and Hosting promotion owned by the release engine. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './engine.mjs';
import { run } from './io.mjs';

/** Reject unbound image/project/destination inputs before any registry, migration, or traffic mutation. */
export function cloudRunInputs(spec, publication, release, env) {
  const project = env.GCP_PROJECT_ID, attempt = env.GITHUB_RUN_ATTEMPT || '1';
  assert(/^\d+$/.test(attempt), 'Invalid workflow attempt.');
  assert(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? ''), 'Configure GCP_PROJECT_ID in the protected deployment environment.');
  for (const name of [spec.service, spec.repository, spec.migrationJob, ...(spec.jobs ?? [])]) assert(/^[a-z][a-z0-9-]{0,62}$/.test(name ?? ''), 'Invalid Cloud Run resource name.');
  assert(/^[a-z]+-[a-z]+[0-9]$/.test(spec.region ?? '') && /^\d+$/.test(release.run), 'Invalid region or release identity.');
  assert(/^ghcr.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(publication?.image ?? '') && /^sha256:[a-f0-9]{64}$/.test(publication?.digest ?? ''), 'A confirmed publication digest is required.');
  assert(/^\/[a-zA-Z0-9/_-]*$/.test(release.healthPath ?? ''), 'Invalid readiness path.');
  const origin = new URL(release.origin);
  assert(origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Invalid public origin.');
  return { project, registry: spec.region + '-docker.pkg.dev', image: spec.region + '-docker.pkg.dev/' + project + '/' + spec.repository + '/' + spec.service,
    revision: spec.service + '-r' + release.run + '-a' + attempt, tag: 'release-' + release.run, origin: origin.origin };
}

/** Mirror exact bytes, migrate before serving, verify the isolated revision, and promote only a healthy deployment. */
export async function deployCloudRun(spec, publication, release, env = process.env, execute = run, fetcher = fetch) {
  const value = cloudRunInputs(spec, publication, release, env);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-cloud-run-'));
  const auth = path.join(temporary, 'auth.json'), image = value.image + '@' + publication.digest;
  /** Capture provider output and bound every subprocess; sanitized outer failures never disclose credentials. */
  const command = (binary, args, options = {}) => execute(binary, args, { timeout: 900000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  /** Scope every gcloud operation explicitly to the configured installation and region. */
  const cloud = args => command('gcloud', [...args, '--project', value.project, '--region', spec.region, '--quiet']);
  try {
    fs.chmodSync(temporary, 0o700);
    command('skopeo', ['login', '--authfile', auth, '--username', env.GITHUB_ACTOR, '--password-stdin', 'ghcr.io'], { input: env.GHCR_TOKEN });
    const token = command('gcloud', ['auth', 'print-access-token', '--quiet']).trim();
    command('skopeo', ['login', '--authfile', auth, '--username', 'oauth2accesstoken', '--password-stdin', value.registry], { input: token });
    command('skopeo', ['copy', '--all', '--preserve-digests', '--authfile', auth, 'docker://' + publication.image + '@' + publication.digest, 'docker://' + value.image + ':run-' + release.run]);
    const mirrored = command('skopeo', ['inspect', '--authfile', auth, '--format', '{{.Digest}}', 'docker://' + image]).trim();
    assert(mirrored === publication.digest, 'Mirrored digest differs from the publication receipt.');
    cloud(['run', 'jobs', 'update', spec.migrationJob, '--image', image]);
    cloud(['run', 'jobs', 'execute', spec.migrationJob, '--wait']);
    cloud(['run', 'services', 'update', spec.service, '--image', image, '--revision-suffix', value.revision.slice(spec.service.length + 1), '--no-traffic', '--tag', value.tag]);
    const revision = JSON.parse(cloud(['run', 'revisions', 'describe', value.revision, '--format=json']));
    assert(revision.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') &&
      (revision.status.imageDigest === image || revision.status.imageDigest === publication.digest), 'New revision does not confirm the exact healthy image.');
    const service = JSON.parse(cloud(['run', 'services', 'describe', spec.service, '--format=json']));
    const preview = service.status?.traffic?.find(traffic => traffic.tag === value.tag && traffic.revisionName === value.revision)?.url;
    assert(preview && new URL(preview).hostname.endsWith('.run.app'), 'Missing isolated revision URL.');
    const ready = await fetcher(preview + release.healthPath, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert(ready.ok, 'New revision failed database readiness.');
    for (const job of spec.jobs ?? []) cloud(['run', 'jobs', 'update', job, '--image', image]);
    cloud(['run', 'services', 'update-traffic', spec.service, '--to-revisions', value.revision + '=100', '--remove-tags', value.tag]);
    fs.mkdirSync(path.join(temporary, 'empty'));
    const config = path.join(temporary, 'firebase.json');
    fs.writeFileSync(config, JSON.stringify({ hosting: { site: value.project, public: 'empty', rewrites: [{ source: '**', run: { serviceId: spec.service, region: spec.region } }] } }));
    command('firebase', ['deploy', '--only', 'hosting', '--project', value.project, '--config', config, '--non-interactive', '--json']);
    const live = await fetcher(value.origin + release.healthPath, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert(live.ok, 'Public Hosting readiness failed.');
    return { project: value.project, service: spec.service, revision: value.revision, image, healthy: true, evidence: 'cloud-run-revision-and-hosting-readiness' };
  } catch { throw new Error('Cloud Run deployment failed or is uncertain; inspect its revision and job execution before retrying. No success baseline was recorded.'); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
