import { spawn } from 'node:child_process';

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

const MIN_OFFSET_SECONDS = 1;
const OFFSET_RATIO = 0.1;
const CLAMP_MARGIN_SECONDS = 0.1;

export function calculateThumbnailOffset(durationSeconds: number): number {
  const offset = Math.max(MIN_OFFSET_SECONDS, durationSeconds * OFFSET_RATIO);
  return Math.min(offset, durationSeconds - CLAMP_MARGIN_SECONDS);
}

export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  durationSeconds: number,
): Promise<void> {
  const offset = calculateThumbnailOffset(durationSeconds);
  await runFfmpeg(inputPath, outputPath, offset);
}

function runFfmpeg(
  inputPath: string,
  outputPath: string,
  offset: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(offset),
        '-i',
        inputPath,
        '-vframes',
        '1',
        outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code, signal) => {
      if (code !== 0) {
        const reason = signal
          ? `killed by signal ${signal} (timeout after ${FFMPEG_TIMEOUT_MS}ms)`
          : `exited with code ${code}`;
        reject(new Error(`ffmpeg ${reason}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}
