import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/videos/storage.service';
import type { ProcessVideoJobPayload } from '../src/videos/videos.service';
import {
  PROCESS_VIDEO_JOB_NAME,
  VIDEO_PROCESSING_QUEUE_NAME,
} from '../src/videos/videos.constants';

// AppModule bootstrap connects to real Postgres + MinIO (StorageService.onModuleInit
// ensures the bucket and lifecycle policy), which regularly exceeds Jest's 5s default hook timeout.
jest.setTimeout(30000);

interface AuthServiceWithMail {
  mailService: {
    sendConfirmationEmail: (
      email: string,
      name: string,
      token: string,
    ) => Promise<void>;
  };
}

interface DraftResponseBody {
  id: string;
  upload_id: string;
  status: string;
}

interface ErrorResponseBody {
  error: string;
}

interface UploadPartResponseBody {
  url: string;
  part_number: number;
  expires_in: number;
}

interface CompleteUploadResponseBody {
  id: string;
  status: string;
}

interface MeResponseBody {
  sub: string;
}

interface LoginResponseBody {
  access_token: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<ProcessVideoJobPayload>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue<ProcessVideoJobPayload>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
  });

  async function uploadPartAndGetEtag(
    accessToken: string,
    videoId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const partRes = await request(app.getHttpServer())
      .get(`/videos/${videoId}/upload-parts/${partNumber}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const { url } = partRes.body as UploadPartResponseBody;

    const uploadRes = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(uploadRes.status).toBe(200);
    const etag = uploadRes.headers.get('etag');
    if (!etag) {
      throw new Error(
        'MinIO did not return an ETag header for the uploaded part',
      );
    }
    return etag;
  }

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as unknown as AuthServiceWithMail)
      .mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(
        (_email: string, _name: string, token: string): Promise<void> => {
          capturedToken = token;
          return Promise.resolve();
        },
      );
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    const body = res.body as LoginResponseBody;
    return body.access_token;
  }

  async function channelIdFor(accessToken: string): Promise<string> {
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    const meBody = me.body as MeResponseBody;
    const rows = await dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM "channels" WHERE user_id = $1',
      [meBody.sub],
    );
    return rows[0].id;
  }

  const validDraftPayload = {
    original_filename: 'movie.mp4',
    content_type: 'video/mp4',
    size: 1024,
  };

  describe('POST /videos', () => {
    // 1.1 draft-criado-com-sucesso
    it('creates a draft video and returns id, upload_id and status', async () => {
      const accessToken = await registerConfirmAndLogin(
        'draft-owner@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validDraftPayload)
        .expect(201);
      const body = res.body as DraftResponseBody;

      expect(body.id).toBeDefined();
      expect(typeof body.upload_id).toBe('string');
      expect(body.upload_id.length).toBeGreaterThan(0);
      expect(body.status).toBe('draft');

      const expectedChannelId = await channelIdFor(accessToken);
      const persisted = await dataSource.query<Array<{ channel_id: string }>>(
        'SELECT channel_id FROM "videos" WHERE id = $1',
        [body.id],
      );
      expect(persisted[0].channel_id).toBe(expectedChannelId);
    });

    // 1.2 draft-rejeita-arquivo-acima-de-10gb
    it('rejects a declared size above 10GB with 413 FILE_TOO_LARGE', async () => {
      const accessToken = await registerConfirmAndLogin(
        'draft-toolarge@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validDraftPayload, size: 10737418241 })
        .expect(413);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('FILE_TOO_LARGE');

      const rows = await dataSource.query<unknown[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });

    // 1.3 draft-requer-autenticacao
    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validDraftPayload)
        .expect(401);

      const rows = await dataSource.query<unknown[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });

  describe('GET /videos/:id/upload-parts/:partNumber', () => {
    // 2.1 upload-part-url-para-dono-do-video
    it("returns a presigned URL for the video owner's part", async () => {
      const ownerToken = await registerConfirmAndLogin('owner@example.com');
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${draftBody.id}/upload-parts/1`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const body = res.body as UploadPartResponseBody;

      expect(typeof body.url).toBe('string');
      expect(body.url).toMatch(/^https?:\/\//);
      expect(body.part_number).toBe(1);
      expect(typeof body.expires_in).toBe('number');
    });

    // 2.2 upload-part-nao-owner-retorna-403
    it('returns 403 VIDEO_NOT_OWNED when called by a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin('owner2@example.com');
      const otherToken = await registerConfirmAndLogin('other@example.com');
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      const res = await request(app.getHttpServer())
        .get(`/videos/${draftBody.id}/upload-parts/1`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('VIDEO_NOT_OWNED');
    });

    // 2.3 upload-part-video-inexistente-retorna-404
    it('returns 404 VIDEO_NOT_FOUND for a non-existent video id', async () => {
      const ownerToken = await registerConfirmAndLogin('owner3@example.com');

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/upload-parts/1')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('POST /videos/:id/complete', () => {
    // 1.1 complete-upload-sucesso-publica-job
    it('completes the upload and publishes a process-video job', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete-owner@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      const etag = await uploadPartAndGetEtag(
        ownerToken,
        draftBody.id,
        1,
        Buffer.from('complete-upload-e2e-bytes'),
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${draftBody.id}/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);
      const body = res.body as CompleteUploadResponseBody;

      expect(body.id).toBe(draftBody.id);
      expect(body.status).toBe('draft');

      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      const publishedJob = jobs.find(
        (job) => job.data.videoId === draftBody.id,
      );
      expect(publishedJob).toBeDefined();
      expect(publishedJob!.name).toBe(PROCESS_VIDEO_JOB_NAME);
      expect(publishedJob!.data).toEqual({ videoId: draftBody.id });
    });

    // 1.2 complete-upload-video-ja-nao-draft-retorna-409
    it('returns 409 VIDEO_NOT_DRAFT when completed a second time', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete-twice@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;
      const etag = await uploadPartAndGetEtag(
        ownerToken,
        draftBody.id,
        1,
        Buffer.from('complete-twice-e2e-bytes'),
      );
      const parts = [{ part_number: 1, etag }];

      await request(app.getHttpServer())
        .post(`/videos/${draftBody.id}/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${draftBody.id}/complete`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parts })
        .expect(409);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('VIDEO_NOT_DRAFT');
    });

    // 1.3 complete-upload-nao-owner-retorna-403
    it('returns 403 VIDEO_NOT_OWNED when called by a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete-owner2@example.com',
      );
      const otherToken = await registerConfirmAndLogin(
        'complete-other@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      const res = await request(app.getHttpServer())
        .post(`/videos/${draftBody.id}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ part_number: 1, etag: '"whatever"' }] })
        .expect(403);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('VIDEO_NOT_OWNED');

      const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
      expect(jobs.some((job) => job.data.videoId === draftBody.id)).toBe(false);
    });
  });

  describe('DELETE /videos/:id', () => {
    // 2.1 abort-upload-sucesso-remove-registro
    it('deletes the draft and aborts the multipart upload on storage', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'abort-owner@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      await request(app.getHttpServer())
        .delete(`/videos/${draftBody.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);

      const rows = await dataSource.query<unknown[]>(
        'SELECT * FROM "videos" WHERE id = $1',
        [draftBody.id],
      );
      expect(rows).toHaveLength(0);

      const storageService = app.get(StorageService);
      const key = `videos/${draftBody.id}/original.mp4`;
      await expect(
        storageService.completeMultipartUpload(key, draftBody.upload_id, [
          { ETag: '"whatever"', PartNumber: 1 },
        ]),
      ).rejects.toThrow();
    });

    // 2.2 abort-upload-nao-owner-retorna-403
    it('returns 403 VIDEO_NOT_OWNED when called by a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'abort-owner2@example.com',
      );
      const otherToken = await registerConfirmAndLogin(
        'abort-other@example.com',
      );
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validDraftPayload)
        .expect(201);
      const draftBody = draftRes.body as DraftResponseBody;

      const res = await request(app.getHttpServer())
        .delete(`/videos/${draftBody.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);
      const body = res.body as ErrorResponseBody;

      expect(body.error).toBe('VIDEO_NOT_OWNED');

      const rows = await dataSource.query<unknown[]>(
        'SELECT * FROM "videos" WHERE id = $1',
        [draftBody.id],
      );
      expect(rows).toHaveLength(1);
    });
  });
});
