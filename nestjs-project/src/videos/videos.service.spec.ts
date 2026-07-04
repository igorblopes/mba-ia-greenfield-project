import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import {
  FileTooLargeException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import {
  MAX_VIDEO_SIZE_BYTES,
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from './videos.constants';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;
  let videoProcessingQueue: jest.Mocked<Queue>;

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
            remove: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn(),
            presignUploadPart: jest.fn(),
            completeMultipartUpload: jest.fn(),
            abortMultipartUpload: jest.fn(),
          },
        },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
          useValue: {
            add: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
    videoProcessingQueue = module.get(
      getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
    );
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

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      original_filename: 'movie.mp4',
      content_type: 'video/mp4',
      size: '1024',
      upload_id: 'upload-123',
      ...overrides,
    } as Video;
  }

  describe('completeUpload', () => {
    const dto: CompleteUploadDto = {
      parts: [{ part_number: 1, etag: '"abc123"' }],
    };

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.completeUpload('channel-1', 'video-1', dto),
      ).rejects.toThrow(VideoNotFoundException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('throws VideoNotOwnedException when the video belongs to another channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ channel_id: 'other-channel' }),
      );

      await expect(
        service.completeUpload('channel-1', 'video-1', dto),
      ).rejects.toThrow(VideoNotOwnedException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('throws VideoNotDraftException when the video is no longer draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('channel-1', 'video-1', dto),
      ).rejects.toThrow(VideoNotDraftException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('throws VideoNotDraftException when the upload was already completed', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ upload_id: null }),
      );

      await expect(
        service.completeUpload('channel-1', 'video-1', dto),
      ).rejects.toThrow(VideoNotDraftException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoProcessingQueue.add).not.toHaveBeenCalled();
    });

    it('completes the multipart upload and enqueues a process-video job', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      videoRepository.save.mockImplementation((v) =>
        Promise.resolve(v as Video),
      );

      const result = await service.completeUpload('channel-1', 'video-1', dto);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-123',
        [{ ETag: '"abc123"', PartNumber: 1 }],
      );
      expect(videoProcessingQueue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB_NAME,
        { videoId: 'video-1' },
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ upload_id: null }),
      );
      expect(result).toEqual({ id: 'video-1', status: VideoStatus.DRAFT });
    });
  });

  describe('abortUpload', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.abortUpload('channel-1', 'video-1')).rejects.toThrow(
        VideoNotFoundException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.remove).not.toHaveBeenCalled();
    });

    it('throws VideoNotOwnedException when the video belongs to another channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ channel_id: 'other-channel' }),
      );

      await expect(service.abortUpload('channel-1', 'video-1')).rejects.toThrow(
        VideoNotOwnedException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.remove).not.toHaveBeenCalled();
    });

    it('throws VideoNotDraftException when the video is no longer draft', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ status: VideoStatus.ERROR }),
      );

      await expect(service.abortUpload('channel-1', 'video-1')).rejects.toThrow(
        VideoNotDraftException,
      );
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.remove).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload and removes the video record', async () => {
      const video = draftVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      storageService.abortMultipartUpload.mockResolvedValue(undefined);

      await service.abortUpload('channel-1', 'video-1');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-123',
      );
      expect(videoRepository.remove).toHaveBeenCalledWith(video);
    });
  });
});
