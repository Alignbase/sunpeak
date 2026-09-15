import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') continue;

  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'silent-legacy', version: '1.0.0' },
      },
    })}\n`
  );
}
