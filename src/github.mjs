/** @file Immutable release evidence with bounded read retries; provider writes remain single-attempt. */
import { setTimeout as delay } from 'node:timers/promises';
import { assert, compareVersions } from './engine.mjs';
import { hash } from './io.mjs';
const prefix = 'expo-release/v3/';

/** Create an authenticated client with transient GET retries; writes are never automatically retried. */
export function github(repository, { token = process.env.GITHUB_TOKEN, fetcher = fetch, wait = delay } = {}) {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  /** Retry transport/5xx read failures twice; only explicitly optional GETs treat 404 as absent. */
  const api = async (method, route, body, { optional = false, binary = false } = {}) => {
    let response;
    for (let attempt = 0; ; attempt++) {
      try { response = await fetcher(`${base}/${route}`, { method, headers: { ...headers, ...(binary ? { Accept: 'application/octet-stream' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
      catch (error) {
        if (method !== 'GET' || attempt === 2) throw new Error(`GitHub ${method} ${route.split('?')[0]}: ${error.message}`, { cause: error });
      }
      if (response && (response.status < 500 || method !== 'GET' || attempt === 2)) break;
      await response?.body?.cancel();
      await wait(1000 * 2 ** attempt);
      response = undefined;
    }
    if (method === 'GET' && optional && response.status === 404) return null;
    assert(response.ok, `GitHub ${method} ${route.split('?')[0]} failed (${response.status}); this run does not retry writes.`);
    return response.status === 204 ? null : response.json();
  };
  /** Collect a repository-relative list endpoint in API order; reject malformed or unbounded history. */
  const pages = async route => {
    const values = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      assert(Array.isArray(batch), 'GitHub list response is not an array.');
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error('Release history exceeds the supported GitHub pagination bound.');
  };
  return { api, pages,
    /** Read one immutable JSON asset; missing assets are distinct from failed or unauthorized reads. */
    async readEvidence(releaseId, name) {
      const assets = await pages(`releases/${releaseId}/assets`);
      const asset = assets.find(value => value.name === name);
      return asset ? api('GET', `releases/assets/${asset.id}`, undefined, { binary: true }) : null;
    },
    /** Retain JSON once; identical uploads are already complete and conflicting bytes are rejected. */
    async evidence(releaseId, name, value) {
      const saved = await this.readEvidence(releaseId, name);
      if (saved !== null) { assert(hash(saved) === hash(value), `Conflicting immutable evidence: ${name}.`); return; }
      const response = await fetcher(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      assert(response.ok, `Cannot retain release evidence (${response.status}); this run cannot confirm success.`);
      return response.json();
    },
  };
}

/** Reduce current-format reservations and confirmed successes; other outcomes neither advance baselines nor block fresh runs. */
export function historyFrom(records, deployments) {
  const history = { baselines: {} };
  const pairCodeFloor = Math.max(0, ...records.map(record => record.pairCodeFloor ?? 0));
  for (const record of records) {
    assert(record.format === 3 && record.source && record.run, 'Legacy or malformed release reservation.');
    for (const kind of ['server', 'mobile']) if (record.versions?.[kind]
      && (!history[kind] || compareVersions(record.versions[kind], history[kind].version) > 0)) {
      history[kind] = { version: record.versions[kind], family: record.family, pairCodeFloor: record.pairCodeFloor ?? 0 };
    }
  }
  if (history.mobile) history.mobile.pairCodeFloor = pairCodeFloor;
  // GitHub returns newest deployments first; never substitute a workflow conclusion for target status.
  for (const { payload, state } of deployments) {
    assert(payload?.format === 3 && typeof payload.key === 'string', 'Legacy or malformed deployment record.');
    if (state !== 'success' || history.baselines[payload.key]) continue;
    history.baselines[payload.key] = payload;
    if (payload.bundleKey && !history.baselines[payload.bundleKey]) history.baselines[payload.bundleKey] = { ...payload, input: payload.bundleInput };
    const jsKey = payload.bundleKey?.replace('/bundle/', '/js/') ?? (payload.key.includes('/ota/') ? payload.key.replace('/ota/', '/js/') : null);
    if (jsKey && !history.baselines[jsKey]) history.baselines[jsKey] = { ...payload, input: payload.bundleInput ?? payload.input };
  }
  return history;
}

/** Read immutable reservations and current deployment status using ordinary GitHub APIs. */
export async function loadHistory(client) {
  const refs = await client.api('GET', `git/matching-refs/tags/${prefix}run/`);
  const records = [];
  for (const ref of refs) {
    assert(ref.object.type === 'tag', 'Release reservations must be annotated tags.');
    const tag = await client.api('GET', `git/tags/${ref.object.sha}`);
    records.push(JSON.parse(tag.message));
  }
  const deployments = [];
  for (const deployment of await client.pages('deployments?task=expo-release-v3')) {
    const statuses = await client.api('GET', `deployments/${deployment.id}/statuses?per_page=1`);
    deployments.push({ ...deployment, state: statuses[0]?.state ?? 'pending' });
  }
  return historyFrom(records, deployments);
}

/** Finish a possibly interrupted reservation, accepting only identical existing tags and plan evidence. */
export async function reserve(client, plan) {
  const record = { format: 3, source: plan.source, build: plan.build, run: plan.run, toolkit: plan.toolkit,
    versions: plan.versions, family: plan.observation.family, pairCodeFloor: plan.pair?.[1] ?? 0 };
  const names = [`${prefix}run/${plan.run}`,
    ...(plan.bump ? [`${prefix}mobile/v${plan.versions.mobile}`] : []),
    ...(plan.server ? [`${prefix}server/v${plan.versions.server}`] : [])];
  for (const name of names) {
    const existing = await client.api('GET', `git/ref/tags/${name}`, undefined, { optional: true });
    if (existing) {
      assert(existing.object.type === 'tag', 'Reservation is not an annotated tag.');
      const saved = await client.api('GET', `git/tags/${existing.object.sha}`);
      assert(saved.object.sha === plan.build && hash(JSON.parse(saved.message)) === hash(record), 'Conflicting release reservation.');
      continue;
    }
    const tag = await client.api('POST', 'git/tags', { tag: name, message: JSON.stringify(record), object: plan.build, type: 'commit' });
    await client.api('POST', 'git/refs', { ref: `refs/tags/${name}`, sha: tag.sha });
  }
  const release = await client.api('GET', `releases/tags/${names[0]}`, undefined, { optional: true }) ?? await client.api('POST', 'releases', { tag_name: names[0], name: `Release ${plan.versions.mobile ?? plan.versions.server} · ${plan.profile}`,
    body: `Source: ${plan.source}\nBuild: ${plan.build}\nRun: https://github.com/${plan.repository}/actions/runs/${plan.run}`,
    draft: false, prerelease: true, make_latest: 'false' });
  await client.evidence(release.id, 'plan.json', plan);
  return release.id;
}

/** Describe one fixed operation, including enough input identity to advance only its own baseline. */
export function operationPayload(plan, operation) {
  const [kind, id] = operation.split('/');
  const target = plan.config.mobile?.targets.find(t => t.id === id);
  const platform = target?.platform ?? id;
  return { format: 3, key: `${plan.profile}/${operation}`, source: plan.source, build: plan.build, run: plan.run,
    toolkit: plan.toolkit, runtime: plan.runtime, version: target || kind === 'ota' ? plan.versions.mobile : plan.versions.server,
    input: id === 'server' ? plan.observation.server : plan.observation.js[platform],
    fingerprint: plan.observation.fingerprints[plan.profile]?.[platform] ?? null,
    ...(kind === 'build' ? { bundleKey: `${plan.profile}/bundle/${platform}`, bundleInput: plan.observation.js[platform] } : {}),
    destination: id === 'server' ? plan.config.server.image : target?.applicationId ?? plan.config.profiles[plan.profile].channel };
}

/** Record intent once per workflow attempt; only a later explicit job retry may repeat unconfirmed work. */
export async function begin(client, plan, operation, attempt = process.env.GITHUB_RUN_ATTEMPT || '1') {
  const payload = operationPayload(plan, operation);
  const previous = await client.pages('deployments?task=expo-release-v3');
  for (const deployment of previous) {
    if (deployment.payload?.run !== plan.run) continue;
    assert(typeof deployment.payload?.key === 'string', 'Malformed operation identity; resolve its evidence before continuing.');
    if (!deployment.payload.key.endsWith(`/${operation}`)) continue;
    const { attempt: previousAttempt = '1', ...identity } = deployment.payload;
    assert(hash(identity) === hash(payload), 'Operation identity differs from the release plan.');
    assert(Number(previousAttempt) < Number(attempt), `Operation ${payload.key} was already attempted in this workflow attempt.`);
    const statuses = await client.api('GET', `deployments/${deployment.id}/statuses?per_page=1`);
    assert(statuses[0]?.state !== 'success', 'Successful operation is missing its immutable evidence.');
  }
  const deployment = await client.api('POST', 'deployments', { ref: plan.build, task: 'expo-release-v3', auto_merge: false,
    required_contexts: [], environment: payload.key, production_environment: plan.config.profiles[plan.profile].environment === 'production', payload: { ...payload, attempt } });
  assert(Number.isSafeInteger(deployment.id), 'GitHub did not return a deployment ID.');
  return deployment.id;
}

/** Read a confirmed provider result, checking the complete plan and operation identity before reuse. */
export async function receipt(client, plan, operation) {
  const release = await client.api('GET', `releases/tags/${prefix}run/${plan.run}`);
  const saved = await client.readEvidence(release.id, `${operation.replaceAll('/', '-')}.json`);
  if (saved) {
    const { deploymentId, result, plan: digest, ...identity } = saved;
    assert(Number.isSafeInteger(deploymentId) && result && digest === hash(plan)
      && hash(identity) === hash(operationPayload(plan, operation)), 'Release receipt identity differs from the plan.');
  }
  return saved;
}

/** Skip confirmed work on retry, repairing an interrupted success record before returning its result. */
export async function perform(client, plan, operation, execute) {
  const saved = await receipt(client, plan, operation);
  const id = saved?.deploymentId ?? await begin(client, plan, operation);
  const result = saved?.result ?? await execute();
  await complete(client, plan, operation, id, result);
  return result;
}

/** Retain evidence before marking success; retries repair status without replacing the original receipt. */
export async function complete(client, plan, operation, deploymentId, result) {
  const release = await client.api('GET', `releases/tags/${prefix}run/${plan.run}`);
  const saved = await receipt(client, plan, operation);
  if (saved) {
    assert(result.id ? saved.result.id === result.id : hash(saved.result) === hash(result), 'Provider result conflicts with confirmed evidence.');
    deploymentId = saved.deploymentId;
  } else await client.evidence(release.id, `${operation.replaceAll('/', '-')}.json`, { ...operationPayload(plan, operation), plan: hash(plan), deploymentId, result });
  const statuses = await client.api('GET', `deployments/${deploymentId}/statuses?per_page=1`);
  if (statuses[0]?.state !== 'success') await client.api('POST', `deployments/${deploymentId}/statuses`, { state: 'success', auto_inactive: false,
    log_url: `https://github.com/${plan.repository}/actions/runs/${plan.run}`, description: 'Provider operation completed; immutable evidence retained.' });
}
