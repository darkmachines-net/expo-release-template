/** @file Pair development clients with sealed previews and default-branch channel updates, without store releases. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assert } from './engine.mjs';
import { git, run, readJson, writeJson, within, sourceEnvironment, hash, seal, verify, inputIdentity } from './io.mjs';
import { loadConfig, verifyPins } from './consumer/config.mjs';
import { hook } from './consumer/source.mjs';
import { eas, publisher, readEnvironments } from './eas.mjs';
import { hostedIdentity, output } from './worker.mjs';
import { github } from './github.mjs';
import { developmentHistory, selectDevelopment, performDevelopment } from './development-history.mjs';

/** Build an ephemeral provider configuration; development never becomes a release selection profile. */
export function developmentProvider(config) {
  assert(config.mobile && config.development, 'Configure development builds before running previews.');
  return { ...config, profiles: { development: config.development } };
}

/** Resolve a repository branch or full SHA once; later jobs and retries keep the resulting commit. */
export function resolveDevelopmentSource(root, requested, fallback) {
  const selected = requested?.trim() || fallback;
  try {
    const isCommit = /^[a-f0-9]{40}$/i.test(selected);
    const ref = isCommit ? selected.toLowerCase() : 'refs/remotes/origin/' + selected;
    if (!isCommit) git(root, ['check-ref-format', ref]);
    const source = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}']);
    assert(/^[a-f0-9]{40}$/.test(source), 'Missing source commit.');
    return source;
  } catch {
    throw new Error('Development source must be an existing branch in this repository or a full commit SHA. Push the branch before building.');
  }
}

/** Pin a preview source or a default-branch-only channel update without reserving release versions. */
export function developmentPlan(config, identity, { source = identity.source, operation, platform, attempt, channel = '' }) {
  developmentProvider(config);
  assert(/^[a-f0-9]{40}$/.test(source), 'Development source must be a full commit SHA.');
  assert(['build', 'update', 'auto'].includes(operation) && config.development.platforms.includes(platform), 'Unsupported development operation or platform.');
  assert(/^[1-9]\d*$/.test(attempt), 'Invalid workflow attempt.');
  assert(operation !== 'auto' || channel && config.development.promotionEnvironment, 'Automatic development requires a channel and promotion gate.');
  assert(!channel || channel === config.development.channel && ['update', 'auto'].includes(operation) && source === identity.source
    && !Object.values(config.profiles).some(profile => profile.channel === channel), 'Channel updates require the configured development destination and workflow commit.');
  return { ...identity, config, source, workflowSource: identity.source, operation, platform,
    ...(channel ? { channel } : { branch: `preview-${identity.run}-${attempt}` }), profile: 'development' };
}

/** Reject store profiles, implicit channels and configuration overrides before authenticated EAS evaluation. */
export function verifyDevelopmentProfile(easConfig, spec) {
  const profile = easConfig.build?.[spec.easProfile];
  assert(profile?.developmentClient === true && profile.distribution === 'internal'
    && profile.autoIncrement === false && !profile.channel && !profile.extends
    && profile.environment === spec.environment, 'Development requires a channel-free internal dev-client profile without version increments.');
  assert(Object.entries(profile.env ?? {}).every(([key, value]) => spec.publicEnvironment[key] === value), 'Development profile env differs from declared public inputs.');
  for (const platform of ['android', 'ios']) {
    const value = profile[platform] ?? {};
    assert(!value.env && !value.channel && !value.developmentClient && !value.autoIncrement
      && !value.distribution && !value.gradleCommand && !value.buildConfiguration && !value.simulator,
    'Development platform overrides cannot replace its native build contract.');
  }
}

/** Resolve the source configuration and exact native fingerprint with the consumer's installed SDK and no credentials. */
export function inspectDevelopment(root, plan) {
  assert(git(root, ['rev-parse', 'HEAD']) === plan.source, 'Preview source changed.');
  const current = loadConfig(root), config = plan.config, spec = config.development;
  assert(hash(current.development) === hash(spec) && hash(current.mobile) === hash(config.mobile), 'Preview source changed its trusted development destinations.');
  const app = within(root, config.mobile.directory), require = createRequire(path.join(app, 'package.json'));
  verifyDevelopmentProfile(readJson(path.join(app, 'eas.json')), spec);
  require.resolve('expo-dev-client/package.json');
  const env = sourceEnvironment({ ...spec.publicEnvironment, ...plan.environment,
    EAS_BUILD_PROFILE: spec.easProfile, EAS_BUILD_PLATFORM: plan.platform, EXPO_UPDATES_WORKFLOW_OVERRIDE: 'managed' });
  const cli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli');
  const expo = JSON.parse(run(process.execPath, [cli, 'config', '--type', 'public', '--json'], { cwd: app, env }));
  assert(expo.extra?.eas?.projectId === config.mobile.projectId && expo.owner === config.mobile.owner && expo.slug === config.mobile.slug,
    'Development Expo project differs.');
  assert(expo.runtimeVersion?.policy === 'fingerprint' && !expo.updates?.requestHeaders?.['expo-channel-name'], 'Development previews require fingerprint runtimes without a release channel.');
  const applicationId = plan.platform === 'android' ? expo.android?.package : expo.ios?.bundleIdentifier;
  assert(applicationId?.endsWith('.development'), 'Development must have a separate application identity.');
  const resolver = path.join(path.dirname(require.resolve('expo-updates/package.json')), 'bin/cli');
  const { runtimeVersion } = JSON.parse(run(process.execPath, [resolver, 'runtimeversion:resolve', '--platform', plan.platform, '--workflow', 'managed'], { cwd: app, env }));
  assert(/^[a-f0-9]{40,64}$/.test(runtimeVersion), 'Missing development fingerprint runtime.');
  return { app, cli, env, expo: { ...expo, runtimeVersion }, runtimeVersion, applicationId, updatesVersion: require('expo-updates/package.json').version };
}

/** Verify a finished development client's source, identity and runtime against its exported preview. */
export function verifyDevelopmentBuild(build, plan, expo) {
  const applicationId = plan.platform === 'android' ? expo.android?.package : expo.ios?.bundleIdentifier;
  assert(build?.id && build.status === 'FINISHED' && build.app?.id === plan.config.mobile.projectId
    && build.gitCommitHash === plan.source && build.appIdentifier === applicationId && applicationId?.endsWith('.development')
    && build.buildProfile === plan.config.development.easProfile && build.platform?.toLowerCase() === plan.platform
    && build.distribution === 'INTERNAL' && !build.isForIosSimulator
    && build.runtime?.version === expo.runtimeVersion && /^[a-f0-9]{40,64}$/.test(expo.runtimeVersion),
  'Development build identity or preview runtime differs.');
  return build;
}

/** Publish sealed bytes to a preview branch or declared development channel; builds require a matching client. */
export function publishDevelopment(plan, directory, command = eas, build) {
  verify(directory, plan, 'development');
  assert(!plan.channel || plan.channel === plan.config.development.channel && ['update', 'auto'].includes(plan.operation)
    && plan.source === plan.workflowSource && !Object.values(plan.config.profiles).some(profile => profile.channel === plan.channel),
  'Channel updates require the configured development destination and workflow commit.');
  const info = readJson(path.join(directory, 'development.json'));
  assert(info.expo?.extra?.eas?.projectId === plan.config.mobile.projectId && info.platform === plan.platform
    && /^[a-f0-9]{40,64}$/.test(info.expo.runtimeVersion) && /^\d+\.\d+\.\d+/.test(info.updatesVersion), 'Preview artifact metadata differs.');
  const applicationId = plan.platform === 'android' ? info.expo.android?.package : info.expo.ios?.bundleIdentifier;
  assert(applicationId?.endsWith('.development'), 'Preview must retain its development identity.');
  if (plan.operation === 'build' || plan.buildRequired) verifyDevelopmentBuild(build, plan, info.expo);
  const root = publisher(developmentProvider(plan.config), 'development', { target: { applicationId }, expo: info.expo, updatesVersion: info.updatesVersion });
  try {
    const result = command(['update', ...(plan.channel ? ['--channel', plan.channel] : ['--branch', plan.branch]), '--environment', plan.config.development.environment,
      '--platform', plan.platform, '--message', `preview:${plan.source}`, '--input-dir', path.resolve(directory),
      '--skip-bundler', '--non-interactive', '--json'], root);
    assert(Array.isArray(result) && result.length === 1 && result[0].group && result[0].platform === plan.platform
      && result[0].runtimeVersion === info.expo.runtimeVersion, 'Preview acknowledgement differs.');
    return result[0];
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Execute manual previews or protected push updates; source export never receives an Expo token. */
export async function developmentWorker(phase, root, state) {
  const file = path.join(state, 'development.json');
  if (phase === 'context') {
    const config = loadConfig(root), identity = hostedIdentity(config, process.env, ['workflow_dispatch', 'push']);
    verifyPins(root, identity.toolkit);
    assert(process.env.GITHUB_EVENT_NAME !== 'push' || process.env.PREVIEW_CHANNEL, 'Push updates require a development channel.');
    const plan = process.env.RELEASE_REUSE === 'true' ? readJson(file) : developmentPlan(config, identity, { source: resolveDevelopmentSource(root, process.env.PREVIEW_SOURCE, identity.source),
      operation: process.env.PREVIEW_OPERATION, platform: process.env.PREVIEW_PLATFORM, attempt: process.env.GITHUB_RUN_ATTEMPT, channel: process.env.PREVIEW_CHANNEL });
    assert(plan.workflowSource === identity.source && plan.toolkit === identity.toolkit && plan.run === identity.run, 'Restored development context differs.');
    if (plan.operation === 'auto' && process.env.RELEASE_REUSE !== 'true') plan.history = await developmentHistory(github(config.repository), plan);
    if (process.env.RELEASE_REUSE !== 'true') writeJson(file, plan);
    output('approval', config.development.approvalEnvironment); output('source', plan.source);
    return;
  }
  const plan = ['build', 'publish'].includes(phase) ? readJson('artifacts/development-plan.json') : readJson(file), spec = plan.config.development;
  const identity = hostedIdentity(plan.config, process.env, ['workflow_dispatch', 'push']);
  assert(plan.run === identity.run && plan.toolkit === identity.toolkit && plan.workflowSource === identity.source
    && plan.repository === identity.repository, 'Development context belongs to another run.');
  if (process.env.RELEASE_REUSE === 'true') {
    if (phase === 'export') {
      const saved = readJson('artifacts/development-plan.json');
      output('build', saved.buildRequired); output('update', saved.updateRequired);
    }
    return;
  }
  if (phase === 'environment') {
    plan.environment = readEnvironments(developmentProvider(plan.config)).development;
    writeJson(file, plan); return;
  }
  if (phase === 'install') {
    for (const command of plan.config.install) run(command[0], command.slice(1), { cwd: root, env: sourceEnvironment(), stdio: 'inherit' });
    return;
  }
  if (phase === 'publish') {
    assert(plan.updateRequired, 'No development update selected.');
    const build = plan.buildRequired ? readJson('artifacts/development-build.json') : undefined;
    const mobile = plan.config.mobile;
    /** Publish verified bundle bytes and retain the provider link as the successful development baseline. */
    const publish = async () => {
      const result = publishDevelopment(plan, path.resolve('artifacts/development'), eas, build);
      return `https://expo.dev/accounts/${mobile.owner}/projects/${mobile.slug}/updates/${result.group}`;
    };
    const url = plan.operation === 'auto' ? await performDevelopment(github(plan.repository), plan, 'update', publish) : await publish();
    const install = build ? `Install this [development client](https://expo.dev/accounts/${mobile.owner}/projects/${mobile.slug}/builds/${build.id}), then open its matching preview below.\n\n` : '';
    const destination = plan.channel ? `Channel: ${plan.channel}` : `Branch: ${plan.branch}`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${install}Open this [preview in the EAS dashboard](${url}) and scan its development-build QR code, or refresh Updates in the client and select the published update. Metro is not required.\n\n${destination}; source: ${plan.source}; runtime: ${plan.runtime}.\n`);
    return;
  }
  const info = inspectDevelopment(root, plan);
  if (phase === 'export') {
    plan.runtime = info.runtimeVersion;
    if (plan.operation === 'auto') {
      const custom = hook(root, plan.config, 'inspect', { source: plan.source, config: plan.config });
      plan.bundle = hash({ input: custom.js?.[plan.platform] ?? inputIdentity(root, plan.source, plan.config.mobile.inputs),
        runtime: plan.runtime, environment: { ...spec.publicEnvironment, ...plan.environment } });
      const selected = selectDevelopment(plan.runtime, plan.bundle, plan.history);
      plan.buildRequired = selected.build; plan.updateRequired = selected.update;
    } else { plan.buildRequired = plan.operation === 'build'; plan.updateRequired = true; }
    writeJson('artifacts/development-plan.json', plan);
    output('build', plan.buildRequired); output('update', plan.updateRequired);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Development ${plan.platform}: source ${plan.source}; runtime ${plan.runtime}. Native build: ${plan.buildRequired}; OTA update: ${plan.updateRequired}.\n\n`
      + Object.entries(plan.history ?? {}).map(([kind, value]) => `Previous successful ${kind}: ${value.url}\n\n`).join(''));
    if (!plan.updateRequired) return;
    const directory = path.resolve('artifacts/development');
    run(process.execPath, [info.cli, 'export', '--platform', plan.platform, '--output-dir', directory], { cwd: info.app, env: info.env, stdio: 'inherit' });
    writeJson(path.join(directory, 'development.json'), { expo: info.expo, platform: plan.platform, updatesVersion: info.updatesVersion });
    seal(directory, plan, 'development'); return;
  }
  assert(phase === 'build' && plan.buildRequired, 'Unknown development phase.');
  const directory = path.resolve('artifacts/development');
  verify(directory, plan, 'development');
  const bundle = readJson(path.join(directory, 'development.json'));
  assert(bundle.platform === plan.platform && hash(bundle.expo) === hash(info.expo), 'Development export configuration changed before build.');
  let build;
  /** Build once from this source, then confirm the native identity and exported runtime before recording success. */
  const create = async () => {
    const result = eas(['build', '--platform', plan.platform, '--profile', spec.easProfile, '--non-interactive', '--wait', '--json'], info.app,
      { environment: { ...info.env, EAS_NO_VCS: '0' } });
    const builds = Array.isArray(result) ? result : [result];
    assert(builds.length === 1, 'Expected one development build.');
    build = verifyDevelopmentBuild(builds[0], plan, bundle.expo);
    return `https://expo.dev/accounts/${plan.config.mobile.owner}/projects/${plan.config.mobile.slug}/builds/${build.id}`;
  };
  const url = plan.operation === 'auto' ? await performDevelopment(github(plan.repository), plan, 'build', create) : await create();
  if (!build) {
    const inert = publisher(developmentProvider(plan.config), 'development');
    try { build = verifyDevelopmentBuild(eas(['build:view', url.split('/').at(-1), '--json'], inert), plan, bundle.expo); }
    finally { fs.rmSync(inert, { recursive: true, force: true }); }
  }
  writeJson('artifacts/development-build.json', build);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Created [development build](https://expo.dev/accounts/${plan.config.mobile.owner}/projects/${plan.config.mobile.slug}/builds/${build.id}). Its hosted preview is ready only after the publish job succeeds.\n\nSource: ${plan.source}; native fingerprint: ${info.runtimeVersion}.\n`);
}
