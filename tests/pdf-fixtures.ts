import { Readable } from 'node:stream';
import { createDeflate } from 'node:zlib';

export async function compressedImagePdf(mixed = false, textPageSize: [number, number] = [200, 100]) {
  // Reuse one small chunk: the fixture builder never allocates the 108 MB decoded image.
  const chunk = Buffer.alloc(64 * 1024, 255);
  const deflate = Readable.from((function* () {
    for (let remaining = 6000 * 6000 * 3; remaining > 0; remaining -= chunk.length) yield chunk.subarray(0, Math.min(remaining, chunk.length));
  })()).pipe(createDeflate());
  const compressed: Buffer[] = [];
  for await (const part of deflate) compressed.push(part as Buffer);
  const image = Buffer.concat(compressed);
  const stream = 'q 10 0 0 10 0 0 cm /Im Do Q';
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${mixed ? ' 7 0 R' : ''}] /Count ${mixed ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 6000 /Height 6000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  if (mixed) {
    const text = 'BT /F1 12 Tf 10 40 Td (safe embedded marker) Tj ET';
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${textPageSize.join(' ')}] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  const chunks = [Buffer.from('%PDF-1.4\n')]; const offsets = [0]; let length = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(object); length += object.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
