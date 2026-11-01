/** @file Gate development-client startup on native/bundle runtime equality before evaluating application imports. */

/**
 * Register an Expo root loaded synchronously only after checking development-client compatibility.
 * Pass a callback containing require('./App').default, never a statically imported application.
 * Missing or mismatched native/manifest runtimes show a recovery screen without calling loadApp.
 * Web, Expo Go and release binaries retain Expo's normal registration and native update selection.
 */
function registerRootComponent(loadApp) {
  const { Platform, NativeModules, AppRegistry, ScrollView, Text } = require('react-native');
  const launcher = NativeModules.EXDevLauncher;
  if (Platform.OS !== 'web' && launcher) {
    let installed, required;
    try {
      // The manifest describes the bundle, never the installed binary. Read the latter from native code.
      required = JSON.parse(launcher.manifestString).runtimeVersion;
    } catch { /* Unreadable metadata cannot establish compatibility. */ }
    try {
      installed = require('expo-modules-core').requireOptionalNativeModule('ExpoUpdates')?.runtimeVersion;
    } catch { /* An unavailable native runtime must not fall back to bundle metadata. */ }
    if (typeof installed !== 'string' || !installed.trim() || typeof required !== 'string' || !required.trim() || installed !== required) {
      const { createElement } = require('react');
      const message = `Installed runtime: ${typeof installed === 'string' && installed || 'unavailable'}\nBundle runtime: ${typeof required === 'string' && required || 'unavailable'}`;
      console.warn(`[expo-release] Development client compatibility check blocked startup. ${message}`);
      /** Show recovery instructions using React Native primitives without importing application/native feature modules. */
      function IncompatibleClient() {
        return createElement(ScrollView, { style: { flex: 1, backgroundColor: '#fff' }, contentContainerStyle: { flexGrow: 1, justifyContent: 'center', padding: 28, paddingVertical: 64 } },
          createElement(Text, { accessibilityRole: 'header', style: { fontSize: 24, fontWeight: 'bold', color: '#111', marginBottom: 16 } }, 'Development client update required'),
          createElement(Text, { style: { fontSize: 17, color: '#111', marginBottom: 20 } },
            'This bundle cannot run in the installed development client. Build and install a compatible development client, then reopen this project through its Expo development link.'),
          createElement(Text, { selectable: true, style: { fontSize: 13, color: '#333' } }, message));
      }
      AppRegistry.registerComponent('main', () => IncompatibleClient);
      return;
    }
  }
  require('expo').registerRootComponent(loadApp());
}

module.exports = { registerRootComponent };
