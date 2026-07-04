import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
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
}
