import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { syntheticPdf, syntheticScan } from './smoke.js';
import { syntheticDocx, syntheticPptx } from './office-fixtures.js';

export async function createDemo(root: string): Promise<void> {
  const files = new Map<string, string | Buffer>([
    ['First Year 2025-2026/First Semester/SCI 101/observatory-scan.pdf', syntheticScan()],
    ['First Year 2025-2026/First Semester/SCI 101/observatory-notes.docx', syntheticDocx(['Observatory field notes', 'Lunar telescope calibration uses a distant reference star.'])],
    ['First Year 2025-2026/First Semester/SCI 101/observatory-slides.pptx', syntheticPptx(['Observatory introduction', 'Lunar telescope calibration: check the mount before observing.'])],
    ['First Year 2025-2026/First Semester/SCI 101/01 — Energy lecture.pdf', syntheticPdf(['An introduction to motion and physical quantities.', 'Conservation of energy connects kinetic and potential energy. Energy transfers between systems, while the total remains constant.'])],
    ['First Year 2025-2026/First Semester/SCI 101/notes.md', '# Energy and motion\n\nEnergy is the capacity to do work.\nConservation of energy helps us understand how a moving object slows down.\n\nQuestions to revisit\n- Where does the energy go when friction acts?'],
    ['First Year 2025-2026/Second Semester/SCI 102/notes.md', '# Heat and systems\nThermal energy moves from a warmer object to a cooler one.\nA system boundary helps account for energy transfers.'],
    ['Second Year 2026-2027/First Semester/CS 201/search.cpp', '// Binary search on a sorted study index\nint findStudyPage(int target) {\n  int low = 0;\n  int high = 8;\n  return target + low + high;\n}'],
    ['Second Year 2026-2027/First Semester/CS 201/algorithm-notes.txt', 'A binary search tree organizes searchable keys.\nA priority queue stores pending tasks.\n\nEnergy readings can be stored as sorted records.'],
    ['Second Year 2026-2027/First Semester/MATH 202/energy-exercises.md', '# Energy exercises\nUse the sum of kinetic and potential energy to compare two states.\nCheck units before substituting values.'],
    ['First Year 2025-2026/First Semester/SCI 101/scanned-handout.pdf', syntheticPdf([null])],
    ['First Year 2025-2026/First Semester/SCI 101/damaged-example.pdf', 'Synthetic malformed PDF for demonstrating an explicit extraction failure.'],
    ['Second Year 2026-2027/First Semester/CS 201/unsafe-example.py', '# This file must be revealed, never executed by Archive Search.\nprint("inert preview")\n# <script>window.fixtureExecuted = true</script>'],
    ['reference-bundle.zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex')],
  ]);
  await mkdir(join(root, 'Empty sample folder'), { recursive: true });
  for (const [path, text] of files) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    try { await writeFile(target, text, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
