import { parentPort, workerData } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { within } from '../core/paths.js';
import { ArchiveService } from '../core/index.js';
import { CollectionError, CollectionService } from '../core/collection.js';
import { collectionAssistance } from '../core/collection-assistance.js';
import { LocalDataRemoval } from '../core/local-data.js';
import type { CollectionItem, CollectionOptions, CollectionPlan, CourseMapping } from '../core/collection-model.js';
import type { BrowseRequest, Filters, Job, Theme } from '../core/model.js';
const service = new ArchiveService(workerData as string, job => parentPort!.postMessage({ event: 'progress', job }));
let downloadId = 0;
const downloads = new Map<number, { resolve: (path: string) => void; reject: (error: Error) => void; cleanup: () => void }>();
const collection = new CollectionService(workerData as string, (item, signal) => new Promise((resolve, reject) => {
  const id = ++downloadId;
  const abort = () => { downloads.delete(id); parentPort!.postMessage({ event: 'collection-abort-download', id }); reject(new Error('Download cancelled.')); };
  if (signal.aborted) { reject(new Error('Download cancelled.')); return; }
  downloads.set(id, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) });
  signal.addEventListener('abort', abort, { once: true });
  parentPort!.postMessage({ event: 'collection-download', id, item });
}), () => parentPort!.postMessage({ event: 'collection-progress', collectionJob: collection.progress() }));
// Collection corruption must not prevent the independent offline library from opening.
let collectionError: unknown;
const collectionReady = collection.init().catch(error => { collectionError = error; });
const ready = service.init();
const removal = new LocalDataRemoval(workerData as string, service, collection);
let clearing = false;
let requests = 0;
let removalAuthorization: { id: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
parentPort!.on('message', async (request: { id: number; method: string; args: unknown[] }) => {
  const authorization = request as unknown as { clearAuthorized?: number; error?: string };
  if (authorization.clearAuthorized !== undefined) {
    const pending = removalAuthorization;
    if (!pending || pending.id !== authorization.clearAuthorized) return;
    removalAuthorization = undefined; clearTimeout(pending.timer);
    if (authorization.error) pending.reject(new Error(authorization.error)); else pending.resolve();
    return;
  }
  const receipt = request as unknown as { collectionDownload?: number; path?: string; error?: string; failure?: 'temporary'|'attention'|'changed'|'permanent' };
  if (receipt.collectionDownload !== undefined) {
    const pending = downloads.get(receipt.collectionDownload);
    if (!pending) { if (receipt.path && within(join(workerData as string, 'downloads'), receipt.path) && /^[a-f0-9-]{36}\.part$/.test(basename(receipt.path))) await rm(receipt.path, { force: true }).catch(() => {}); return; }
    downloads.delete(receipt.collectionDownload); pending.cleanup();
    if (receipt.error) pending.reject(new CollectionError(receipt.error,receipt.failure??'permanent')); else pending.resolve(receipt.path!);
    return;
  }
  requests++;
  try {
    if (clearing) throw new Error('Local data removal is in progress.');
    await ready;
    if (clearing) throw new Error('Local data removal is in progress.');
    const [first, second, third] = request.args;
    let result: unknown;
    switch (request.method) {
      case 'clear-review': await collectionReady; if (collectionError) throw new Error('Collection catalog cannot be read. Preserve it for recovery before clearing data.'); result = await removal.prepare(first); break;
      case 'clear-cancel': removal.cancel(); break;
      case 'clear-execute':
        if (requests > 1) throw new Error('Wait for the current archive operation to finish, then review removal again.');
        clearing = true;
        try {
          result = await removal.execute(first, second, () => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { removalAuthorization = undefined; reject(new Error('Schedule removal could not be authorized. No local data was removed.')); }, 30_000);
            removalAuthorization = { id: request.id, resolve, reject, timer };
            parentPort!.postMessage({ event: 'clear-authorized', id: request.id });
          }));
        } finally { clearing = false; }
        break;
      case 'status': result = await service.status(); break;
      case 'prepare': result = await service.prepareRoot(first as string); break;
      case 'start': result = await service.start(first as Job['kind']); break;
      case 'cancel': service.cancel(); break;
      case 'search': result = service.search(first as string, second as Filters, third as number); break;
      case 'browse': result = await service.browse(first as BrowseRequest); break;
      case 'options': result = service.options(first as Filters); break;
      case 'preview': result = await service.preview(first as string, second as number); break;
      case 'matches': result = service.matches(first as string, second as string); break;
      case 'resolve': result = await service.resolveFile(first as string); break;
      case 'resolve-entry': result = await service.resolveEntry(first as string, second as string); break;
      case 'theme': result = await service.setTheme(first as Theme); break;
      case 'ocr': result = await service.setOcr(first as boolean); break;
      case 'document': result = await service.document(first as string, second as number); break;
      case 'cancel-document': service.cancelDocument(); break;
      case 'saved': result = await service.saved(); break;
      case 'save-search': result = await service.saveSearch(first as string, second as Filters); break;
      case 'save-bookmark': result = await service.saveBookmark(first as string, second as number); break;
      case 'remove-saved': result = await service.removeSaved(first as string); break;
      case 'open-bookmark': result = await service.openBookmark(first as string); break;
      case 'collection-status': await collectionReady; if (collectionError) throw new Error('Collection data could not be opened. Existing files and the offline index were retained.'); result = collection.snapshot(); break;
      case 'collection-details': await collectionReady; if (collectionError) throw collectionError; result = collection.details(); break;
      case 'collection-local': await collectionReady; if (collectionError) throw collectionError; await collection.prepareLocal(first as string, second as string[], third as CollectionOptions & { school: 'manual' | 'uvec'; course: string }); break;
      case 'collection-prepare': {
        await collectionReady; if (collectionError) throw collectionError; const plan = first as CollectionPlan;
        await collection.prepare(plan.root, plan.source, plan.account, plan.label, plan.items as CollectionItem[], plan, plan.gaps); break;
      }
      case 'collection-start': await collectionReady; if (collectionError) throw collectionError; await collection.start(first as string[]); break;
      case 'collection-stop': collection.stop(first as 'pause' | 'cancel'); break;
      case 'collection-wait': await collection.whenIdle(); break;
      case 'collection-resume': await collectionReady; if (collectionError) throw collectionError; await collection.resume(); break;
      case 'collection-retry': await collectionReady; if(collectionError)throw collectionError; await collection.resume(true,first===true); break;
      case 'collection-organize': await collectionReady; if(collectionError)throw collectionError; await collection.organize(first as CourseMapping[]); break;
      case 'collection-preflight': await collectionReady; if(collectionError)throw collectionError; result=await collection.preflight(first as string[]); break;
      case 'collection-assistance': { await collectionReady; if(collectionError)throw collectionError; const plan=collection.details(); if(!plan)throw new Error('Scan or select materials first.'); result=collectionAssistance(plan); break; }
      case 'collection-coverage': { await collectionReady; if(collectionError)throw collectionError; const plan=collection.details(); result=plan?service.collectionCoverage(plan.root,plan.items.flatMap(item=>item.path?[item.path]:[])):null; break; }
      case 'close': await collectionReady; if (!collectionError) await collection.close(); result = await service.close(); break;
      default: throw new Error('Unknown archive operation.');
    }
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) { parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'The archive operation failed.' }); }
  finally { requests--; }
});
