import { zstdDecompressSync } from 'node:zlib';

// Frame scanning is adapted from DeepSeek Harness's scanZstdFrames at commit
// ddefc45fbc7f8e46dd73185e68295696d1297887, packages/session/session-persistence-jsonl/src/zstd.ts.
// Copyright (c) 2026 DeepSeek, MIT. See THIRD_PARTY_NOTICES.md.
// Node's public decoder only consumes one frame and can accept truncated input;
// establish complete frame boundaries before decoding each append batch.
export function decodeZstdLog(bytes, maxOutputLength) {
  const chunks = [];
  let offset = 0;
  let total = 0;
  const requireBytes = count => { if (offset + count > bytes.length) throw new Error('incomplete frame'); };
  while (offset < bytes.length) {
    const start = offset;
    requireBytes(5);
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('invalid frame magic');
    const descriptor = bytes[offset + 4];
    offset += 5;
    if (descriptor & 0x18) throw new Error('reserved frame bits');
    const singleSegment = Boolean(descriptor & 0x20);
    const checksum = Boolean(descriptor & 4);
    const dictionaryFlag = descriptor & 3;
    const contentSizeFlag = descriptor >>> 6;
    const headerSize = (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag);
    requireBytes(headerSize);
    offset += headerSize;
    for (;;) {
      requireBytes(3);
      const block = bytes.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('reserved block type');
      const size = type === 1 ? 1 : block >>> 3;
      requireBytes(size);
      offset += size;
      if (block & 1) break;
    }
    if (checksum) { requireBytes(4); offset += 4; }
    if (total >= maxOutputLength) throw new Error('decoded size limit');
    const chunk = zstdDecompressSync(bytes.subarray(start, offset), { maxOutputLength: maxOutputLength - total });
    total += chunk.length;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
