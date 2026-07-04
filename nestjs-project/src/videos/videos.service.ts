import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { PRESIGNED_PUT_EXPIRES_IN_SECONDS } from './storage.constants';
import { MAX_VIDEO_SIZE_BYTES } from './videos.constants';

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

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
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

    const key = this.buildOriginalKey(video.id, dto.original_filename);
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

    const key = this.buildOriginalKey(video.id, video.original_filename);
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

  private buildOriginalKey(videoId: string, originalFilename: string): string {
    const ext = extname(originalFilename).slice(1) || 'bin';
    return `videos/${videoId}/original.${ext}`;
  }
}
