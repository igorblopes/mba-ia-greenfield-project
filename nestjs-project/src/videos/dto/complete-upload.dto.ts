import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  @IsInt()
  @IsPositive()
  part_number: number;

  @IsString()
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
