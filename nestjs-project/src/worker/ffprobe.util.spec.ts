import { parseFfprobeOutput } from './ffprobe.util';

const SAMPLE_FFPROBE_OUTPUT = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      codec_type: 'video',
      width: 1920,
      height: 1080,
    },
    {
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
    },
  ],
  format: {
    filename: 'input.mp4',
    nb_streams: 2,
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.345000',
    size: '1048576',
    bit_rate: '679921',
  },
};

describe('parseFfprobeOutput', () => {
  it('extracts duration, size, width and height from a sample ffprobe JSON output', () => {
    const metadata = parseFfprobeOutput(JSON.stringify(SAMPLE_FFPROBE_OUTPUT));

    expect(metadata).toEqual({
      duration: 12,
      size: 1048576,
      width: 1920,
      height: 1080,
    });
  });

  it('throws when the output has no video stream', () => {
    const audioOnlyOutput = {
      streams: [{ index: 0, codec_name: 'aac', codec_type: 'audio' }],
      format: { duration: '5.000000', size: '2048' },
    };

    expect(() => parseFfprobeOutput(JSON.stringify(audioOnlyOutput))).toThrow(
      'ffprobe output has no video stream with width/height',
    );
  });
});
