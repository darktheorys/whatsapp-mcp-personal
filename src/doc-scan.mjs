// Text extraction for the outbound secret scan on documents. Dependency-free on purpose: a secret in
// a pdf or an office file is exactly as sendable as one in a message, but the formats compress their
// text, so scanning the raw bytes sees nothing. This pulls the compressed text back out so the same
// scanOutbound patterns can run on it.
//
// Not a parser and not meant to be: it errs towards scanning more (every inflatable stream, every zip
// entry, plus the raw bytes decoded as latin1) rather than reproducing what a viewer would show.
// It also fails CLOSED: anything it cannot read (a stream that will not inflate, an unsupported zip
// method, a size past the bomb guard) throws DocumentScanError, and the caller refuses the send. A
// scanner that skipped what it could not read would be walked around by a deliberately broken file.
// Writes nothing to stdout (stdout is the MCP channel).
import { inflateRawSync, inflateSync } from "node:zlib";

const MAX_INFLATED = 20 * 1024 * 1024; // per stream or entry, a bomb guard
const MAX_TOTAL = 60 * 1024 * 1024; // across the whole document

export class DocumentScanError extends Error {}

function inflateOrThrow(fn, data, what) {
  try {
    return fn(data, { maxOutputLength: MAX_INFLATED });
  } catch {
    throw new DocumentScanError(`${what} could not be decompressed for scanning`);
  }
}

function spend(budget, n) {
  budget.left -= n;
  if (budget.left < 0) throw new DocumentScanError("the document is too large to scan once decompressed");
}

// Entries of a zip, read from the central directory (the local headers can carry zero sizes when
// the writer used a data descriptor, which Office files do).
function zipTexts(buf, budget) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new DocumentScanError("the zip container has no readable directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new DocumentScanError("the zip directory is damaged");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || localOff === 0xffffffff)
      throw new DocumentScanError("zip64 archives are not scanned");
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new DocumentScanError("a zip entry points outside the file");
    }
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateOrThrow(inflateRawSync, raw, "a zip entry");
    else throw new DocumentScanError(`a zip entry uses an unsupported compression method (${method})`);
    spend(budget, data.length);
    out.push(data.toString("utf8"));
  }
  return out;
}

// Every `stream ... endstream` body in a pdf. Page text lives in Flate streams, which start with a zlib
// header byte (0x78), so those are inflated and must succeed. Streams with another filter (images and
// the like) are covered by the raw scan the caller already does.
function pdfStreamTexts(buf, budget) {
  const out = [];
  const text = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end === -1) break;
    const body = buf.subarray(start, end);
    if (body.length > 1 && body[0] === 0x78) {
      const data = inflateOrThrow(inflateSync, body, "a pdf stream");
      spend(budget, data.length);
      out.push(data.toString("latin1"));
    }
    // Past the whole word "endstream": stopping at its start lets the pattern match the "stream" inside
    // it and swallow the next real stream.
    re.lastIndex = end + "endstream".length;
  }
  return out;
}

const isPdf = (buf) => buf.length >= 4 && buf.toString("latin1", 0, 4) === "%PDF";
const isZip = (buf) => buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;

// Returns the strings to run through the secret scan for a document. The container is recognised by its
// magic bytes first and the extension second, so a pdf or zip renamed to .txt is still opened up.
// Always includes the raw bytes as latin1 and utf8. Throws DocumentScanError when it cannot read it all.
export function documentScanTexts(buf, ext) {
  const budget = { left: MAX_TOTAL };
  const texts = [buf.toString("latin1"), buf.toString("utf8")];
  if (isPdf(buf) || ext === ".pdf") texts.push(...pdfStreamTexts(buf, budget));
  else if (isZip(buf) || [".docx", ".xlsx", ".pptx"].includes(ext)) texts.push(...zipTexts(buf, budget));
  return texts;
}
