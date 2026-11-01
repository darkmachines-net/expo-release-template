/** @file Independent selection, monotonic versions and stale-native OTA rejection across failed or successful builds. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelease, increment, nextPair, compareVersions, assertCompatible } from '../src/engine.mjs';
import { config, observation, history } from './helpers.mjs';

test('fresh cutover creates a new major and no OTA to legacy runtimes', () => {
  const result = selectRelease(config(), 'production', observation());
  assert.equal(result.bump, 'major'); assert.equal(result.versions.mobile, '1.0.0');
  assert.equal(result.runtime, '1'); assert.equal(result.native, true); assert.deepEqual(result.ota, []);
  assert.equal(result.server, true); assert.equal(result.versions.server, '1.2.4');
  assert.ok(result.operations.includes('production/build/android'));
  assert.ok(result.operations.includes('production/build/ios'));
});

test('no-op does not reserve versions or publish', () => {
  const result = selectRelease(config(), 'production', observation(), history());
  assert.equal(result.noop, true); assert.equal(result.bump, null);
  assert.deepEqual(result.operations, []); assert.deepEqual(result.versions, { server: '1.2.4', mobile: '1.0.0' });
});

test('server-only change increments its independent patch', () => {
  const input = observation(); input.server = 'server-B';
  const result = selectRelease(config(), 'production', input, history());
  assert.equal(result.server, true); assert.equal(result.native, false); assert.deepEqual(result.ota, []);
  assert.equal(result.versions.server, '1.2.5'); assert.equal(result.versions.mobile, '1.0.0');
});

test('platform JS change publishes one OTA and one shared patch version', () => {
  const input = observation(); input.js.ios = 'js-B';
  const result = selectRelease(config(), 'production', input, history());
  assert.deepEqual(result.ota, ['ios']); assert.equal(result.bump, 'patch');
  assert.equal(result.runtime, '1'); assert.equal(result.versions.mobile, '1.0.1');
  assert.equal(result.native, false); assert.equal(result.server, false);
});

test('compatibility changes build all enabled platforms with a new major', () => {
  const input = observation(); input.family = 'family-B'; input.fingerprints.production.ios = 'new';
  const result = selectRelease(config(), 'production', input, history());
  assert.equal(result.versions.mobile, '2.0.0'); assert.equal(result.runtime, '2');
  assert.deepEqual(result.ota, []);
  assert.ok(result.operations.includes('production/build/android'));
  assert.ok(result.operations.includes('production/build/ios'));
});

test('a bundle importing a new native module cannot target old clients, even after a failed rebuild', () => {
  const input = observation(), previous = history();
  input.family = 'with-ExpoApplication'; input.js.android = input.js.ios = 'imports-ExpoApplication';
  input.fingerprints.production = { android: 'c'.repeat(40), ios: 'd'.repeat(40) };
  const first = selectRelease(config(), 'production', input, previous);
  assert.equal(first.runtime, '2'); assert.equal(first.native, true); assert.deepEqual(first.ota, []);
  // A reservation advances the family/version, but an unsuccessful build leaves the old native baselines.
  previous.mobile = { version: first.versions.mobile, family: input.family };
  const retry = selectRelease(config(), 'production', input, previous);
  assert.equal(retry.runtime, '2'); assert.equal(retry.native, true); assert.deepEqual(retry.ota, []);
  for (const platform of ['android', 'ios']) {
    const stale = previous.baselines[`production/build/${platform}`];
    const required = { runtime: retry.runtime, fingerprint: input.fingerprints.production[platform] };
    assert.throws(() => assertCompatible(stale, required), /compatibility/);
    assert.throws(() => assertCompatible({ ...stale, runtime: required.runtime }, required), /compatibility/);
    previous.baselines[`production/build/${platform}`] = required;
  }
  // Only confirmed matching native builds make the new bundle eligible for that runtime.
  const compatible = selectRelease(config(), 'production', input, previous);
  assert.equal(compatible.native, false); assert.deepEqual(compatible.ota, ['android', 'ios']);
});

test('requested compatible rebuild allocates minor and OTA for the same runtime', () => {
  const result = selectRelease(config(), 'production', observation(), history(), true);
  assert.equal(result.bump, 'minor'); assert.equal(result.versions.mobile, '1.1.0');
  assert.equal(result.runtime, '1'); assert.equal(result.native, true); assert.deepEqual(result.ota, ['android', 'ios']);
});

test('several binary versions share one major runtime and later OTA patches', () => {
  const previous = history(); previous.mobile.version = '1.7.0';
  const input = observation(); input.js.android = input.js.ios = 'new-bundle';
  const result = selectRelease(config(), 'production', input, previous);
  assert.equal(result.versions.mobile, '1.7.1'); assert.equal(result.runtime, '1'); assert.equal(result.native, false);
  assertCompatible({ runtime: '1', fingerprint: 'native' }, { runtime: result.runtime, fingerprint: 'native' });
  assert.throws(() => assertCompatible({ runtime: '1', fingerprint: 'native' }, { runtime: '2', fingerprint: 'native' }), /compatibility/);
});

test('mixed work keeps server and mobile decisions independent', () => {
  const input = observation(); input.server = 'new-server'; input.js.android = 'new-js';
  const result = selectRelease(config(), 'production', input, history());
  assert.equal(result.versions.server, '1.2.5'); assert.equal(result.versions.mobile, '1.0.1');
  assert.deepEqual(result.ota, ['android']); assert.equal(result.native, false);
});

test('failed and abandoned reservations consume versions', () => {
  const previous = history(); previous.mobile.version = '1.0.8'; previous.server.version = '1.2.9';
  const input = observation(); input.server = 'new'; input.js.ios = 'new';
  const result = selectRelease(config(), 'production', input, previous);
  assert.deepEqual(result.versions, { server: '1.2.10', mobile: '1.0.9' });
  assert.equal(result.runtime, '1');
});

test('failed first binary release retries with consumed major and new minor', () => {
  const previous = { mobile: { version: '1.0.0', family: 'family-A' }, baselines: {} };
  const result = selectRelease(config(), 'production', observation(), previous);
  assert.equal(result.native, true); assert.equal(result.versions.mobile, '1.1.0'); assert.deepEqual(result.ota, []);
});

test('native build success establishes compatibility without store completion', () => {
  const previous = history();
  const input = observation(); input.js.ios = 'new';
  const result = selectRelease(config(), 'production', input, previous);
  assert.deepEqual(result.ota, ['ios']); assert.equal(result.native, false);
});

test('unconfirmed delivery remains selected even with no further source changes', () => {
  const previous = history(); delete previous.baselines['production/js/android'];
  const result = selectRelease(config(), 'production', observation(), previous);
  assert.deepEqual(result.ota, ['android']); assert.equal(result.versions.mobile, '1.0.1');
  assert.equal(result.server, false); assert.equal(result.native, false);
});

test('profiles get independent success baselines without separate semantic versions', () => {
  const value = config(); value.profiles.internal = { ...value.profiles.production, submit: false };
  const input = observation(); input.fingerprints.internal = { ...input.fingerprints.production };
  const result = selectRelease(value, 'internal', input, history());
  assert.equal(result.versions.mobile, '1.1.0'); assert.equal(result.runtime, '1');
  assert.ok(!result.operations.some(key => key.includes('/submit/')));
});

test('Calibrate reserves odd/even numbers above seeded and failed reservations', () => {
  const value = config(); value.mobile.pairCodeFloor = 18; value.server.metadataOnNative = true;
  const previous = history(); previous.mobile.pairCodeFloor = 103;
  const result = selectRelease(value, 'production', observation(), previous, true);
  assert.deepEqual(result.pair, [105, 106]); assert.equal(result.server, true);
  assert.deepEqual(nextPair(18), [19, 20]); assert.deepEqual(nextPair(19), [21, 22]);
  for (const floor of [-1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => nextPair(floor));
});

test('serverless and server-only configurations need no unused provider', () => {
  const mobile = config(); delete mobile.server;
  const native = selectRelease(mobile, 'production', observation());
  assert.equal(native.server, false); assert.equal(native.versions.server, null);
  const server = config(); delete server.mobile;
  const result = selectRelease(server, 'production', observation());
  assert.equal(result.native, false); assert.deepEqual(result.ota, []); assert.equal(result.runtime, null);
});

test('version arithmetic rejects unsafe or ambiguous semver representations', () => {
  assert.equal(increment('1.9.9', 'minor'), '1.10.0'); assert.equal(increment('1.9.9', 'major'), '2.0.0');
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  for (const bad of ['1.2', '01.2.3', '1.2.3-beta', '9007199254740992.0.0']) assert.throws(() => increment(bad, 'patch'));
});
