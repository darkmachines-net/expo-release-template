#!/usr/bin/env node
/** @file Invoke one fixed development phase from the shared workflow without consumer lifecycle scripts. */
import path from 'node:path';
import { developmentWorker } from '../src/development.mjs';
try { await developmentWorker(process.argv[2], path.resolve('app'), path.resolve('state')); }
catch (error) { console.error(error.message); process.exitCode = 1; }
