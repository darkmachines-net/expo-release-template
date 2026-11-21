/** @file Configure the example app's major runtime and bundle metadata with the shared Expo helpers. */
const { runtimeVersion, developmentConfig } = require('@darkmachines-net/expo-release/expo');
/** Add runtime and bundle version metadata to the standard Expo configuration. */
module.exports = ({ config }) => developmentConfig({ ...config, runtimeVersion: runtimeVersion(config.version), extra: { ...config.extra, releaseVersion: config.version } });
