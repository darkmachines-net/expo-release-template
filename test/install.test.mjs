/** @file Exercise full-SHA Git installation under the organization scope and verify public CLI, Expo and guard exports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, readJson, writeJson } from '../src/io.mjs';
import { repository, temporary } from './helpers.mjs';

test('package installs directly from a full Git SHA with executable CLI and Expo helper', {timeout:120000}, t => {
  const source=repository(t), consumer=temporary(t), root=fileURLToPath(new URL('../',import.meta.url));
  for(const file of ['src','bin','schemas','package.json','package-lock.json'])fs.cpSync(path.join(root,file),path.join(source.root,file),{recursive:true});
  const sha=source.commit();
  writeJson(path.join(consumer,'package.json'),{name:'clean-install',private:true,devDependencies:{'@darkmachines-net/expo-release':`git+${pathToFileURL(source.root).href}#${sha}`}});
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:consumer});
  const installed=readJson(path.join(consumer,'node_modules/@darkmachines-net/expo-release/package.json'));
  assert.equal(installed.name, '@darkmachines-net/expo-release');
  assert.equal(installed.version,'3.0.0');assert.deepEqual(Object.keys(installed.dependencies),['ajv']);assert.equal(installed.scripts.prepare,undefined);
  assert.match(run(process.execPath,['node_modules/@darkmachines-net/expo-release/bin/expo-release.mjs','--help'],{cwd:consumer}),/plan --profile/);
  assert.equal(run(process.execPath,['-e',"console.log(require('@darkmachines-net/expo-release/expo').runtimeVersion('3.2.1'))"],{cwd:consumer}).trim(),'3');
  assert.equal(run(process.execPath,['-e',"console.log(typeof require('@darkmachines-net/expo-release/register').registerRootComponent)"],{cwd:consumer}).trim(),'function');
  assert.ok(readJson(path.join(consumer,'package-lock.json')).packages['node_modules/@darkmachines-net/expo-release'].resolved.endsWith(`#${sha}`));
  run('npm',['ci','--ignore-scripts','--offline','--no-audit','--no-fund'],{cwd:consumer});
  assert.ok(fs.existsSync(path.join(consumer,'node_modules/@darkmachines-net/expo-release/src/engine.mjs')));
});
