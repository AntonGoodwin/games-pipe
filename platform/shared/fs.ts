/** Надёжная запись файлов данных (`wallet.json`, `rounds.json`). */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Атомарно и надёжно заменяет файл: пишет во временный файл, сбрасывает его на диск (`fsync`),
 * переименовывает поверх старого и сбрасывает каталог. После сбоя питания в файле остаётся
 * либо старое, либо новое содержимое целиком, а rename не опережает данные.
 */
export function writeFileDurable(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDir(dir);
}

/** fsync каталога, чтобы сохранилась сама запись о rename. Где ОС этого не умеет (Windows), шаг пропускается. */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // EISDIR/EPERM/EINVAL на платформах без fsync каталогов — данные файла уже на диске.
  } finally {
    fs.closeSync(fd);
  }
}
