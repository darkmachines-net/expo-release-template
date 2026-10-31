/** @file Publish working-copy previews and prepare portable native development servers with explicit connection settings. */
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
import { isIPv4 } from 'node:net';

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

/**
 * Prepare Metro argv and a credential-free environment for a consumer-owned local process supervisor.
 * Public overrides may supply local API/proxy settings; declared development identity takes precedence.
 * An explicit port is forwarded unchanged; host is an advertised LAN IPv4 address, not a binding URL.
 */
export function developmentServer(root, { port, host, clear = false, web = false, publicEnvironment = {} } = {}) {
  const config = loadConfig(root); developmentProvider(config);
  const app = path.resolve(root, config.mobile.directory), require = createRequire(path.join(app, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli');
  assert(port === undefined || /^\d+$/.test(String(port)) && Number(port) >= 1024 && Number(port) <= 65535, 'Development port must be between 1024 and 65535.');
  assert(host === undefined || isIPv4(host) && !/^(0\.|127\.|169\.254\.)/.test(host), 'Development host must be a LAN IPv4 address.');
  const env = sourceEnvironment({ ...publicEnvironment, ...config.development.publicEnvironment,
    EAS_BUILD_PROFILE: config.development.easProfile, ...(host ? { REACT_NATIVE_PACKAGER_HOSTNAME: host } : {}) });
  delete env.CI;
  return { command: process.execPath, args: [cli, 'start', '--dev-client', '--lan',
    ...(port === undefined ? [] : ['--port', String(port)]), ...(clear ? ['--clear'] : []), ...(web ? ['--web'] : [])], cwd: app, env };
}

/** Start Metro with the shared development identity and optional explicit port/LAN host on Windows or POSIX. */
export function startDevelopment(root, options) {
  const server = developmentServer(root, options);
  run(server.command, server.args, { cwd: server.cwd, env: server.env, stdio: 'inherit' });
}
