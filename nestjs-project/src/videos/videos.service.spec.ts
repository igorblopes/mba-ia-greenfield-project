import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import { MAX_VIDEO_SIZE_BYTES } from './videos.constants';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOneBy: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn(),
            presignUploadPart: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
  });

  describe('createDraft', () => {
    const dto: CreateVideoDto = {
      original_filename: 'movie.mp4',
      content_type: 'video/mp4',
      size: 1024,
    };

    it('throws FileTooLargeException when size exceeds the 10GB limit', async () => {
      await expect(
        service.createDraft('channel-1', {
          ...dto,
          size: MAX_VIDEO_SIZE_BYTES + 1,
        }),
      ).rejects.toThrow(FileTooLargeException);

      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('creates the draft, starts a multipart upload and returns its id/upload_id/status', async () => {
      const createdVideo = {
        id: 'video-1',
        channel_id: 'channel-1',
        status: VideoStatus.DRAFT,
        original_filename: dto.original_filename,
        content_type: dto.content_type,
        size: String(dto.size),
        upload_id: null,
      } as Video;

      videoRepository.create.mockReturnValue(createdVideo);
      videoRepository.save.mockImplementation((v) =>
        Promise.resolve(v as Video),
      );
      storageService.createMultipartUpload.mockResolvedValue('upload-123');

      const result = await service.createDraft('channel-1', dto);

      expect(videoRepository.create).toHaveBeenCalledWith({
        channel_id: 'channel-1',
        original_filename: dto.original_filename,
        content_type: dto.content_type,
        size: String(dto.size),
      });
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        dto.content_type,
      );
      expect(videoRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ upload_id: 'upload-123' }),
      );
      expect(result).toEqual({
        id: 'video-1',
        upload_id: 'upload-123',
        status: VideoStatus.DRAFT,
      });
    });
  });
});
