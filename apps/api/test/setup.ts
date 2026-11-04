import 'reflect-metadata';
import { existsSync } from 'node:fs';

const env = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(env)) process.loadEnvFile(env);
