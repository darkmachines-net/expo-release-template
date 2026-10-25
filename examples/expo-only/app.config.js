/** @file Explicit major runtime and bundle release metadata for a serverless application. */
const { runtimeVersion, developmentConfig } = require('@mchartier/expo-release/expo');
/** Add runtime and bundle version metadata to the standard Expo configuration. */
module.exports = ({ config }) => developmentConfig({ ...config, runtimeVersion: runtimeVersion(config.version), extra: { ...config.extra, releaseVersion: config.version } });
