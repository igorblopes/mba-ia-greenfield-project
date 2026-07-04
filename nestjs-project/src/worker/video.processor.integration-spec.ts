import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { buildOriginalKey } from '../videos/video-storage-key.util';
import {
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from '../videos/videos.constants';
import type { ProcessVideoJobPayload } from '../videos/videos.service';
import type { VideoMetadata } from './ffprobe.util';
import { VideoProcessor } from './video.processor';

// Fixture generation via real ffmpeg + a full Redis/MinIO/ffprobe round-trip
// regularly exceeds Jest's 5s default hook timeout.
jest.setTimeout(30000);

const ALL_ENTITIES = [User, Channel, Video];

function buildStorageTestConfig(): ConfigType<typeof storageConfig> {
  return {
    endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
    region: process.env.STORAGE_REGION || 'us-east-1',
    bucket: process.env.STORAGE_BUCKET ?? 'streamtube',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    forcePathStyle: true,
  };
}

async function uploadFixture(
  storageService: StorageService,
  key: string,
  filePath: string,
): Promise<void> {
  const body = await readFile(filePath);
  const uploadId = await storageService.createMultipartUpload(key, 'video/mp4');
  const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
  const response = await fetch(partUrl, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  const etag = response.headers.get('etag');
  if (!etag) {
    throw new Error('MinIO did not return an ETag for the uploaded fixture');
  }
  await storageService.completeMultipartUpload(key, uploadId, [
    { ETag: etag, PartNumber: 1 },
  ]);
}

describe('VideoProcessor (integration vs Redis + ffprobe real)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storageService: StorageService;
  let processor: VideoProcessor;
  let queue: Queue<ProcessVideoJobPayload>;
  let worker: Worker<ProcessVideoJobPayload, VideoMetadata>;
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    storageService = new StorageService(buildStorageTestConfig());
    await storageService.onModuleInit();

    processor = new VideoProcessor(videoRepository, storageService);

    const connection = {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    };
    queue = new Queue<ProcessVideoJobPayload>(VIDEO_PROCESSING_QUEUE_NAME, {
      connection,
    });
    worker = new Worker<ProcessVideoJobPayload, VideoMetadata>(
      VIDEO_PROCESSING_QUEUE_NAME,
      (job) => processor.process(job),
      { connection },
    );

    fixtureDir = await mkdtemp(join(tmpdir(), 'video-processor-fixture-'));
    fixturePath = join(fixtureDir, 'sample.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=2',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    await dataSource.destroy();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let userCounter = 0;
  async function createDraftVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_processor_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `vpchan${userCounter}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'sample.mp4',
        content_type: 'video/mp4',
        size: String(statSync(fixturePath).size),
      }),
    );

    const key = buildOriginalKey(video.id, video.original_filename);
    await uploadFixture(storageService, key, fixturePath);

    return video;
  }

  function waitForJobOutcome(): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      worker.once('completed', (_job, returnvalue) => resolve(returnvalue));
      worker.once('failed', (_job, err) => reject(err));
    });
  }

  it('extracts duration/size/width/height and transitions status to processing', async () => {
    const video = await createDraftVideo();

    const outcome = waitForJobOutcome();
    await queue.add(PROCESS_VIDEO_JOB_NAME, { videoId: video.id });
    const metadata = await outcome;

    expect(metadata.duration).toBe(2);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.size).toBe(statSync(fixturePath).size);

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.PROCESSING);
  });

  it('does not revert status to draft on a subsequent retry of the same video', async () => {
    const video = await createDraftVideo();
    video.status = VideoStatus.PROCESSING;
    await videoRepository.save(video);

    const outcome = waitForJobOutcome();
    await queue.add(PROCESS_VIDEO_JOB_NAME, { videoId: video.id });
    await outcome;

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.PROCESSING);
  });
});
