/** @file Select development builds/updates from confirmed deployments and retain per-attempt duplicate protection. */
import { assert } from './engine.mjs';
import { hash } from './io.mjs';

/** Identify the development destination independently of source commits and release versions. */
export function developmentScope(plan) {
  const spec = plan.config.development;
  return hash({ project: plan.config.mobile.projectId, channel: spec.channel, environment: spec.environment,
    profile: spec.easProfile, platform: plan.platform });
}

/** Read confirmed development baselines; pending and failed attempts never block a fresh run. */
export async function developmentHistory(client, plan) {
  const history = {}, scope = developmentScope(plan);
  for (const record of await client.pages('deployments?task=expo-development-v1')) {
    const payload = record.payload;
    if (payload?.scope !== scope || history[payload.operation]) continue;
    const [status] = await client.api('GET', `deployments/${record.id}/statuses?per_page=1`);
    if (status?.state === 'success') history[payload.operation] = { ...payload, url: status.environment_url };
  }
  return history;
}

/** Rebuild only changed native runtimes; new native inputs also require a matching hosted bundle. */
export function selectDevelopment(runtime, bundle, history = {}) {
  const build = history.build?.input !== runtime;
  return { build, update: build || history.update?.input !== bundle };
}

/** Reuse confirmed current-run operations; permit a later attempt after a lost acknowledgement, never a same-attempt duplicate. */
export async function performDevelopment(client, plan, operation, execute, attempt = process.env.GITHUB_RUN_ATTEMPT || '1') {
  const input = operation === 'build' ? plan.runtime : plan.bundle;
  const payload = { scope: developmentScope(plan), operation, input, source: plan.source, run: plan.run, toolkit: plan.toolkit, attempt };
  const records = await client.pages('deployments?task=expo-development-v1');
  for (const record of records) {
    if (record.payload?.scope !== payload.scope || record.payload.run !== plan.run || record.payload.operation !== operation) continue;
    const { attempt: previousAttempt, ...previous } = record.payload;
    const { attempt: _attempt, ...identity } = payload;
    assert(hash(previous) === hash(identity), 'Development operation identity changed within its run.');
    const [status] = await client.api('GET', `deployments/${record.id}/statuses?per_page=1`);
    if (status?.state === 'success') return status.environment_url;
    assert(Number(previousAttempt) < Number(attempt), 'Development operation already attempted in this workflow attempt.');
  }
  const record = await client.api('POST', 'deployments', { ref: plan.source, task: 'expo-development-v1', auto_merge: false,
    required_contexts: [], environment: `development/${plan.platform}/${operation}`, production_environment: false, payload });
  assert(Number.isSafeInteger(record.id), 'GitHub did not return a development deployment ID.');
  const url = await execute();
  assert(typeof url === 'string' && url.startsWith('https://expo.dev/'), 'Missing development provider result URL.');
  await client.api('POST', `deployments/${record.id}/statuses`, { state: 'success', auto_inactive: false, environment_url: url,
    log_url: `https://github.com/${plan.repository}/actions/runs/${plan.run}`, description: 'Verified development operation completed.' });
  return url;
}
