import { calculateThumbnailOffset } from './ffmpeg-thumbnail.util';

describe('calculateThumbnailOffset', () => {
  it('uses 10% of the duration when the video is long enough', () => {
    expect(calculateThumbnailOffset(20)).toBe(2);
  });

  it('floors the offset at 1 second for durations where 10% is below 1', () => {
    expect(calculateThumbnailOffset(5)).toBe(1);
  });

  it('clamps the offset for short videos so it never reaches the end', () => {
    expect(calculateThumbnailOffset(1)).toBeCloseTo(0.9);
  });

  it('clamps very short videos to duration minus the safety margin', () => {
    expect(calculateThumbnailOffset(0.5)).toBeCloseTo(0.4);
  });
});
