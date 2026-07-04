import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  LIFECYCLE_RULE_ID,
  MULTIPART_UPLOAD_ABORT_DAYS,
  PRESIGNED_GET_EXPIRES_IN_SECONDS,
  PRESIGNED_PUT_EXPIRES_IN_SECONDS,
} from './storage.constants';

export interface CompletedPart {
  ETag: string;
  PartNumber: number;
}

export interface PresignGetObjectOptions {
  responseContentDisposition?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
    await this.configureLifecyclePolicy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error(
        `CreateMultipartUpload did not return an UploadId for key "${key}"`,
      );
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.s3, command, {
      expiresIn: PRESIGNED_PUT_EXPIRES_IN_SECONDS,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async presignGetObject(
    key: string,
    options?: PresignGetObjectOptions,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options?.responseContentDisposition,
    });
    return getSignedUrl(this.s3, command, {
      expiresIn: PRESIGNED_GET_EXPIRES_IN_SECONDS,
    });
  }

  private async ensureBucketExists(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (statusCode !== 404) {
        throw error;
      }
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  private async configureLifecyclePolicy(): Promise<void> {
    try {
      await this.s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: LIFECYCLE_RULE_ID,
                Status: 'Enabled',
                Filter: { Prefix: '' },
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: MULTIPART_UPLOAD_ABORT_DAYS,
                },
              },
            ],
          },
        }),
      );
    } catch (error) {
      // MinIO's bucket-lifecycle XML validator rejects a rule whose only
      // action is AbortIncompleteMultipartUpload (verified against
      // minio/minio:RELEASE.2025-09-07T16-13-09Z — the same rule combined
      // with an Expiration action is accepted, so this is a MinIO schema
      // quirk, not a malformed request). Real S3 accepts this rule as-is.
      // MinIO already runs its own server-wide stale multipart upload sweep
      // by default (`api.stale_uploads_expiry`, 24h), so orphaned parts are
      // still cleaned up without this bucket-level policy — degrade to a
      // warning instead of failing application boot.
      if (!(error instanceof Error) || error.name !== 'InvalidArgument') {
        throw error;
      }
      this.logger.warn(
        `Could not configure the bucket lifecycle policy for orphaned multipart uploads (${error.message}). ` +
          "Relying on the storage provider's own stale multipart upload cleanup instead.",
      );
    }
  }
}
