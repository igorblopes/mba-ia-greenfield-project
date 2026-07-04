import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videosService: VideosService;
  let storageService: jest.Mocked<Partial<StorageService>>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      presignUploadPart: jest.fn(),
    };
    videosService = new VideosService(
      videoRepository,
      storageService as unknown as StorageService,
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
});
