/** The closing half of the memory witness. See `memory-witness.ts`. */
import { memorySnapshot } from './memory-witness.ts';

export default async function globalTeardown(): Promise<void> {
  process.stdout.write(`[mem] suite end    ${memorySnapshot()}\n`);
}
