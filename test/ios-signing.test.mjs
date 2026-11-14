/** @file Verify live signing failures, bounded profile refresh, certificate preservation and store entitlement checks without provider writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIosSigning, iosSigningTargets, permitsEntitlements } from '../src/ios-signing.mjs';
import { plan } from './helpers.mjs';

test.beforeEach(t => {
  const previous = process.env.EXPO_TOKEN;
  process.env.EXPO_TOKEN = 'test-token';
  t.after(() => { if (previous === undefined) delete process.env.EXPO_TOKEN; else process.env.EXPO_TOKEN = previous; });
});

/** Supply the pinned EAS interfaces with observable provider reads and a single permitted profile refresh. */
function fixture(t, options = {}) {
  t.mock.method(console, 'error', () => {});
  const release = plan(), target = release.config.mobile.targets[1], calls = [];
  release.iosSigning = { ios: [{ bundleIdentifier: target.applicationId, entitlements: { 'com.apple.developer.applesignin': ['Default'] } }] };
  const certificate = { id: 'certificate', serialNumber: 'serial', validityNotBefore: '2020-01-01', validityNotAfter: '2099-01-01', ...options.certificate };
  const profile = { ExpirationDate: '2099-01-01', Entitlements: { 'com.apple.developer.applesignin': ['Default'] }, ...options.profile };
  const before = { distributionCertificate: certificate, provisioningProfile: { id: 'profile', provisioningProfile: profile } };
  const after = options.after ?? { ...before, provisioningProfile: { ...before.provisioningProfile,
    provisioningProfile: { ...profile, ...options.repairedProfile } } };
  let repaired = false;
  const modules = {
    'createGraphqlClient.js': { /** Admit only the explicit workflow token, never a cached interactive session. */
      createGraphqlClient(auth) { assert.deepEqual(auth, { accessToken: 'test-token', sessionSecret: null }); return 'client'; } },
    'projectUtils.js': { /** Verify the lookup uses the configured EAS project. */
      async getOwnerAccountForProjectIdAsync(client, id) { assert.equal(id, release.config.mobile.projectId); return { name: options.owner ?? 'owner' }; } },
    'context.js': { CredentialsContext: class {
      /** Model a credential context that cannot create or revoke any signing material. */
      constructor(value) {
        assert.equal(value.nonInteractive, true);
        this.appStore = { /** Read only the existing distribution certificate list. */
          async listDistributionCertificatesAsync() { calls.push('certificates'); if (options.certificateReadError) throw new Error('Apple permission denied'); return options.revoked ? [] : [certificate]; } };
      }
    } },
    'BuildCredentialsUtils.js': { /** Return the assigned store profile, including a fresh read after mutation. */
      async getBuildCredentialsAsync(ctx, app, type) { assert.equal(type, 'APP_STORE'); calls.push('read'); return options.missingProfile ? { distributionCertificate: certificate } : repaired ? after : before; },
      /** Assign a replacement profile after Apple's previous profile ID disappeared, retaining the certificate. */
      async assignBuildCredentialsAsync(ctx, app, type, cert, profile) { assert.equal(cert, certificate); assert.equal(profile, after.provisioningProfile); calls.push('assign'); } },
    'AscApiKeyUtils.js': { /** Model missing or insufficient team-key authentication. */
      async tryAuthenticateAppStoreWithEasAscApiKeyAsync() { calls.push('authenticate'); return !options.missingAuth; } },
    'ConfigureProvisioningProfile.js': { ConfigureProvisioningProfile: class {
      /** Require regeneration to receive the exact assigned certificate and profile. */
      constructor(app, identity, cert, savedProfile) { assert.equal(cert, certificate); assert.equal(savedProfile, before.provisioningProfile); }
      /** Permit one scoped profile regeneration, with configurable lost acknowledgement or persistent failure. */
      async runAsync() { calls.push('refresh'); assert.equal(repaired, false); if (options.noRefresh) return null; repaired = true; if (options.refreshError) throw new Error('Apple response lost'); return after.provisioningProfile; }
    } },
    'CreateProvisioningProfile.js': { CreateProvisioningProfile: class {
      /** Require replacement profiles to use the same existing certificate. */
      constructor(app, identity, cert) { assert.equal(cert, certificate); }
      /** Model one replacement after confirmed absence, never an immediate retry of a failed write. */
      async runAsync() { assert.equal(repaired, false); calls.push('create'); repaired = true; return after.provisioningProfile; }
    } },
    'validateProvisioningProfile.js': { /** Model live profile validation independently of profile contents. */
      async validateProvisioningProfileAsync() { calls.push('validate'); if (options.validationError) throw new Error('Apple unavailable'); return options.invalid ? repaired && !options.stillInvalid : true; } },
    'provisioningProfile.js': { /** Decode the fixture's profile without emitting its content. */
      parse(value) { return value; } },
    'generated.js': { IosDistributionType: { AppStore: 'APP_STORE' } },
    'authenticateTypes.js': { AppleTeamType: { COMPANY_OR_ORGANIZATION: 'COMPANY_OR_ORGANIZATION' } },
  };
  /** Reject any unexpected upstream dependency instead of accessing credentials or the network. */
  const upstream = name => { const value = modules[name.split('/').at(-1)]; assert.ok(value, name); return value; };
  return { release, target, calls, before, after, upstream };
}

test('signing applies to iOS cloud builds only, including Calibrate mixed builders', () => {
  const release = plan();
  assert.deepEqual(iosSigningTargets(release).map(value => value.id), ['ios']);
  release.config.mobile.builder = 'command'; release.config.mobile.targets[1].builder = 'eas';
  assert.deepEqual(iosSigningTargets(release).map(value => value.id), ['ios']);
  release.native = false; assert.deepEqual(iosSigningTargets(release), []);
  delete release.config.mobile; assert.deepEqual(iosSigningTargets(release), []);
});

test('healthy profiles are checked live every time without mutation or persistent success caching', async t => {
  const value = fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) await checkIosSigning(value.release, value.target, { upstream: value.upstream });
  assert.deepEqual(value.calls, ['authenticate', 'read', 'certificates', 'validate', 'authenticate', 'read', 'certificates', 'validate']);
});

test('invalid profiles refresh once with the existing certificate and verify saved credentials again', async t => {
  const value = fixture(t, { invalid: true });
  const originalPlan = structuredClone(value.release);
  await checkIosSigning(value.release, value.target, { upstream: value.upstream });
  assert.deepEqual(value.calls, ['authenticate', 'read', 'certificates', 'validate', 'refresh', 'read', 'validate']);
  assert.deepEqual(value.release, originalPlan, 'Signing never changes release reservations or baselines.');
});

test('expired profiles and stale entitlement grants are refreshed and must pass readback', async t => {
  for (const profile of [{ ExpirationDate: '2020-01-01' }, { Entitlements: {} }]) {
    const updated = fixture(t, { profile, repairedProfile: {
      ExpirationDate: '2099-01-01', Entitlements: { 'com.apple.developer.applesignin': ['Default'] },
    } });
    await checkIosSigning(updated.release, updated.target, { upstream: updated.upstream });
    assert.equal(updated.calls.filter(call => call === 'refresh').length, 1);
  }
});

test('missing authentication, revoked/expired certificates and provider outages stop before any repair', async t => {
  for (const options of [{ missingAuth: true }, { missingProfile: true }, { revoked: true }, { certificateReadError: true },
    { certificate: { validityNotAfter: '2020-01-01' } }, { certificate: { validityNotBefore: '2099-01-01' } }, { validationError: true }]) {
    const value = fixture(t, options);
    await assert.rejects(checkIosSigning(value.release, value.target, { upstream: value.upstream }));
    assert.equal(value.calls.includes('refresh'), false, JSON.stringify(options));
  }
});

test('repair never loops, conceals lost acknowledgement, or accepts invalid readback', async t => {
  for (const options of [{ stillInvalid: true }, { refreshError: true }, { profile: { Entitlements: {} } }]) {
    const value = fixture(t, { invalid: true, ...options });
    await assert.rejects(checkIosSigning(value.release, value.target, { upstream: value.upstream }));
    assert.equal(value.calls.filter(call => call === 'refresh').length, 1);
    assert.equal(value.calls.includes('create'), false);
  }
  const changed = fixture(t, { invalid: true, after: { distributionCertificate: { id: 'replacement', serialNumber: 'other' }, provisioningProfile: {} } });
  await assert.rejects(checkIosSigning(changed.release, changed.target, { upstream: changed.upstream }), /changed the distribution certificate/);
});

test('a later attempt can replace an Apple profile missing after lost regeneration acknowledgement', async t => {
  const value = fixture(t, { invalid: true, noRefresh: true });
  await checkIosSigning(value.release, value.target, { upstream: value.upstream });
  assert.deepEqual(value.calls, ['authenticate', 'read', 'certificates', 'validate', 'refresh', 'create', 'assign', 'read', 'validate']);
});

test('read-only checks never repair and mismatched destinations fail before provider writes', async t => {
  const value = fixture(t, { invalid: true });
  await assert.rejects(checkIosSigning(value.release, value.target, { upstream: value.upstream, repair: false }), /needs refresh/);
  assert.equal(value.calls.includes('refresh'), false);
  value.release.iosSigning.ios[0].bundleIdentifier = 'other.app';
  await assert.rejects(checkIosSigning(value.release, value.target, { upstream: value.upstream }), /mismatched/);
  const wrongOwner = fixture(t, { owner: 'other' });
  await assert.rejects(checkIosSigning(wrongOwner.release, wrongOwner.target, { upstream: wrongOwner.upstream }), /owner differs/);
  assert.equal(wrongOwner.calls.length, 0);
});

test('entitlement checks handle HealthKit, Apple sign-in, domains and prefixed keychain groups without granting missing values', () => {
  const required = { 'com.apple.developer.healthkit': true, 'com.apple.developer.applesignin': ['Default'],
    'com.apple.developer.associated-domains': ['applinks:example.com'], 'keychain-access-groups': ['$(AppIdentifierPrefix)app.example'] };
  const granted = { ...required, 'com.apple.developer.associated-domains': ['*'], 'keychain-access-groups': ['TEAM.*'] };
  assert.equal(permitsEntitlements(required, granted, { AppIdentifierPrefix: 'TEAM.' }), true);
  assert.equal(permitsEntitlements(required, { ...granted, 'com.apple.developer.associated-domains': '*' }, { AppIdentifierPrefix: 'TEAM.' }), true);
  for (const key of Object.keys(required)) { const missing = { ...granted }; delete missing[key]; assert.equal(Boolean(permitsEntitlements(required, missing)), false); }
  assert.equal(permitsEntitlements(['allowed', 'extra'], ['allowed']), false);
  assert.equal(permitsEntitlements(['allowed', 'extra'], 'allowed'), false);
  assert.equal(permitsEntitlements(['allowed'], undefined), false);
  assert.equal(permitsEntitlements('OTHER.app', 'TEAM.*'), false);
});
