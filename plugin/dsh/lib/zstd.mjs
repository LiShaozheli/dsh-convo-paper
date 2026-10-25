// Vendored copy of lib/zstd.mjs — edit lib/ and run `node scripts/sync-core.mjs`.
/**
 * Decoder for DSH session logs.
 *
 * A DSH session log (`session.vN.jsonl.zstd`) is a plain concatenation of
 * independent Zstandard frames: one frame for the header line, then one frame
 * per durable append batch. Node's sync API stops after the first frame, and
 * the stream API rejects the tail of a file that is still being appended, so
 * we scan for frame magic and decode frame by frame.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeSessionBytes(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  if (starts.length === 0) return buf.toString('utf8');
  starts.push(buf.length);

  const parts = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const text = decodeFrameAt(buf, starts, k);
    if (text !== null) parts.push(text);
  }
  return parts.join('');
}

function decodeFrameAt(buf, starts, k) {
  // The nearest boundary is the normal case; extend a little when a frame was
  // split or when the tail of a live file is incomplete.
  const maxSpan = Math.min(k + 6, starts.length - 1);
  for (let m = k + 1; m <= maxSpan; m++) {
    const end = starts[m];
    if (end - starts[k] < 4) continue;
    try {
      return zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
    } catch {
      /* try a longer slice */
    }
  }
  return null;
}

export function readSessionFile(file) {
  return decodeSessionBytes(fs.readFileSync(file));
}
