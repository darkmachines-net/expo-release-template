/** @file Public Expo configuration helpers for release runtimes, native fingerprints and separate development apps. */

/** Derive an OTA runtime from the major of a stable mobile release version. */
function runtimeVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected a stable mobile release version.');
  return version.split('.')[0];
}

/** Remove generated versions only; preserve native identities, permissions, plugins and environment. */
function fingerprintTransform(source, chunk) {
  if (source.type !== 'contents' || !chunk) return chunk;
  if (source.id === 'expoConfig') {
    const value = JSON.parse(String(chunk));
    delete value.version; delete value.runtimeVersion;
    if (value.android) delete value.android.versionCode;
    if (value.ios) delete value.ios.buildNumber;
    if (value.extra) delete value.extra.releaseVersion;
    return JSON.stringify(value);
  }
  return chunk;
}

/**
 * Select a separate installed development app with fingerprint-compatible previews and no OTA channel.
 * Release builds retain their exact configuration. Development installs never replace store apps.
 */
function developmentConfig(config, environment = process.env) {
  if (environment.EXPO_RELEASE_VARIANT !== 'development') return config;
  const requestHeaders = { ...config.updates?.requestHeaders };
  delete requestHeaders['expo-channel-name'];
  return { ...config, name: config.name + ' Dev', scheme: config.slug + '-dev',
    android: config.android && { ...config.android, package: config.android.package + '.development', intentFilters: [] },
    ios: config.ios && { ...config.ios, bundleIdentifier: config.ios.bundleIdentifier + '.development', associatedDomains: [] },
    runtimeVersion: { policy: 'fingerprint' },
    updates: { ...config.updates, requestHeaders },
    plugins: [...(config.plugins ?? []), ['expo-dev-client', { launchMode: 'launcher' }]] };
}

module.exports = { runtimeVersion, fingerprintTransform, developmentConfig };
