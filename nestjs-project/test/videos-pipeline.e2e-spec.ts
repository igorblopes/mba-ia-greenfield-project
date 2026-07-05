import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

// AppModule bootstrap connects to real Postgres + MinIO (StorageService.onModuleInit
// ensures the bucket and lifecycle policy), which regularly exceeds Jest's 5s default
// hook timeout. Waiting for the real video-worker container to process the job on top
// of that budget is why this file's own timeout is higher than the other e2e specs.
jest.setTimeout(60000);

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

interface UploadPartResponseBody {
  url: string;
  part_number: number;
  expires_in: number;
}

interface DownloadResponseBody {
  url: string;
  expires_in: number;
}

interface LoginResponseBody {
  access_token: string;
}

describe('Videos pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoRepository: Repository<Video>;
  let fixtureBuffer: Buffer;

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
    videoRepository = moduleFixture.get(getRepositoryToken(Video));

    fixtureBuffer = await readFile(join(__dirname, 'fixtures', 'sample.mp4'));
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

  // Polls the DB directly rather than listening for a BullMQ job event: the
  // job is consumed by the real video-worker container (a separate process),
  // not by a Worker instance living inside this test.
  async function waitForProcessingOutcome(
    videoId: string,
    timeoutMs = 30000,
    intervalMs = 300,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const video = await videoRepository.findOneBy({ id: videoId });
      if (
        video &&
        (video.status === VideoStatus.READY ||
          video.status === VideoStatus.ERROR)
      ) {
        return video;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `Timed out waiting for video ${videoId} to leave 'processing' status`,
    );
  }

  // 1.1 pipeline-completo-draft-ate-ready-com-play-e-download-funcionais
  it('processes a full upload through the real worker pipeline: draft -> complete -> ready, with functional play/download URLs', async () => {
    const accessToken = await registerConfirmAndLogin(
      'pipeline-owner@example.com',
    );

    const draftRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        original_filename: 'sample.mp4',
        content_type: 'video/mp4',
        size: fixtureBuffer.length,
      })
      .expect(201);
    const draftBody = draftRes.body as DraftResponseBody;

    const etag = await uploadPartAndGetEtag(
      accessToken,
      draftBody.id,
      1,
      fixtureBuffer,
    );

    await request(app.getHttpServer())
      .post(`/videos/${draftBody.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    const processed = await waitForProcessingOutcome(draftBody.id);

    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration).toBe(2);
    expect(processed.width).toBe(320);
    expect(processed.height).toBe(240);
    expect(processed.size).toBe(String(fixtureBuffer.length));
    expect(processed.error_message).toBeNull();

    const playRes = await request(app.getHttpServer())
      .get(`/videos/${draftBody.id}/play`)
      .expect(200);
    expect(playRes.headers['content-length']).toBe(
      String(fixtureBuffer.length),
    );
    expect((playRes.body as Buffer).equals(fixtureBuffer)).toBe(true);

    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${draftBody.id}/download`)
      .expect(200);
    const downloadBody = downloadRes.body as DownloadResponseBody;
    expect(downloadBody.url).toMatch(/^https?:\/\//);
    expect(typeof downloadBody.expires_in).toBe('number');

    const downloadedRes = await fetch(downloadBody.url);
    expect(downloadedRes.status).toBe(200);
    const downloadedBody = Buffer.from(await downloadedRes.arrayBuffer());
    expect(downloadedBody.equals(fixtureBuffer)).toBe(true);
  });
});
