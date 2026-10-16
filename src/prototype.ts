import { homedir } from 'node:os';
import { join } from 'node:path';
import { Library } from './core/library.js';

const [command, root, ...inputs] = process.argv.slice(2);
if (!root || !inputs.length || !['index', 'search'].includes(command ?? '')) {
  console.log('Run npm run build first. Prototype commands:\n  node dist/src/prototype.js index <root-folder> <relative-file> [more-files...]\n  node dist/src/prototype.js search <root-folder> <query>\nUse SCHOOL_MATERIALS_INDEX to choose a separate index outside the archive.');
  process.exitCode = command ? 1 : 0;
} else {
  const databasePath = process.env.SCHOOL_MATERIALS_INDEX ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'school-materials-manager-prototype', 'library.sqlite');
  let library: Library | undefined;
  try {
    library = await Library.open(root, databasePath);
    if (command === 'index') {
      for (const path of inputs) {
        const outcome = await library.indexFile(path);
        console.log(JSON.stringify({ relativePath: path, ...outcome }));
        if (['failed', 'stale'].includes(outcome.status)) process.exitCode = 1;
      }
    } else console.log(JSON.stringify(library.search(inputs.join(' ')), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The prototype could not complete the request.');
    process.exitCode = 1;
  } finally { library?.close(); }
}
