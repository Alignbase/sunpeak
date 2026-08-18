#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const CONFORMANCE_VERSION = '0.2.0-alpha.10';
const SPEC_VERSION = '2026-07-28';
const clientCommand = 'node scripts/oauth-conformance-client.mjs';
const latestScenarios = [
  'auth/resource-mismatch',
  'auth/offline-access-scope',
  'auth/offline-access-not-supported',
  'auth/authorization-server-migration',
  'auth/iss-supported',
  'auth/iss-not-advertised',
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  'auth/metadata-issuer-mismatch',
];

function run(args) {
  const result = spawnSync(
    'npx',
    [
      '-y',
      `@modelcontextprotocol/conformance@${CONFORMANCE_VERSION}`,
      'client',
      '--command',
      clientCommand,
      '--spec-version',
      SPEC_VERSION,
      '--timeout',
      '30000',
      ...args,
    ],
    { stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['--suite', 'auth']);
for (const scenario of latestScenarios) run(['--scenario', scenario]);
