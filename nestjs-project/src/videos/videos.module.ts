import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE_NAME } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE_NAME }),
  ],
  controllers: [VideosController],
  providers: [StorageService, VideosService],
  exports: [StorageService],
})
export class VideosModule {}
