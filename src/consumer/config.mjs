/** @file Validate release destinations and native builder groups; EAS owns build/submit profiles. */
import Ajv from 'ajv';
import { readJson, within, sourceEnvironment, hash } from '../io.mjs';
import { assert } from '../engine.mjs';
const validate = new Ajv({ allErrors: true }).compile(readJson(new URL('../../schemas/release.config.schema.json', import.meta.url)));

/** Load only JSON, rejecting unsupported legacy contracts before any source or provider operation. */
export function loadConfig(root = process.cwd()) {
  const value = readJson(within(root, 'release.config.json'));
  assert(validate(value), `Invalid release.config.json: ${JSON.stringify(validate.errors)}`);
  assert(value.mobile || value.server, 'Configure at least one release path.');
  for (const file of [...value.metadataFiles, ...(value.mobile?.inputs ?? []), ...(value.server?.inputs ?? []), value.mobile?.directory, value.server?.dockerfile].filter(Boolean)) within(root, file);
  for (const profile of Object.values(value.profiles)) {
    assert(profile.approvalEnvironment, 'Publication needs a protected environment.');
    sourceEnvironment(profile.publicEnvironment);
    if (value.mobile) assert(profile.channel && profile.easProfile, 'Mobile profiles need channel and easProfile.');
    if (value.server) assert(profile.deployEnvironment, 'Deployment needs a protected environment.');
  }
  if (value.development) {
    assert(value.mobile && !value.profiles.development, 'Development previews are separate from release profiles.');
    sourceEnvironment(value.development.publicEnvironment);
    assert(value.development.publicEnvironment.EXPO_RELEASE_VARIANT === 'development', 'Development needs its explicit native variant.');
  }
  if (value.mobile) {
    for (const profile of Object.values(value.profiles)) for (const id of Object.keys(profile.submitProfiles ?? {}))
      assert(value.mobile.targets.some(target => target.id === id), 'Submission override names an unknown native target.');
    assert(new Set(value.mobile.targets.map(t => t.id)).size === value.mobile.targets.length, 'Duplicate native target.');
    const commands = value.mobile.targets.filter(t => targetBuilder(value, t) === 'command');
    assert(!commands.length || (value.hooks?.buildPrepare && value.hooks?.build && value.hooks?.verify), 'Command builds require preparation, build and verification hooks.');
    assert(commands.every(t => t.platform === 'android'), 'Command builds support Android only.');
    assert(!commands.length || value.mobile.targets.every(t => t.id !== 'pair'), 'The pair matrix ID is reserved for command builds.');
    assert(value.mobile.pairCodeFloor === undefined || (commands.length === 2
      && value.mobile.targets.every(t => t.platform === 'android' || (t.buildNumberFloor ?? 0) <= value.mobile.pairCodeFloor)),
    'Paired codes require two Android command-build targets and a floor covering iOS build numbers.');
    assert(!commands.length || commands.length === value.mobile.targets.length || value.mobile.pairCodeFloor !== undefined,
      'Mixed native builders require paired local build numbers.');
  }
  return value;
}

/** Resolve a target override while preserving existing app-wide builder defaults. */
export function targetBuilder(config, target) { return target.builder ?? config.mobile.builder ?? 'eas'; }

/** Build Android command targets together and cloud targets independently in the same release. */
export function nativeMatrix(config) {
  const targets = config.mobile?.targets ?? [];
  return [
    ...(targets.some(t => targetBuilder(config, t) === 'command') ? [{ id: 'pair', platform: 'android', builder: 'command' }] : []),
    ...targets.filter(t => targetBuilder(config, t) === 'eas').map(t => ({ ...t, builder: 'eas' })),
  ];
}

/** Require explicit local reservations for paired releases and remote increments for ordinary cloud builds. */
export function verifyCounters(config, easConfig, buildProfile) {
  if (config.mobile.pairCodeFloor !== undefined) assert(easConfig.cli?.appVersionSource === 'local'
    && buildProfile.autoIncrement === false && (buildProfile.ios?.autoIncrement ?? false) === false
    && (buildProfile.android?.autoIncrement ?? false) === false,
  'Paired releases require local reserved counters with autoIncrement disabled.');
  else if (nativeMatrix(config).some(t => t.builder === 'eas')) assert(easConfig.cli?.appVersionSource === 'remote' && buildProfile.autoIncrement === true,
    'Ordinary EAS builds require remote managed counters with autoIncrement enabled.');
}

/** Add derived platforms without growing the configuration DSL. */
export function configured(config) {
  return { ...config, ...(config.mobile ? { mobile: { ...config.mobile, platforms: [...new Set(config.mobile.targets.map(t => t.platform))] } } : {}) };
}

/** Require package and workflow installation to name the exact immutable toolkit revision. */
export function verifyPins(root, sha) {
  assert(/^[a-f0-9]{40}$/.test(sha), 'Toolkit must be pinned to a full commit SHA.');
  const packageJson = readJson(within(root, 'package.json'));
  const dependency = packageJson.devDependencies?.['@mchartier/expo-release'] ?? packageJson.dependencies?.['@mchartier/expo-release'];
  assert(dependency === `git+https://github.com/darkmachines-net/expo-release-template.git#${sha}`, 'Package/workflow toolkit pins differ.');
  const lock = readJson(within(root, 'package-lock.json'));
  assert(lock.packages?.['node_modules/@mchartier/expo-release']?.resolved?.endsWith(`#${sha}`), 'Regenerate the consumer dependency lock normally.');
}

/** Verify that source-generated plans cannot redirect the trusted publisher to other destinations. */
export function verifyPlan(plan, config, identity) {
  assert(plan.format === 3 && hash(plan.config) === hash(config) && plan.repository === identity.repository
    && plan.source === identity.source && plan.toolkit === identity.toolkit && plan.run === identity.run, 'Plan producer or configured destination differs.');
}
