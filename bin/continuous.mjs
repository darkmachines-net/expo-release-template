#!/usr/bin/env node
/** @file Resolve development-first delivery settings and verify its manual beta approval boundary. */
import path from 'node:path';
import { continuousContext } from '../src/continuous.mjs';
try { await continuousContext(path.resolve('app')); }
catch (error) { console.error(error.message); process.exitCode = 1; }
