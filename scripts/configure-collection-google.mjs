import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { googleClient } from '../dist/src/desktop/collection-providers.js';

const input=process.argv[2];const target=resolve('dist/assets/desktop-oauth.json');
if(!input)throw new Error('Build first, then pass your publisher Desktop OAuth client JSON path, or --clear.');
if(input==='--clear'){await rm(target,{force:true});console.log('Bundled Google client removed.');}
else{
  const file=await open(input,'r');let bytes;
  try{
    const info=await file.stat();if(!info.isFile()||info.size>64_000)throw new Error('Client configuration exceeds 64 KB or is not a regular file.');
    const buffer=Buffer.alloc(64_001);let offset=0;
    while(offset<buffer.length){const read=await file.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
    if(offset>64_000)throw new Error('Client configuration exceeds 64 KB.');bytes=buffer.subarray(0,offset);
  }finally{await file.close();}
  const client=googleClient(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  await mkdir(resolve('dist/assets'),{recursive:true});await writeFile(target,JSON.stringify({installed:client},null,2));
  console.log('Publisher Desktop client configured locally. This does not establish Google verification or school approval.');
}
