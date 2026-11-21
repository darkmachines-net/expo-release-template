/** @file Apply the toolkit's native fingerprint policy locally and in EAS cloud builds. */
module.exports = {
  sourceSkips: ['ExpoConfigVersions', 'ExpoConfigRuntimeVersionIfString'],
  fileHookTransform: require('@darkmachines-net/expo-release/expo').fingerprintTransform
};
