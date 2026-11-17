/** Хранилища раундов: в памяти (testkit) и на диске (`data/rounds.json`, ядро). */
import fs from 'node:fs';
import { writeFileDurable } from '../shared/fs.ts';
import type { RoundRecord, RoundStore } from './engine.ts';

/** Раунды в памяти. Записи хранятся как JSON, поэтому чтение всегда даёт независимую копию. */
export class MemoryRoundStore implements RoundStore {
  /** Раунды по `roundId` в виде JSON-строк. */
  protected readonly rounds = new Map<string, string>();
  readonly #openByGame = new Map<string, string>();

  /** Раунд по идентификатору. */
  get(roundId: string): RoundRecord | undefined {
    const s = this.rounds.get(roundId);
    return s === undefined ? undefined : (JSON.parse(s) as RoundRecord);
  }

  /** Открытый раунд игры, если есть. */
  findOpen(gameId: string): RoundRecord | undefined {
    const id = this.#openByGame.get(gameId);
    return id === undefined ? undefined : this.get(id);
  }

  /** Сохраняет раунд целиком. */
  save(round: RoundRecord): void {
    this.rounds.set(round.roundId, JSON.stringify(round));
    if (round.status === 'open') this.#openByGame.set(round.gameId, round.roundId);
    else if (this.#openByGame.get(round.gameId) === round.roundId) this.#openByGame.delete(round.gameId);
  }

  /** Удаляет раунд (ставку которого кошелёк точно не списал). */
  delete(roundId: string): void {
    const round = this.get(roundId);
    if (!round) return;
    this.rounds.delete(roundId);
    if (this.#openByGame.get(round.gameId) === roundId) this.#openByGame.delete(round.gameId);
  }
}

/** Раунды на диске: файл перечитывается при создании и перезаписывается после каждого изменения. */
export class FileRoundStore extends MemoryRoundStore {
  readonly #file: string;

  /** @param file путь к `rounds.json`; каталог создаётся при необходимости */
  constructor(file: string) {
    super();
    this.#file = file;
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { rounds?: Record<string, RoundRecord> };
      for (const r of Object.values(data.rounds ?? {})) super.save(r);
    }
  }

  /** Сохраняет раунд и записывает файл (временный файл, fsync, rename, fsync каталога). */
  override save(round: RoundRecord): void {
    super.save(round);
    this.#write();
  }

  /** Удаляет раунд и записывает файл. */
  override delete(roundId: string): void {
    super.delete(roundId);
    this.#write();
  }

  #write(): void {
    const body = [...this.rounds].map(([id, json]) => `${JSON.stringify(id)}:${json}`).join(',\n');
    writeFileDurable(this.#file, `{"rounds":{\n${body}\n}}\n`);
  }
}
