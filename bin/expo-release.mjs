#!/usr/bin/env node
/** @file Validate releases, publish ad-hoc previews, or start native development with explicit LAN/port options. */
import { parseArgs } from 'node:util';
import { loadConfig, configured } from '../src/consumer/config.mjs';
import { selectRelease } from '../src/engine.mjs';
import { inspect } from '../src/consumer/source.mjs';
import { github, loadHistory } from '../src/github.mjs';
import { readJson, run } from '../src/io.mjs';
import { readEnvironments } from '../src/eas.mjs';
import { preview, startDevelopment } from '../src/preview.mjs';
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    platform: { type: 'string', default: 'android' }, profile: { type: 'string' }, history: { type: 'string' }, rebuild: { type: 'boolean', default: false }, help: { type: 'boolean' },
    port: { type: 'string' }, host: { type: 'string' }, clear: { type: 'boolean' }, web: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) console.log('expo-release validate | plan --profile NAME [--rebuild] [--history CONTEXT.json]\nexpo-release preview [--platform android|ios]\nexpo-release dev [--port PORT] [--host LAN_IPV4] [--clear] [--web]\nStore releases run through the protected GitHub workflow.');
  else {
    const root = process.cwd(), config = loadConfig(root);
    if (positionals[0] === 'validate') console.log('Release configuration is valid.');
    else if (positionals[0] === 'preview') preview(root, values.platform);
    else if (positionals[0] === 'dev') startDevelopment(root, values);
    else if (positionals[0] === 'plan') {
      const offline = values.history && readJson(values.history);
      const history = offline?.history ?? await loadHistory(github(config.repository, {
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run('gh', ['auth', 'token']).trim(),
      }));
      const environments = offline?.environments ?? readEnvironments(config);
      console.log(JSON.stringify(selectRelease(configured(config), values.profile, inspect(root, config, undefined, environments), history, values.rebuild), null, 2));
    } else throw new Error('Use validate, plan, preview, or dev. Store releases run through GitHub/EAS.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
