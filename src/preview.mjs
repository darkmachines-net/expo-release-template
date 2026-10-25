/** @file Publish a developer's current working copy to a unique preview branch without changing any release destination. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './consumer/config.mjs';
import { developmentProvider, inspectDevelopment, publishDevelopment } from './development.mjs';
import { readEnvironments } from './eas.mjs';
import { assert } from './engine.mjs';
import { git, run, writeJson, seal, sourceEnvironment } from './io.mjs';
import { createRequire } from 'node:module';

/** Build a local preview identity that explicitly records uncommitted work and never targets a persistent channel. */
export function localPreviewPlan(config, { source, dirty, platform, id = randomUUID() }) {
  developmentProvider(config);
  assert(config.development.platforms.includes(platform) && /^[a-f0-9]{40}$/.test(source), 'Unsupported preview platform or missing Git commit.');
  assert(/^[a-z0-9-]+$/.test(id), 'Invalid preview identifier.');
  return { config, repository: config.repository, source, dirty, platform, operation: 'update', profile: 'development',
    run: `local-${id}`, toolkit: 'local', branch: `preview-${id}` };
}

/** Export a working copy without credentials, recheck its native inputs, and publish its exact bytes from an inert project. */
export function preview(root, platform = 'android', adapters = {}) {
  const inspect = adapters.inspect ?? inspectDevelopment, execute = adapters.execute ?? run;
  const environments = adapters.environments ?? readEnvironments, publish = adapters.publish ?? publishDevelopment;
  const config = loadConfig(root), plan = localPreviewPlan(config, { source: git(root, ['rev-parse', 'HEAD']),
    dirty: Boolean(git(root, ['status', '--porcelain'])), platform });
  plan.environment = environments(developmentProvider(config)).development;
  const info = inspect(root, plan), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-development-preview-'));
  try {
    execute(process.execPath, [info.cli, 'export', '--platform', platform, '--output-dir', directory], { cwd: info.app, env: info.env, stdio: 'inherit' });
    assert(inspect(root, plan).runtimeVersion === info.runtimeVersion, 'Native inputs changed while exporting. Retry the preview.');
    writeJson(path.join(directory, 'development.json'), { expo: info.expo, platform, updatesVersion: info.updatesVersion,
      source: plan.source, dirty: plan.dirty });
    seal(directory, plan, 'development');
    const result = publish(plan, directory);
    const mobile = config.mobile;
    console.log(`Preview: https://expo.dev/accounts/${mobile.owner}/projects/${mobile.slug}/updates/${result.group}`);
    console.log(`Branch: ${plan.branch}\nNative runtime: ${info.runtimeVersion}\nSource: ${plan.source}${plan.dirty ? ' (uncommitted working copy)' : ''}`);
    console.log('Open Preview in the dashboard and scan its QR code with your development app. Rebuild that app if its native inputs differ.');
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(`${directory}.json`, { force: true });
  }
}

/** Start Metro with the development identity and declared public configuration on Windows or POSIX. */
export function startDevelopment(root) {
  const config = loadConfig(root); developmentProvider(config);
  const app = path.resolve(root, config.mobile.directory), require = createRequire(path.join(app, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli');
  const env = sourceEnvironment({ ...config.development.publicEnvironment, EAS_BUILD_PROFILE: config.development.easProfile });
  delete env.CI;
  run(process.execPath, [cli, 'start', '--dev-client'], { cwd: app, env, stdio: 'inherit' });
}
