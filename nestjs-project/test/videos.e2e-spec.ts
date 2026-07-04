import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

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
});
