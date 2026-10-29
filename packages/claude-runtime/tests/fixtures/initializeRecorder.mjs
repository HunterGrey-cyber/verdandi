#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

const capturePath = process.env.VERDANDI_TEST_INITIALIZE_CAPTURE;
if (!capturePath || !isAbsolute(capturePath)) {
  throw new Error('VERDANDI_TEST_INITIALIZE_CAPTURE must be an absolute scratch path');
}

// This executable only speaks the startup control protocol; it has no model client.
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    const frame = JSON.parse(line);
    if (frame.type !== 'control_request' || frame.request?.subtype !== 'initialize') {
      throw new Error('initialize recorder accepts no user/model requests');
    }
    const temporaryPath = `${capturePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(frame.request), { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, capturePath);
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: frame.request_id, response: {} },
      })}\n`, (error) => error ? reject(error) : resolve());
    });
    break;
  }
} finally {
  lines.close();
  process.stdin.destroy();
}
