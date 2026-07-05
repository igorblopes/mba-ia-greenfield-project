import { extname } from 'node:path';

export function buildOriginalKey(
  videoId: string,
  originalFilename: string,
): string {
  const ext = extname(originalFilename).slice(1) || 'bin';
  return `videos/${videoId}/original.${ext}`;
}

export function buildThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
