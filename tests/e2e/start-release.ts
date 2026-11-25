import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

export default async function startRelease(config: FullConfig) {
  const url = config.projects[0].use.baseURL!;
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd, stdio: 'inherit', timeout: 120_000 });
  const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  const output = createInterface({ input: server.stdout });
  const stop = async () => {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out starting ${url}`)), 10_000);
      output.on('line', line => { if (line.includes(url)) resolve(); });
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Local release server exited with code ${code}`)));
    });
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    output.close();
    server.stdout.resume();
  }
  return stop;
}
