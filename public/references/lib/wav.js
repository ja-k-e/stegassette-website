'use strict';
const fs = require('fs');

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAVE file');

  let offset = 12;
  let sampleRate, channels, bitsPerSample;
  let dataStart, dataLength;

  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);

    if (id === 'fmt ') {
      // audioFormat = buf.readUInt16LE(offset + 8);  // 1 = PCM
      channels      = buf.readUInt16LE(offset + 10);
      sampleRate    = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataStart  = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (!sampleRate || dataStart === undefined) throw new Error('Malformed WAV');
  return { sampleRate, channels, bitsPerSample, data: buf.slice(dataStart, dataStart + dataLength) };
}

function writeWav(pcm, sampleRate, channels, bitsPerSample) {
  const dataSize   = pcm.length;
  const blockAlign = channels * (bitsPerSample >> 3);
  const buf        = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);                              // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);        // byteRate
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm).copy(buf, 44);

  return buf;
}

module.exports = { readWav, writeWav };
