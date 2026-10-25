/** @file Official EAS operations; isolated public readers reconcile accepted builds and their store submissions. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assert } from './engine.mjs';
import { run, readJson, writeJson, sourceEnvironment, verify } from './io.mjs';
export const EAS_VERSION = '25.3.0';

/** Run the pinned CLI, preserving submission diagnostics; only EAS Build evaluates authenticated source. */
export function eas(args, cwd, { json = true, environment = {}, execute = run } = {}) {
  const env = { ...sourceEnvironment(), EAS_NO_VCS: '1', EAS_PROJECT_ROOT: path.resolve(cwd), NO_COLOR: '1', ...environment, EXPO_TOKEN: process.env.EXPO_TOKEN };
  if (environment.EAS_NO_VCS === '0') { delete env.EAS_NO_VCS; delete env.EAS_PROJECT_ROOT; }
  let result;
  try { result = execute('eas', args, { cwd, env }); }
  catch (error) {
    if (args[0] === 'submit' && error.stdout) console.error(String(error.stdout));
    throw error;
  }
  return json ? JSON.parse(result) : result;
}

/** Create an inert publisher project from verified identities and EAS submit configuration. */
export function publisher(config, profile, { target, expo = {}, submit = {}, updatesVersion } = {}) {
  const mobile = config.mobile, selected = config.profiles[profile];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-publisher-'));
  const app = { ...expo, name: mobile.slug, owner: mobile.owner, slug: mobile.slug,
    extra: { ...expo.extra, eas: { projectId: mobile.projectId } },
    android: { ...expo.android, package: target?.applicationId ?? mobile.targets.find(t => t.platform === 'android')?.applicationId },
    ios: { ...expo.ios, bundleIdentifier: target?.applicationId ?? mobile.targets.find(t => t.platform === 'ios')?.applicationId } };
  for (const key of ['plugins', 'hooks', 'entryPoint', 'experiments']) delete app[key];
  writeJson(path.join(root, 'package.json'), { name: 'release-publisher', private: true, version: '1.0.0',
    ...(updatesVersion ? { dependencies: { 'expo-updates': updatesVersion } } : {}) });
  writeJson(path.join(root, 'app.json'), { expo: app });
  writeJson(path.join(root, 'eas.json'), { cli: { version: EAS_VERSION, requireCommit: false, appVersionSource: 'remote' },
    build: { [selected.easProfile]: { environment: selected.environment } }, submit });
  return root;
}

/** Pull only declared readable public build inputs through the supported dotenv interface. */
export function readEnvironments(config, command = eas) {
  const result = {};
  for (const [profile, spec] of Object.entries(config.profiles)) {
    if (!config.mobile) { result[profile] = spec.publicEnvironment ?? {}; continue; }
    const root = publisher(config, profile);
    try {
      const file = path.join(root, '.env.public');
      command(['env:pull', '--environment', spec.environment, '--path', file, '--non-interactive'], root, { json: false });
      const contents = fs.readFileSync(file, 'utf8');
      assert(!/^# .+=\*+ \(secret\)/m.test(contents) && !fs.existsSync(path.join(root, '.eas/.env')), 'Release environments must contain readable strings, not hidden secrets or files.');
      const values = parseEnv(contents);
      const allowed = new Set([...Object.keys(spec.publicEnvironment ?? {}), ...(config.mobile.publicVariables ?? [])]);
      for (const [key, value] of Object.entries(values)) {
        assert(allowed.has(key), `EAS input ${key} is not declared public.`);
        assert(spec.publicEnvironment?.[key] === undefined || spec.publicEnvironment[key] === value, `EAS input ${key} differs from its committed value.`);
      }
      const merged = { ...spec.publicEnvironment, ...values };
      sourceEnvironment(merged);
      result[profile] = merged;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  return result;
}

/** Verify remote managed counters before reserving a release; initialization remains an explicit EAS setup operation. */
export function verifyBuildFloors(config, command = eas) {
  if (!config.mobile || config.mobile.builder === 'command') return;
  const profile = Object.keys(config.profiles)[0], root = publisher(config, profile);
  try {
    const remote = command(['build:version:get', '--platform', config.mobile.targets.length === 2 ? 'all' : config.mobile.targets[0].platform,
      '--profile', config.profiles[profile].easProfile, '--json', '--non-interactive'], root);
    for (const target of config.mobile.targets) {
      const code = Number(remote[target.platform === 'android' ? 'versionCode' : 'buildNumber']);
      assert(Number.isSafeInteger(code) && code >= (target.buildNumberFloor ?? 0), 'Initialize EAS managed build numbers at or above the verified platform floors using eas build:version:set before releasing.');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Verify native identity from the public build:view JSON contract independently of store status. */
export function verifyBuild(build, plan, target) {
  const profile = plan.config.profiles[plan.profile];
  assert(build?.id && build.status === 'FINISHED' && build.app?.id === plan.config.mobile.projectId
    && build.appIdentifier === target.applicationId && build.platform?.toLowerCase() === target.platform
    && build.gitCommitHash === plan.build && build.buildProfile === profile.easProfile
    && build.appVersion === plan.versions.mobile && build.runtime?.version === plan.runtime
    && build.updateChannel?.name === profile.channel && !build.isForIosSimulator
    && build.fingerprint?.hash === plan.observation.fingerprints[plan.profile][target.platform], 'EAS build identity or native compatibility differs.');
  return build;
}

/**
 * Reuse this run's finished/pending cloud build; enqueue only when no usable build exists.
 * Public list/read failures stop the job, and each invocation makes at most one build request.
 * Status reads use an inert project, so monorepos need no root Expo config and reads never evaluate source.
 * EAS Build evaluates the consumer's source configuration with EXPO_TOKEN for existing
 * EAS-managed credentials. This authenticated evaluation is the explicit exception to
 * source-only execution; privileged submit/update publishers instead use inert projects.
 */
export async function cloudBuild(root, plan, target, command = eas) {
  const profile = plan.config.profiles[plan.profile];
  const inert = publisher(plan.config, plan.profile);
  try {
    const builds = [], message = `release:${plan.run}:${target.id}`;
    for (let offset = 0; ; offset += 50) {
      assert(offset < 1000, 'Too many matching EAS builds to reconcile.');
      const batch = command(['build:list', '--platform', target.platform, '--build-profile', profile.easProfile,
        '--git-commit-hash', plan.build, '--limit', '50', '--offset', String(offset), '--non-interactive', '--json'], inert);
      assert(Array.isArray(batch), 'Malformed EAS build list.');
      builds.push(...batch.filter(build => build.message === message));
      if (batch.length < 50) break;
    }
    for (const build of builds) assert(typeof build.id === 'string' && build.id && build.app?.id === plan.config.mobile.projectId && build.gitCommitHash === plan.build
      && build.platform?.toLowerCase() === target.platform && build.buildProfile === profile.easProfile
      && build.appIdentifier === target.applicationId, 'Accepted EAS build identity differs.');
    const accepted = builds.find(build => build.status === 'FINISHED')
      ?? builds.find(build => !['ERRORED', 'CANCELED'].includes(build.status));
    let id = accepted?.id;
    if (!id) {
      const result = command(['build', '--platform', target.platform, '--profile', profile.easProfile, '--message', message,
        '--non-interactive', '--freeze-credentials', '--no-wait', '--json'], path.join(root, plan.config.mobile.directory),
      { environment: { ...plan.environments[plan.profile], EAS_NO_VCS: '0' } });
      assert(Array.isArray(result) && result.length === 1 && result[0].id, 'EAS build acceptance is uncertain; retry will check EAS before building.');
      id = result[0].id;
    }
    console.error(`EAS build ${id}`);
    for (let attempt = 0; attempt < 480; attempt++) {
      const build = command(['build:view', id, '--json'], inert);
      if (build.status === 'FINISHED') return verifyBuild(build, plan, target);
      assert(!['ERRORED', 'CANCELED'].includes(build.status), `EAS build ${id} ${build.status}; retry the failed job to build again.`);
      await delay(15000);
    }
    throw new Error(`EAS build ${id} is still pending; retry the failed job to resume waiting.`);
  } finally { fs.rmSync(inert, { recursive: true, force: true }); }
}

/** Extract the exact project's submission ID from the CLI's documented provider URL. */
export function submissionId(output, mobile) {
  const matches = [...String(output).matchAll(/https:\/\/expo\.dev\/accounts\/([^/\s]+)\/projects\/([^/\s]+)\/submissions\/([a-f0-9-]{36})/gi)]
    .filter(m => decodeURIComponent(m[1]) === mobile.owner && decodeURIComponent(m[2]) === mobile.slug);
  const ids = [...new Set(matches.map(m => m[3]))];
  assert(ids.length === 1, 'Submission acknowledgement is uncertain; this run cannot confirm success.');
  return ids[0];
}

/**
 * Reconnect to an exact EAS build's matching store submission before enqueueing once.
 * Pending submissions resume waiting; failed ones can be replaced on explicit retry.
 * Current-run AAB uploads have no provider build identity and rely on saved GitHub receipts.
 */
export async function submit(plan, target, artifact, submitProfiles, command = eas, wait = delay) {
  const selected = plan.config.profiles[plan.profile];
  const profile = selected.submitProfiles?.[target.id] ?? target.submitProfile ?? selected.easProfile;
  const destination = submitProfiles[profile]?.[target.platform];
  assert(destination && (target.platform === 'android' ? destination.track : destination.ascAppId), 'Configure the exact EAS submission destination before release.');
  const root = publisher(plan.config, plan.profile, { target, submit: submitProfiles });
  try {
    if (artifact.buildId) {
      const matches = [];
      /** Match the exact provider build and store destination, rejecting corrupt identity or unknown status. */
      const matchesDestination = record => {
        assert(record?.id && record.app?.id === plan.config.mobile.projectId && record.platform?.toLowerCase() === target.platform
          && ['AWAITING_BUILD', 'IN_QUEUE', 'IN_PROGRESS', 'FINISHED', 'ERRORED', 'CANCELED'].includes(record.status), 'EAS submission identity or status differs.');
        if (record.submittedBuild?.id !== artifact.buildId) return false;
        verifyBuild(record.submittedBuild, plan, target);
        return target.platform === 'ios' ? record.iosConfig?.ascAppIdentifier === String(destination.ascAppId)
          : record.androidConfig?.track === destination.track && record.androidConfig?.releaseStatus === (destination.releaseStatus ?? 'completed').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
            && (record.androidConfig.rollout ?? null) === (destination.rollout ?? null);
      };
      for (let offset = 0; ; offset += 50) {
        assert(offset < 1000, 'Too many EAS submissions to reconcile.');
        const batch = command(['submit:list', '--platform', target.platform, '--limit', '50', '--offset', String(offset), '--non-interactive', '--json'], root);
        assert(Array.isArray(batch), 'Malformed EAS submission list.');
        matches.push(...batch.filter(matchesDestination));
        if (batch.length < 50) break;
      }
      const accepted = matches.find(record => record.status === 'FINISHED') ?? matches.find(record => !['ERRORED', 'CANCELED'].includes(record.status));
      if (accepted) {
        for (let attempt = 0; attempt < 480; attempt++) {
          const record = command(['submit:view', accepted.id, '--json'], root);
          assert(record?.id === accepted.id && matchesDestination(record), 'EAS submission destination differs.');
          if (record.status === 'FINISHED') return { id: record.id, destination, completed: true };
          assert(!['ERRORED', 'CANCELED'].includes(record.status), `EAS submission ${record.id} ${record.status}: ${record.error?.message ?? 'retry the failed job to submit again.'}`);
          await wait(15000);
        }
        throw new Error(`EAS submission ${accepted.id} is still pending; retry the failed job to resume waiting.`);
      }
    }
    const output = command(['submit', '--platform', target.platform, '--profile', profile,
      artifact.buildId ? '--id' : '--path', artifact.buildId ?? path.resolve(artifact.file), '--wait', '--non-interactive', '--no-auto-testflight-setup'], root, { json: false });
    return { id: submissionId(output, plan.config.mobile), destination, completed: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Publish an exact pre-exported current-runtime bundle without evaluating consumer configuration. */
export function update(plan, platform, directory, command = eas) {
  verify(directory, plan, `ota-${platform}`);
  const info = readJson(path.join(directory, 'expo-release.json'));
  assert(info.runtime === plan.runtime && info.version === plan.versions.mobile && info.platform === platform, 'OTA metadata differs from the release.');
  assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.updatesVersion ?? ''), 'Missing exported expo-updates version.');
  const root = publisher(plan.config, plan.profile, { expo: info.expo, updatesVersion: info.updatesVersion });
  const profile = plan.config.profiles[plan.profile];
  try {
    const result = command(['update', '--channel', profile.channel, '--environment', profile.environment, '--platform', platform,
      '--message', `release:${plan.run}:${plan.versions.mobile}`, '--input-dir', path.resolve(directory), '--skip-bundler', '--non-interactive', '--json'], root);
    assert(Array.isArray(result) && result.length === 1 && result[0].group && result[0].runtimeVersion === plan.runtime
      && result[0].platform === platform, 'OTA acknowledgement differs; this run cannot confirm success.');
    return result[0];
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
