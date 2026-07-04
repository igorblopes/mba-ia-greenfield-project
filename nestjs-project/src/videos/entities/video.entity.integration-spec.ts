import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
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

  it('should generate a uuid primary key', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: '1024',
      }),
    );

    expect(video.id).toBeDefined();
  });

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: '1024',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject an invalid status enum value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "status", "original_filename", "content_type", "size") VALUES ($1, $2, $3, $4, $5)`,
        [channel.id, 'not-a-status', 'movie.mp4', 'video/mp4', '1024'],
      ),
    ).rejects.toThrow();
  });

  it('should enforce the channel_id foreign key constraint', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          original_filename: 'movie.mp4',
          content_type: 'video/mp4',
          size: '1024',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow nullable columns to be omitted', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: '1024',
      }),
    );

    expect(video.upload_id).toBeNull();
    expect(video.duration).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        original_filename: 'movie.mp4',
        content_type: 'video/mp4',
        size: '1024',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
