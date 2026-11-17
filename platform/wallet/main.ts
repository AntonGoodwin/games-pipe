/**
 * Точка входа кошелька как отдельного процесса (запускается из `platform/start.ts` через `child_process.fork`).
 * Баланс и журнал живут только в памяти этого процесса, отдельно от ядра, куда загружается код игр.
 *
 * Протокол IPC: родитель шлёт `{ port, dataDir, token }`, процесс отвечает `{ url }` или `{ error }`.
 * Токен передаётся по IPC, а не через argv или окружение, чтобы его не было видно в списке процессов.
 */
import { startWallet } from './index.ts';

/** Сообщение запуска от родительского процесса. */
export interface WalletStartMessage {
  port: number;
  dataDir: string;
  token: string;
}

if (typeof process.send !== 'function') {
  console.error('platform/wallet/main.ts запускается только через child_process.fork');
  process.exit(1);
}

process.once('message', (msg: WalletStartMessage) => {
  startWallet({ port: msg.port, dataDir: msg.dataDir, token: msg.token }).then(
    (wallet) => {
      process.send?.({ url: wallet.url });
      const stop = (): void => {
        void wallet.close().then(() => process.exit(0));
      };
      // Ctrl+C приходит всей группе процессов: кошелёк ждёт SIGTERM от родителя, который сначала остановит ядро.
      process.on('SIGINT', () => undefined);
      process.once('SIGTERM', stop);
      // Родитель завершился — кошелёк без ядра не нужен.
      process.once('disconnect', stop);
    },
    (e: unknown) => {
      process.send?.({ error: e instanceof Error ? e.message : String(e) }, () => process.exit(1));
    },
  );
});
