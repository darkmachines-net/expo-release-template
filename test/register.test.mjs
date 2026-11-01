/** @file Prove stale clients cannot evaluate native application imports, including missing metadata and production-mode previews. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/consumer/register.cjs', import.meta.url), 'utf8');
const current = '990184966b601da700453559663f669ba3ca3e68', stale = '929ac1321b5dc407d281bac31ac6696036d82600';

/** Execute the shipped entrypoint with independent binary and manifest metadata and observable import/registration order. */
function launch({ platform = 'android', installed = current, manifest = JSON.stringify({ runtimeVersion: current }), client = true, dev = true, nativeThrows = false, appThrows = false } = {}) {
  const events = [], module = { exports: {} };
  let registered, tree;
  const modules = {
    'react-native': { Platform: { OS: platform }, NativeModules: client ? { EXDevLauncher: { manifestString: manifest } } : {}, ScrollView: 'ScrollView', Text: 'Text',
      AppRegistry: {
        /** Capture the fallback root and render its native-only recovery instructions. */
        registerComponent(name, getComponent) { assert.equal(name, 'main'); events.push('blocked'); tree = getComponent()(); }
      } },
    'expo-modules-core': {
      /** Simulate the installed binary, independently of the downloaded manifest. */
      requireOptionalNativeModule(name) { assert.equal(name, 'ExpoUpdates'); events.push('native'); if (nativeThrows) throw Error('native unavailable'); return installed === null ? null : { runtimeVersion: installed }; }
    },
    react: {
      /** Preserve visible text for assertions without installing a React renderer. */
      createElement(type, props, ...children) { return { type, props, children }; }
    },
    expo: {
      /** Record successful Expo registration after the app's lazy import. */
      registerRootComponent(component) { registered = component; events.push('registered'); }
    }
  };
  vm.runInNewContext(source, { module, __DEV__: dev, console: {
    /** Keep expected compatibility diagnostics out of the test runner output. */
    warn() {}
  },
    /** Permit only known platform dependencies, retaining import order as evidence. */
    require(name) { events.push(name); assert.ok(modules[name], `Unexpected import ${name}`); return modules[name]; } });
  module.exports.registerRootComponent(() => {
    events.push('app'); if (appThrows) throw Error("Cannot find native module 'ExpoApplication'"); return 'App';
  });
  return { events, registered, text: JSON.stringify(tree) };
}

for (const platform of ['android', 'ios']) for (const dev of [true, false]) {
  test(`${platform} ${dev ? 'Metro' : 'hosted preview'} blocks a stale binary before an import that would crash`, () => {
    const result = launch({ platform, dev, installed: stale, appThrows: true });
    assert.ok(!result.events.includes('app')); assert.ok(!result.events.includes('expo'));
    assert.match(result.text, /Development client update required/);
    assert.ok(result.text.includes(stale)); assert.ok(result.text.includes(current));
  });
  test(`${platform} ${dev ? 'Metro' : 'hosted preview'} registers a matching binary after checking it`, () => {
    const result = launch({ platform, dev });
    assert.equal(result.registered, 'App');
    assert.ok(result.events.indexOf('native') < result.events.indexOf('app'));
    assert.equal(result.events.filter(value => value === 'app').length, 1);
    assert.ok(!result.events.includes('blocked'));
  });
}

test('missing, invalid and unreadable compatibility metadata fails closed without guessing from the bundle', () => {
  for (const change of [{ installed: null }, { installed: '' }, { installed: ' ' }, { nativeThrows: true },
    { manifest: 'null' }, { manifest: '{broken' }, { manifest: '{}' }, { manifest: JSON.stringify({ runtimeVersion: { policy: 'fingerprint' } }) }]) {
    const result = launch({ ...change, appThrows: true });
    assert.ok(!result.events.includes('app')); assert.ok(result.events.includes('blocked'));
  }
});

test('web, Expo Go and release binaries use normal Expo registration without reading development runtime metadata', () => {
  for (const options of [{ platform: 'web' }, { client: false }, { client: false, dev: false }]) {
    const result = launch({ ...options, installed: stale });
    assert.equal(result.registered, 'App'); assert.ok(!result.events.includes('native'));
  }
});

test('matching-client application errors are not swallowed or misreported as incompatibility', () => {
  assert.throws(() => launch({ appThrows: true }), /Cannot find native module 'ExpoApplication'/);
});
