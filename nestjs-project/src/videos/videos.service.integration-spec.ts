import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { ProcessVideoJobPayload, VideosService } from './videos.service';
import {
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from './videos.constants';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videosService: VideosService;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let queue: Queue<ProcessVideoJobPayload>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    queue = new Queue<ProcessVideoJobPayload>(VIDEO_PROCESSING_QUEUE_NAME, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });

    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadPart: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    videosService = new VideosService(
      videoRepository,
      storageService as unknown as StorageService,
      queue,
    );
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `chan${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  describe('createDraft', () => {
    it('persists a Video record with status draft owned by the channel', async () => {
      const channel = await createChannel();

      const result = await videosService.createDraft(channel.id, {
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: 1024,
      });

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload_id).toBe('upload-123');

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
      expect(persisted!.channel_id).toBe(channel.id);
      expect(persisted!.upload_id).toBe('upload-123');
      expect(persisted!.size).toBe('1024');
    });
  });

  describe('completeUpload', () => {
    it('publishes a process-video job on Redis with the correct payload', async () => {
      const channel = await createChannel();
      const draft = await videosService.createDraft(channel.id, {
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: 1024,
      });

      const result = await videosService.completeUpload(channel.id, draft.id, {
        parts: [{ part_number: 1, etag: '"abc123"' }],
      });

      expect(result).toEqual({ id: draft.id, status: VideoStatus.DRAFT });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        `videos/${draft.id}/original.mp4`,
        draft.upload_id,
        [{ ETag: '"abc123"', PartNumber: 1 }],
      );

      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      const publishedJob = jobs.find((job) => job.data.videoId === draft.id);
      expect(publishedJob).toBeDefined();
      expect(publishedJob!.name).toBe(PROCESS_VIDEO_JOB_NAME);
      expect(publishedJob!.data).toEqual({ videoId: draft.id });

      const persisted = await videoRepository.findOneBy({ id: draft.id });
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
      expect(persisted!.upload_id).toBeNull();
    });
  });
});
