import { spawn } from 'node:child_process';

const FFPROBE_TIMEOUT_MS = 5 * 60 * 1000;

export interface VideoMetadata {
  duration: number;
  size: number;
  width: number;
  height: number;
}

interface FfprobeOutput {
  format: { duration: string; size: string };
  streams: Array<{ codec_type: string; width?: number; height?: number }>;
}

export async function probeVideo(inputPath: string): Promise<VideoMetadata> {
  const stdout = await runFfprobe(inputPath);
  return parseFfprobeOutput(stdout);
}

export function parseFfprobeOutput(rawOutput: string): VideoMetadata {
  const parsed = JSON.parse(rawOutput) as FfprobeOutput;
  const videoStream = parsed.streams.find(
    (stream) => stream.codec_type === 'video',
  );
  if (!videoStream || videoStream.width == null || videoStream.height == null) {
    throw new Error('ffprobe output has no video stream with width/height');
  }

  return {
    duration: Math.round(Number(parsed.format.duration)),
    size: Number(parsed.format.size),
    width: videoStream.width,
    height: videoStream.height,
  };
}

function runFfprobe(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(
      'ffprobe',
      ['-print_format', 'json', '-show_format', '-show_streams', inputPath],
      { timeout: FFPROBE_TIMEOUT_MS },
    );

    let stdout = '';
    let stderr = '';
    ffprobe.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    ffprobe.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    ffprobe.on('error', reject);
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}
