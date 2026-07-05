import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import {
  FileTooLargeException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService, type GetObjectResult } from './storage.service';
import {
  PRESIGNED_GET_EXPIRES_IN_SECONDS,
  PRESIGNED_PUT_EXPIRES_IN_SECONDS,
} from './storage.constants';
import { buildOriginalKey } from './video-storage-key.util';
import {
  MAX_VIDEO_SIZE_BYTES,
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from './videos.constants';

export interface CreateDraftResult {
  id: string;
  upload_id: string;
  status: VideoStatus;
}

export interface UploadPartUrlResult {
  url: string;
  part_number: number;
  expires_in: number;
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

export interface ProcessVideoJobPayload {
  videoId: string;
}

export interface DownloadUrlResult {
  url: string;
  expires_in: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE_NAME)
    private readonly videoProcessingQueue: Queue<ProcessVideoJobPayload>,
  ) {}

  async createDraft(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channelId,
        original_filename: dto.original_filename,
        content_type: dto.content_type,
        size: String(dto.size),
      }),
    );

    const key = buildOriginalKey(video.id, dto.original_filename);
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.content_type,
    );

    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return { id: video.id, upload_id: uploadId, status: video.status };
  }

  async getUploadPartUrl(
    channelId: string,
    videoId: string,
    partNumber: number,
  ): Promise<UploadPartUrlResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new VideoNotOwnedException();
    }

    const key = buildOriginalKey(video.id, video.original_filename);
    const url = await this.storageService.presignUploadPart(
      key,
      video.upload_id!,
      partNumber,
    );

    return {
      url,
      part_number: partNumber,
      expires_in: PRESIGNED_PUT_EXPIRES_IN_SECONDS,
    };
  }

  async completeUpload(
    channelId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedDraft(channelId, videoId);

    const key = buildOriginalKey(video.id, video.original_filename);
    await this.storageService.completeMultipartUpload(
      key,
      video.upload_id!,
      dto.parts.map((part) => ({
        ETag: part.etag,
        PartNumber: part.part_number,
      })),
    );

    await this.videoProcessingQueue.add(PROCESS_VIDEO_JOB_NAME, {
      videoId: video.id,
    });

    // status stays 'draft' until the worker consumes the job (TD-08); `upload_id`
    // is cleared to mark the multipart session as consumed, which is what makes
    // a second complete/abort call on this video correctly resolve as not-draft.
    video.upload_id = null;
    await this.videoRepository.save(video);

    return { id: video.id, status: video.status };
  }

  async abortUpload(channelId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraft(channelId, videoId);

    const key = buildOriginalKey(video.id, video.original_filename);
    await this.storageService.abortMultipartUpload(key, video.upload_id!);

    await this.videoRepository.remove(video);
  }

  async getPlaybackStream(
    videoId: string,
    range?: string,
  ): Promise<GetObjectResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    const key = buildOriginalKey(video.id, video.original_filename);
    return this.storageService.getObject(key, range);
  }

  async getDownloadUrl(videoId: string): Promise<DownloadUrlResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    // Same storage key the streaming endpoint serves — only the presigned
    // GET differs, forcing an attachment disposition so the client downloads
    // the file instead of playing it inline.
    const key = buildOriginalKey(video.id, video.original_filename);
    const url = await this.storageService.presignGetObject(key, {
      responseContentDisposition: `attachment; filename="${video.original_filename}"`,
    });

    return { url, expires_in: PRESIGNED_GET_EXPIRES_IN_SECONDS };
  }

  private async findOwnedDraft(
    channelId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new VideoNotOwnedException();
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotDraftException();
    }
    return video;
  }
}
