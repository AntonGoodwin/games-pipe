/**
 * Запуск приложения: `pnpm start` поднимает кошелёк (4001) отдельным процессом и ядро (4000).
 * Данные — в `data/`, игры — в `games/` (относительно корня репозитория).
 *
 * Кошелёк работает в дочернем процессе: код игр загружается в процесс ядра, и баланс с журналом
 * не должны лежать в его памяти.
 */
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from './core/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'data');
const gamesDir = path.join(root, 'games');

// Общий секрет запуска: кошелёк принимает запросы только от этого ядра.
const walletToken = crypto.randomUUID();
const walletProc = fork(path.join(here, 'wallet', 'main.ts'), [], { stdio: 'inherit' });
const walletUrl = await new Promise<string>((resolve, reject) => {
  walletProc.once('message', (msg: { url?: string; error?: string }) => {
    if (typeof msg.url === 'string') resolve(msg.url);
    else reject(new Error(`Кошелёк не запустился: ${msg.error ?? 'неизвестная ошибка'}`));
  });
  walletProc.once('exit', (code) => reject(new Error(`Процесс кошелька завершился с кодом ${String(code)}`)));
  walletProc.send({ port: 4001, dataDir, token: walletToken });
});

const core = await startCore({ port: 4000, dataDir, gamesDir, walletUrl, walletToken });

console.log(`Кошелёк: ${walletUrl}`);
console.log(`Приложение: http://localhost:4000 (${core.url})`);

walletProc.once('exit', (code) => {
  console.error(`Процесс кошелька завершился (код ${String(code)}), ядро останавливается`);
  void core.close().then(() => process.exit(1));
});

const stop = async (): Promise<void> => {
  await core.close();
  walletProc.removeAllListeners('exit');
  if (walletProc.exitCode === null && walletProc.signalCode === null) {
    await new Promise<void>((resolve) => {
      walletProc.once('exit', () => resolve());
      walletProc.kill('SIGTERM');
    });
  }
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
