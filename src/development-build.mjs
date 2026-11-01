/** @file Reuse compatible EAS Dev clients across commits and await native builds without blocking the worker event loop. */
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { assert } from './engine.mjs';
import { eas, publisher } from './eas.mjs';

/** Match the full native runtime and installation identity independently of source commit or build status. */
function compatible(build, plan, expo) {
  const applicationId = plan.platform === 'android' ? expo.android?.package : expo.ios?.bundleIdentifier;
  return build?.id && build.app?.id === plan.config.mobile.projectId
    && build.appIdentifier === applicationId && applicationId?.endsWith('.development')
    && build.buildProfile === plan.config.development.easProfile && build.platform?.toLowerCase() === plan.platform
    && build.distribution === 'INTERNAL' && !build.isForIosSimulator
    && build.runtime?.version === expo.runtimeVersion && /^[a-f0-9]{40,64}$/.test(expo.runtimeVersion);
}

/** Verify finished clients; automatic previews may reuse another commit, while new and explicit builds require their exact source. */
export function verifyDevelopmentBuild(build, plan, expo, { sameSource = plan.operation !== 'auto' } = {}) {
  assert(compatible(build, plan, expo) && build.status === 'FINISHED'
    && (!sameSource || build.gitCommitHash === plan.source), 'Development build identity or preview runtime differs.');
  return build;
}

/** Reconcile automatic builds by full fingerprint before enqueueing once; provider read failures never imply a cache miss. */
export async function developmentBuild(info, plan, command = eas, wait = delay) {
  const spec = plan.config.development;
  const inert = publisher({ ...plan.config, profiles: { development: spec } }, 'development');
  try {
    let accepted;
    if (plan.operation === 'auto') {
      for (let offset = 0; ; offset += 50) {
        assert(offset < 1000, 'Too many matching development builds to reconcile.');
        const batch = command(['build:list', '--platform', plan.platform, '--build-profile', spec.easProfile,
          '--runtime-version', info.runtimeVersion, '--fingerprint-hash', info.runtimeVersion,
          '--app-identifier', info.applicationId, '--distribution', 'internal', '--limit', '50', '--offset', String(offset), '--non-interactive', '--json'], inert);
        assert(Array.isArray(batch), 'Malformed EAS development build list.');
        const matches = batch.filter(build => compatible(build, plan, info.expo) && build.fingerprint?.hash === info.runtimeVersion
          && (!build.expirationDate || Date.parse(build.expirationDate) > Date.now()));
        const finished = matches.find(build => build.status === 'FINISHED');
        if (finished) return verifyDevelopmentBuild(finished, plan, info.expo);
        accepted ??= matches.find(build => ['NEW', 'IN_QUEUE', 'IN_PROGRESS'].includes(build.status));
        if (batch.length < 50) break;
      }
    }
    const sameSource = !accepted;
    if (!accepted) {
      const result = command(['build', '--platform', plan.platform, '--profile', spec.easProfile, '--non-interactive', '--no-wait', '--json'], info.app,
        { environment: { ...info.env, EAS_NO_VCS: '0' } });
      const builds = Array.isArray(result) ? result : [result];
      assert(builds.length === 1 && builds[0]?.id, 'Development build acceptance is uncertain; retry will check EAS before building.');
      accepted = builds[0];
    }
    console.error(`EAS development build ${accepted.id}`);
    for (let attempt = 0; attempt < 480; attempt++) {
      const build = command(['build:view', accepted.id, '--json'], inert);
      assert(build?.id === accepted.id, 'Development build response ID differs.');
      if (build.status === 'FINISHED') return verifyDevelopmentBuild(build, plan, info.expo, { sameSource });
      assert(['NEW', 'IN_QUEUE', 'IN_PROGRESS'].includes(build.status), `EAS development build ${accepted.id} ${build.status}; retry the failed job to build again.`);
      await wait(15000);
    }
    throw new Error(`EAS development build ${accepted.id} is still pending; retry the failed job to resume waiting.`);
  } finally { fs.rmSync(inert, { recursive: true, force: true }); }
}
