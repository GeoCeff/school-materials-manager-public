import { parentPort, workerData } from 'node:worker_threads';
import { runSmoke } from '../smoke.js';

try {
  const report = await runSmoke(workerData as string);
  parentPort!.postMessage(report);
} catch (error) {
  parentPort!.postMessage({ passed: false, error: error instanceof Error ? error.message : 'Compatibility check failed.' });
}
