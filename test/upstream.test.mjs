/** @file Verify pinned EAS signing, build/submission and publication interfaces without authenticating or publishing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, readJson, hash, inventory } from '../src/io.mjs';
import { publisher } from '../src/eas.mjs';
import { installedEas } from '../src/ios-signing.mjs';
import { config } from './helpers.mjs';
const cli = process.env.EXPO_RELEASE_TEST_EAS;
/** Invoke only version/help commands against the installed upstream CLI. */
function command(args) { return cli === 'eas' ? run('eas', args) : run(process.execPath, [cli, ...args]); }

test('official EAS version and public command flags match the adapter contract', { skip: !cli }, () => {
  assert.match(command(['--version']), /eas-cli\/25\.3\.0/);
  for (const [name, flags] of Object.entries({
    build: ['--json', '--freeze-credentials', '--non-interactive', '--[no-]wait'],
    'build:view': ['--json'], 'build:version:get': ['--json', '--platform'],
    'build:list': ['--git-commit-hash', '--build-profile', '--offset', '--limit', '--json', '--non-interactive'],
    submit: ['--id', '--path', '--[no-]wait', '--non-interactive'],
    'submit:list': ['--platform', '--offset', '--limit', '--json', '--non-interactive'], 'submit:view': ['--json'],
    update: ['--input-dir', '--skip-bundler', '--environment', '--json'],
    'env:pull': ['--path', '--environment', '--non-interactive']
  })) {
    const help = command([name, '--help']); for (const flag of flags) assert.ok(help.includes(flag), `${name} needs ${flag}`);
  }
  assert.ok(!command(['submit', '--help']).includes('--json'), 'submission acknowledgement uses the documented provider URL');
});

test('official EAS OTA preflight accepts inert exported metadata without installing or rewriting anything', { skip: !cli }, async t => {
  const upstream = installedEas(cli), value = config();
  const root = publisher(value, 'production', { updatesVersion: '57.0.8', expo: { sdkVersion: '57.0.0', version: '1.2.3', runtimeVersion: '1',
    updates: { url: `https://u.expo.dev/${value.mobile.projectId}` }, extra: { releaseVersion: '1.2.3' } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exp = readJson(path.join(root, 'app.json')).expo, before = hash(inventory(root));
  // Exercise installed upstream preflight functions only; no provider client or publication is invoked.
  assert.equal(upstream('./build/project/projectUtils.js').isExpoUpdatesInstalledOrAvailable(root, exp.sdkVersion), true);
  await upstream('./build/update/configure.js').ensureEASUpdateIsConfiguredAsync({ exp, projectId: value.mobile.projectId,
    projectDir: root, platform: 'android', vcsClient: {}, manifestHostOverride: null });
  const runtimes = await upstream('./build/project/publish.js').getRuntimeVersionInfoObjectsAsync({ exp, projectDir: root,
    platforms: ['android'], workflows: { android: 'managed' }, env: {} });
  assert.equal(runtimes[0].runtimeVersionInfo.runtimeVersion, '1');
  assert.equal(hash(inventory(root)), before);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

test('pinned EAS profile refresh updates only the assigned profile using the supplied certificate', { skip: !cli }, async () => {
  const upstream = installedEas(cli);
  for (const [file, name] of [['commandUtils/context/contextUtils/createGraphqlClient', 'createGraphqlClient'], ['project/projectUtils', 'getOwnerAccountForProjectIdAsync'],
    ['credentials/context', 'CredentialsContext'], ['credentials/ios/actions/BuildCredentialsUtils', 'getBuildCredentialsAsync'],
    ['credentials/ios/actions/BuildCredentialsUtils', 'assignBuildCredentialsAsync'], ['credentials/ios/actions/CreateProvisioningProfile', 'CreateProvisioningProfile'],
    ['credentials/ios/actions/AscApiKeyUtils', 'tryAuthenticateAppStoreWithEasAscApiKeyAsync'],
    ['credentials/ios/validators/validateProvisioningProfile', 'validateProvisioningProfileAsync'], ['credentials/ios/utils/provisioningProfile', 'parse']])
    assert.equal(typeof upstream(`./build/${file}.js`)[name], 'function', name);
  const { ConfigureProvisioningProfile } = upstream('./build/credentials/ios/actions/ConfigureProvisioningProfile.js');
  const { IosDistributionType } = upstream('./build/graphql/generated.js');
  assert.equal(IosDistributionType.AppStore, 'APP_STORE');
  const calls = [], app = { account: { name: 'owner' }, projectName: 'app', bundleIdentifier: 'app.example.mobile' };
  const certificate = { developerPortalIdentifier: 'cert', certificateP12: 'fixture', certificatePassword: 'fixture', serialNumber: 'serial' };
  const profile = { id: 'eas-profile', developerPortalIdentifier: 'apple-profile', provisioningProfile: 'old-fixture' };
  const context = { nonInteractive: true, graphqlClient: {}, appStore: { authCtx: { team: { id: 'team' } },
    /** Model an Apple read returning the original invalid profile. */
    async listProvisioningProfilesAsync(bundle) { assert.equal(bundle, app.bundleIdentifier); calls.push('list'); return [{ provisioningProfileId: 'apple-profile' }]; },
    /** Verify upstream regeneration preserves all supplied certificate identity and material. */
    async useExistingProvisioningProfileAsync(bundle, saved, cert) {
      assert.equal(bundle, app.bundleIdentifier); assert.equal(saved.provisioningProfileId, 'apple-profile');
      assert.deepEqual(cert, { certId: 'cert', certP12: 'fixture', certPassword: 'fixture', distCertSerialNumber: 'serial', teamId: 'team' });
      calls.push('regenerate'); return { provisioningProfileId: 'new-apple-profile', provisioningProfile: 'new-fixture' };
    } }, ios: {
    /** Verify the adapter saves the regenerated bytes to the existing EAS profile assignment. */
    async updateProvisioningProfileAsync(client, id, input) {
      assert.equal(id, 'eas-profile'); assert.deepEqual(input, { appleProvisioningProfile: 'new-fixture', developerPortalIdentifier: 'new-apple-profile' });
      calls.push('save'); return { ...profile, ...input };
    },
  } };
  await new ConfigureProvisioningProfile(app, {}, certificate, profile).runAsync(context);
  assert.deepEqual(calls, ['list', 'regenerate', 'save']);
});
