import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import {
  buildOriginalKey,
  buildThumbnailKey,
} from '../videos/video-storage-key.util';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../videos/videos.constants';
import type { ProcessVideoJobPayload } from '../videos/videos.service';
import { generateThumbnail } from './ffmpeg-thumbnail.util';
import { probeVideo, type VideoMetadata } from './ffprobe.util';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

@Processor(VIDEO_PROCESSING_QUEUE_NAME)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobPayload>): Promise<VideoMetadata> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.status === VideoStatus.DRAFT) {
      video.status = VideoStatus.PROCESSING;
      await this.videoRepository.save(video);
    }

    const originalKey = buildOriginalKey(video.id, video.original_filename);
    const localOriginalPath = join(
      tmpdir(),
      `${video.id}-original${extname(video.original_filename)}`,
    );
    const localThumbnailPath = join(tmpdir(), `${video.id}-thumbnail.jpg`);

    try {
      await this.storageService.downloadObject(originalKey, localOriginalPath);
      const metadata = await probeVideo(localOriginalPath);

      await generateThumbnail(
        localOriginalPath,
        localThumbnailPath,
        metadata.duration,
      );
      await this.storageService.uploadObject(
        buildThumbnailKey(video.id),
        localThumbnailPath,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.duration = metadata.duration;
      video.width = metadata.width;
      video.height = metadata.height;
      video.size = String(metadata.size);
      video.status = VideoStatus.READY;
      await this.videoRepository.save(video);

      return metadata;
    } catch (error) {
      if (this.isFinalAttempt(job)) {
        video.status = VideoStatus.ERROR;
        video.error_message =
          error instanceof Error ? error.message : String(error);
        await this.videoRepository.save(video);
      }
      throw error;
    } finally {
      await rm(localOriginalPath, { force: true });
      await rm(localThumbnailPath, { force: true });
    }
  }

  private isFinalAttempt(job: Job): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsStarted >= maxAttempts;
  }
}
