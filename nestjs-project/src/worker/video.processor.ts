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
import { buildOriginalKey } from '../videos/video-storage-key.util';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../videos/videos.constants';
import type { ProcessVideoJobPayload } from '../videos/videos.service';
import { probeVideo, type VideoMetadata } from './ffprobe.util';

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

    const key = buildOriginalKey(video.id, video.original_filename);
    const localPath = join(
      tmpdir(),
      `${video.id}-original${extname(video.original_filename)}`,
    );

    try {
      await this.storageService.downloadObject(key, localPath);
      return await probeVideo(localPath);
    } finally {
      await rm(localPath, { force: true });
    }
  }
}
