#!/usr/bin/env tsx
import { run } from './cli';
import { nodeEnv } from './env';

process.exitCode = await run(process.argv.slice(2), nodeEnv());
