import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  type CompleteUploadResult,
  type CreateDraftResult,
  type UploadPartUrlResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft',
    description:
      "Pre-registers a video as a draft for the authenticated user's channel and starts a multipart upload session.",
  })
  @ApiResponse({
    status: 201,
    description: 'Video draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        upload_id: { type: 'string' },
        status: { type: 'string', example: 'draft' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared file size exceeds the 10GB upload limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.createDraft(channel.id, dto);
  }

  @Get(':id/upload-parts/:partNumber')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned upload part URL',
    description:
      'Returns a presigned S3 PUT URL for a specific part of an in-progress multipart upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned upload part URL',
    schema: {
      properties: {
        url: { type: 'string' },
        part_number: { type: 'number' },
        expires_in: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: "Video does not belong to the authenticated user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadPartUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<UploadPartUrlResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.getUploadPartUrl(channel.id, id, partNumber);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the S3 multipart upload from the collected part ETags and publishes a process-video job to the video-processing queue.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing job enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'draft' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Video does not belong to the authenticated user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    return this.videosService.completeUpload(channel.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the in-progress multipart upload in storage and removes the draft video record.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted and draft removed' })
  @ApiResponse({
    status: 403,
    description: "Video does not belong to the authenticated user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const channel = await this.channelsService.findByUserId(user.sub);
    await this.videosService.abortUpload(channel.id, id);
  }

  @Get(':id/play')
  @Public()
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Streams the video bytes for a ready video, proxying HTTP Range requests to storage for partial reads (206 Partial Content).',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video stream (no Range header sent)',
  })
  @ApiResponse({
    status: 206,
    description: 'Partial video stream honoring the Range header',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async play(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.getPlaybackStream(id, range);

    res.status(result.contentRange ? 206 : 200);
    res.set('Accept-Ranges', result.acceptRanges ?? 'bytes');
    if (result.contentType) {
      res.set('Content-Type', result.contentType);
    }
    if (result.contentLength !== undefined) {
      res.set('Content-Length', String(result.contentLength));
    }
    if (result.contentRange) {
      res.set('Content-Range', result.contentRange);
    }

    await pipeline(result.stream, res);
  }
}
