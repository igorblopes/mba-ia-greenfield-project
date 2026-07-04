import { IsInt, IsPositive, IsString } from 'class-validator';

export class CreateVideoDto {
  @IsString()
  original_filename: string;

  @IsString()
  content_type: string;

  /** Declared file size in bytes; the 10GB business limit is enforced by VideosService, not here. */
  @IsInt()
  @IsPositive()
  size: number;
}
