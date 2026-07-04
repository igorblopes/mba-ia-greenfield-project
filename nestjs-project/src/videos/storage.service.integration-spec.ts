import { randomUUID } from 'node:crypto';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

function buildTestConfig(bucket?: string): ConfigType<typeof storageConfig> {
  return {
    endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
    region: process.env.STORAGE_REGION || 'us-east-1',
    bucket: bucket ?? process.env.STORAGE_BUCKET ?? 'streamtube',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    forcePathStyle: true,
  };
}

async function uploadPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  if (!etag) {
    throw new Error(
      'MinIO did not return an ETag header for the uploaded part',
    );
  }
  return etag;
}

describe('StorageService (integration vs MinIO real)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    storageService = new StorageService(buildTestConfig());
    await storageService.onModuleInit();
  });

  describe('multipart upload round-trip', () => {
    it('creates, uploads a part to, and completes a multipart upload with real bytes', async () => {
      const key = `videos/test-${randomUUID()}/original.mp4`;
      const body = Buffer.from('multipart-upload-round-trip-bytes');

      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );
      expect(uploadId).toEqual(expect.any(String));

      const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
      const etag = await uploadPart(partUrl, body);

      await storageService.completeMultipartUpload(key, uploadId, [
        { ETag: etag, PartNumber: 1 },
      ]);

      const getUrl = await storageService.presignGetObject(key);
      const getResponse = await fetch(getUrl);
      expect(getResponse.status).toBe(200);
      const downloaded = Buffer.from(await getResponse.arrayBuffer());
      expect(downloaded.equals(body)).toBe(true);
    });

    it('aborts a multipart upload and removes the orphaned parts', async () => {
      const key = `videos/test-${randomUUID()}/original.mp4`;

      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );
      const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
      const etag = await uploadPart(partUrl, Buffer.from('orphaned-part'));

      await storageService.abortMultipartUpload(key, uploadId);

      await expect(
        storageService.completeMultipartUpload(key, uploadId, [
          { ETag: etag, PartNumber: 1 },
        ]),
      ).rejects.toThrow();
    });
  });

  describe('presignGetObject', () => {
    let key: string;

    beforeAll(async () => {
      key = `videos/test-${randomUUID()}/original.mp4`;
      const uploadId = await storageService.createMultipartUpload(
        key,
        'video/mp4',
      );
      const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
      const etag = await uploadPart(
        partUrl,
        Buffer.from('presign-get-object-bytes'),
      );
      await storageService.completeMultipartUpload(key, uploadId, [
        { ETag: etag, PartNumber: 1 },
      ]);
    });

    it('returns an inline URL with no Content-Disposition by default', async () => {
      const url = await storageService.presignGetObject(key);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBeNull();
    });

    it('returns a URL that serves the object as an attachment when requested', async () => {
      const url = await storageService.presignGetObject(key, {
        responseContentDisposition: 'attachment; filename="video.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
    });
  });

  describe('bucket auto-creation on boot', () => {
    it('creates the configured bucket automatically when it does not exist yet', async () => {
      const bucket = `streamtube-test-${randomUUID()}`;
      const freshService = new StorageService(buildTestConfig(bucket));

      await freshService.onModuleInit();

      const key = 'videos/boot-test/original.mp4';
      const uploadId = await freshService.createMultipartUpload(
        key,
        'video/mp4',
      );
      expect(uploadId).toEqual(expect.any(String));

      await freshService.abortMultipartUpload(key, uploadId);
    });
  });
});
