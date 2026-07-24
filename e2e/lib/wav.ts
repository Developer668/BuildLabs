import { writeFileSync } from "node:fs";

/**
 * Chromium's `--use-file-for-fake-audio-capture` wants a small mono PCM WAV.
 * Generating it keeps the repository free of committed binaries and keeps the
 * capture byte-for-byte deterministic across machines.
 */
export function writeFakeMicrophoneWav(
  path: string,
  options: {
    seconds?: number;
    sampleRate?: number;
    toneHertz?: number;
    amplitude?: number;
  } = {},
): string {
  const seconds = options.seconds ?? 2;
  const sampleRate = options.sampleRate ?? 16_000;
  const toneHertz = options.toneHertz ?? 440;
  const amplitude = options.amplitude ?? 0.2;
  const sampleCount = Math.round(seconds * sampleRate);
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    // A short fade in/out keeps the capture from clicking, which some audio
    // pipelines treat as an error rather than as speech-like input.
    const envelope = Math.min(
      1,
      index / (sampleRate * 0.05),
      (sampleCount - index) / (sampleRate * 0.05),
    );
    const value =
      amplitude *
      envelope *
      Math.sin((2 * Math.PI * toneHertz * index) / sampleRate);
    buffer.writeInt16LE(
      Math.round(value * 32_767),
      44 + index * bytesPerSample,
    );
  }

  writeFileSync(path, buffer);
  return path;
}
