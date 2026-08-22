#!/usr/bin/env node
import { main } from './server.js';
import { shutdown } from './bridge.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

const dataDirs = ['cookies', 'bookmarks', 'history', 'screenshots'];
const base = join(process.cwd(), 'data');
for (const d of dataDirs) mkdirSync(join(base, d), { recursive: true });

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

main().catch(err => { console.error(err); process.exit(1); });
