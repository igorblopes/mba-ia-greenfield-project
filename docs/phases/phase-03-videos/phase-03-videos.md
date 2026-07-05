---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-03T20:36:01-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-03T20:36:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T20:35:34-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar o pipeline completo de upload e processamento de vídeos da StreamTube: serviço de armazenamento de arquivos (vídeos e thumbnails) e serviço de processamento em segundo plano via fila; upload resiliente de até 10GB via S3 Multipart Upload com pré-cadastro automático do vídeo como rascunho; processamento automático em background (extração de duração/metadados via `ffprobe` e geração de thumbnail via `ffmpeg`) transicionando o vídeo por um ciclo de status até `ready` ou `error`; URL única por vídeo sem conflito; e reprodução via streaming (Range/206) e download, ambos via URL pré-assinada direta ao storage — sem qualquer superfície de frontend (fase backend-only, `next-frontend/` diferido).

---

## Step Implementations

### SI-03.1 — Infraestrutura Docker: MinIO, Redis e worker

**Description:** Provisiona a infraestrutura Docker nova da fase (fila e storage) e o container do `video-worker`, além dos namespaces de configuração correspondentes — base para todos os SIs seguintes.

**Technical actions:**

1. Adicionar serviço `redis` a `nestjs-project/compose.yaml` — imagem `redis` com tag fixada (ex. `redis:7-alpine`), `command: ["redis-server", "--appendonly", "yes"]`, volume nomeado para o AOF (`phase-03-videos/TD-01`)
2. Adicionar serviço `minio` a `nestjs-project/compose.yaml` — imagem `minio/minio` com tag fixada, portas `9000`/`9001`, volume nomeado, criação do bucket privado no boot (`phase-03-videos/TD-03`)
3. Adicionar serviço `video-worker` a `nestjs-project/compose.yaml` — mesma imagem/`Dockerfile.dev` do `nestjs-api`, `command` de bootstrap standalone, `depends_on: [db, redis, minio]` (`phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
4. Atualizar `nestjs-project/Dockerfile.dev` — `apt-get install ffmpeg` (fornece os binários `ffmpeg` e `ffprobe`) (`phase-03-videos/TD-04`)
5. Criar `src/config/queue.config.ts` (`registerAs('queue', ...)` — host/port do Redis) e `src/config/storage.config.ts` (`registerAs('storage', ...)` — bucket, region, endpoint, credenciais, `forcePathStyle`); estender `src/config/env.validation.ts` (Joi) e `.env.example` com as novas variáveis (`phase-03-videos/TD-01`, `phase-03-videos/TD-03`, padrão `phase-01-configuracao-base/TD-03`)

**Tests:** _(empty — Infra; validado por AC via `docker compose ps`/smoke checks, sem novo arquivo de teste)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` inicia os serviços `redis`, `minio` e `video-worker` sem erros, todos com status `running` em `docker compose ps`
- `ffmpeg -version` e `ffprobe -version` executam com sucesso dentro do container `nestjs-api` (mesma imagem do `video-worker`)
- O MinIO está acessível internamente em `http://minio:9000` e o bucket configurado é criado automaticamente no boot
- O Redis está acessível internamente em `redis:6379` com persistência AOF habilitada
- A aplicação falha ao subir caso as novas variáveis de ambiente de fila/storage obrigatórias estejam ausentes (validação Joi)

---

### SI-03.2 — Data model: entidade Video, migration, repository e relação com Channel

**Description:** Cria a entity `Video`, o módulo de vídeos e a migration correspondente, estabelecendo o schema base sobre o qual toda a fase é construída.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (`id` uuid PK, `channel_id` uuid FK, `status` enum nativo `draft|processing|ready|error` default `'draft'`, `original_filename`, `content_type`, `size` bigint, `upload_id` nullable, `duration`/`width`/`height` nullable, `error_message` nullable, timestamps) e relação `@ManyToOne(() => Channel)` (`phase-03-videos/TD-07`, `phase-03-videos/TD-08`, `phase-03-videos/TD-04` revisão 2026-07-03)
2. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`
3. Registrar `VideosModule` em `src/app.module.ts`
4. Gerar a migration via `npm run migration:generate -- src/database/migrations/CreateVideos` — cria a tabela `videos` e o tipo enum `videos_status_enum`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: PK uuid, `status` enum + default `'draft'`, FK `channel_id`, colunas nullable | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas do Data Model, incluindo o enum nativo `status`
- Inserir um registro `Video` sem `channel_id` viola a constraint de FK — operação rejeitada pelo banco
- Um registro `Video` criado sem `status` explícito assume o valor default `'draft'`
- `npm run migration:revert` desfaz a migration sem deixar tabelas ou tipos enum órfãos

---

### SI-03.3 — Storage service e URL pré-assinada de upload

**Description:** Implementa o `StorageService` sobre o AWS SDK v3 configurado para o MinIO, cobrindo o ciclo completo do multipart upload e a geração de URLs pré-assinadas de leitura — base reutilizada por todos os endpoints HTTP da fase.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1079.0` e `@aws-sdk/s3-request-presigner@^3.1079.0` (`phase-03-videos/TD-03`)
2. Criar `src/videos/storage.service.ts` — `S3Client` configurado com `endpoint`, `forcePathStyle: true` e credenciais do namespace `storage` (`phase-03-videos/TD-03`); métodos `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (`phase-03-videos/TD-02`) e `presignGetObject(key, options)` com suporte a `ResponseContentDisposition` opcional (`phase-03-videos/TD-06`, `phase-03-videos/TD-03`)
3. Registrar `StorageService` como provider em `VideosModule` (`exports` para uso futuro pelo `video-worker`)
4. Criar rotina de criação do bucket no boot (verifica existência via `HeadBucket`, cria via `CreateBucket` se ausente) (`phase-03-videos/TD-03`, `phase-03-videos/TD-10`)
5. Configurar lifecycle policy `AbortIncompleteMultipartUpload` no bucket (`phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration vs MinIO real: `createMultipartUpload`/`presignUploadPart`/`completeMultipartUpload`/`abortMultipartUpload` round-trip com bytes reais | `src/videos/storage.service.integration-spec.ts` |
| `StorageService.presignGetObject` | Integration vs MinIO real: URL inline vs. `ResponseContentDisposition: attachment` | `src/videos/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `StorageService.createMultipartUpload` retorna um `uploadId` válido do MinIO real para a chave `videos/{videoId}/original.<ext>`
- `StorageService.presignUploadPart` retorna uma URL `PUT` pré-assinada que aceita upload de bytes reais quando testada contra o MinIO
- `StorageService.completeMultipartUpload` finaliza o objeto no bucket a partir das ETags das partes
- `StorageService.abortMultipartUpload` remove as partes órfãs de um upload cancelado
- O bucket configurado é criado automaticamente no boot da aplicação caso ainda não exista

---

### SI-03.4 — API de pré-cadastro do vídeo como draft

**Route:** POST /videos, GET /videos/:id/upload-parts/:partNumber
**Test Specs:** see `nestjs-project/specs/videos-draft.plan.md`
**Authorization:** POST /videos — Authenticated. GET .../upload-parts/:partNumber — Authenticated + Owner (`video.channel_id` do usuário autenticado)

**Description:** Expõe o pré-cadastro do vídeo como rascunho (cria o registro `draft` e inicia o multipart upload) e a obtenção sob demanda da URL pré-assinada de cada parte.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` (`original_filename: string`, `content_type: string`, `size: number`) com `class-validator` (`phase-03-videos/TD-02`)
2. Adicionar `FileTooLargeException` (413), `VideoNotFoundException` (404) e `VideoNotOwnedException` (403) a `src/common/exceptions/domain.exception.ts`, seguindo o padrão `DomainException` existente
3. Criar `src/videos/videos.service.ts` — método `createDraft(channelId, dto)`: valida `size ≤ 10737418240` (senão `FileTooLargeException`), cria o registro `Video` com `status: 'draft'`, chama `storageService.createMultipartUpload` e persiste `upload_id` (`phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
4. Criar `src/videos/videos.controller.ts` — `@Controller('videos')`, `POST /videos` (canal resolvido do JWT do usuário autenticado) e `GET /videos/:id/upload-parts/:partNumber` (valida posse via `channel_id`, lança `VideoNotOwnedException`/`VideoNotFoundException`)
5. Documentar ambos os endpoints com `@nestjs/swagger` (`@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse` por status, `@ApiBearerAuth('access-token')`) seguindo o padrão de `auth.controller.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: branch `FILE_TOO_LARGE`, criação do draft (storage mockado) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: persiste o registro `Video` com `status: 'draft'` (DB real) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` autenticado com payload válido retorna `201` com `id`, `upload_id` e `status: 'draft'`
- `POST /videos` com `size` acima de `10737418240` bytes retorna `413` com `errorCode: 'FILE_TOO_LARGE'`
- `POST /videos` sem token de acesso retorna `401`
- `GET /videos/:id/upload-parts/:partNumber` chamado pelo dono do vídeo retorna `200` com uma URL pré-assinada
- `GET /videos/:id/upload-parts/:partNumber` chamado por um usuário que não é dono retorna `403` com `errorCode: 'VIDEO_NOT_OWNED'`
- `GET /videos/:id/upload-parts/:partNumber` com `id` inexistente retorna `404` com `errorCode: 'VIDEO_NOT_FOUND'`

---

### SI-03.5 — Confirmação de upload e publicação de job na fila

**Route:** POST /videos/:id/complete, DELETE /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Authenticated + Owner (`video.channel_id` do usuário autenticado) em ambas as rotas

**Description:** Conclui o multipart upload (ou o aborta) e, no caminho de sucesso, publica o job de processamento na fila `video-processing` — ponte entre o upload e o worker.

**Technical actions:**

1. Instalar `bullmq@^5.79.2` e `@nestjs/bullmq@^11.0.4` (`phase-03-videos/TD-01`)
2. Registrar `BullModule.forRoot({ connection })` e `BullModule.registerQueue({ name: 'video-processing' })` em `src/app.module.ts` (lado produtor) (`phase-03-videos/TD-01`)
3. Adicionar `VideoNotDraftException` (409) a `src/common/exceptions/domain.exception.ts`
4. Estender `VideosService` com `completeUpload(videoId, channelId, dto)` — valida posse + `status: 'draft'` (senão `VideoNotOwnedException`/`VideoNotDraftException`), chama `storageService.completeMultipartUpload` e enfileira o job `process-video` com `{ videoId }` (`phase-03-videos/TD-02`); e `abortUpload(videoId, channelId)` — valida posse + `status: 'draft'`, chama `storageService.abortMultipartUpload` e remove o registro `Video`
5. Adicionar `POST /videos/:id/complete` (`CompleteUploadDto`: `parts: { part_number, etag }[]`) e `DELETE /videos/:id` a `VideosController`, com documentação `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` / `abortUpload` | Unit: branches de posse/status (storage e fila mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration vs Redis real: job `process-video` publicado com payload correto | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.1

**Acceptance criteria:**

- `POST /videos/:id/complete` do dono, com `parts` válidas, retorna `200` e publica um job `process-video` na fila `video-processing` com `{ videoId }`
- `POST /videos/:id/complete` chamado uma segunda vez sobre o mesmo vídeo retorna `409` com `errorCode: 'VIDEO_NOT_DRAFT'`
- `DELETE /videos/:id` do dono, com vídeo em `draft`, retorna `204`, remove o registro e aborta o multipart upload no storage
- `POST /videos/:id/complete` ou `DELETE /videos/:id` chamado por um usuário que não é dono retorna `403` com `errorCode: 'VIDEO_NOT_OWNED'`

---

### SI-03.6 — Worker de processamento com FFmpeg/ffprobe

**Description:** Estabelece o segundo bootstrap da aplicação (`video-worker`) e o consumidor da fila que extrai metadados do vídeo original via `ffprobe`.

**Technical actions:**

1. Criar `src/worker.ts` — bootstrap standalone via `NestFactory.createApplicationContext(WorkerModule)`, sem listener HTTP (`phase-03-videos/TD-04`)
2. Criar `src/worker/worker.module.ts` — importa `ConfigModule`, `TypeOrmModule.forRootAsync` (mesma `databaseConfig` compartilhada), `BullModule.registerQueue({ name: 'video-processing' })` e `VideosModule` (`phase-03-videos/TD-04`)
3. Criar `src/worker/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`; `async process(job)` atualiza `Video.status` para `'processing'` na primeira tentativa e baixa o objeto original do storage para um caminho efêmero local (`phase-03-videos/TD-04`, `phase-03-videos/TD-08`)
4. Criar `src/worker/ffprobe.util.ts` — `child_process.spawn('ffprobe', ['-print_format', 'json', '-show_format', '-show_streams', input])`, parse de `format.duration`, `format.size`, `streams[].width`/`height` (`phase-03-videos/TD-04`)
5. Atualizar o `command` do serviço `video-worker` em `compose.yaml` para o bootstrap compilado de `src/worker.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffprobe.util` | Unit: parse de uma saída JSON de exemplo do `ffprobe` | `src/worker/ffprobe.util.spec.ts` |
| `VideoProcessor` | Integration vs Redis + `ffprobe` reais + fixture de vídeo: extrai `duration`/`size`/`width`/`height` corretos, `status` vira `'processing'` | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.1

**Acceptance criteria:**

- O `video-worker` consome um job `process-video` da fila `video-processing` e atualiza `Video.status` para `'processing'` na primeira tentativa
- `ffprobe` executado sobre uma fixture real de vídeo retorna `duration`, `size`, `width` e `height` corretos, extraídos via `child_process.spawn`
- Retries subsequentes do mesmo job não revertem o `status` para `'draft'`

---

### SI-03.7 — Thumbnail, metadados e transição para ready/error

**Description:** Completa o pipeline do worker — geração de thumbnail via `ffmpeg`, persistência final dos metadados e a transição de status para `'ready'` ou `'error'` conforme o resultado do processamento.

**Technical actions:**

1. Criar `src/worker/ffmpeg-thumbnail.util.ts` — calcula `offset = max(1, duration * 0.1)` com clamp `min(offset, duration - 0.1)` para vídeos curtos; `child_process.spawn('ffmpeg', ['-ss', offset, '-i', input, '-vframes', '1', out])` (`phase-03-videos/TD-05`)
2. Estender `VideoProcessor.process()` — após o `ffprobe`, chama `ffmpeg-thumbnail.util`, envia o frame para `videos/{videoId}/thumbnail.jpg` via `StorageService`, persiste `duration`/`width`/`height`/`size` e atualiza `status` para `'ready'` (`phase-03-videos/TD-05`, `phase-03-videos/TD-04` revisão 2026-07-03, `phase-03-videos/TD-08`)
3. Adicionar tratamento de falha em `VideoProcessor` — falhas de etapa (stream de vídeo ausente, exceção) deixam o BullMQ reprocessar (3 tentativas, backoff exponencial já configurado em SI-03.5); na tentativa final esgotada, persiste `error_message` (erro real capturado) e atualiza `status` para `'error'` (`phase-03-videos/TD-09`)
4. Adicionar timeout de `spawn` para `ffprobe` e `ffmpeg` (kill após N minutos configurável) — falha tratada como etapa 3 (`phase-03-videos/TD-04`, `phase-03-videos/TD-09`)
5. Limpar os arquivos temporários locais ao final do `process()`, tanto no caminho de sucesso quanto no de falha definitiva

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffmpeg-thumbnail.util` | Unit: cálculo do offset + clamp para vídeos curtos | `src/worker/ffmpeg-thumbnail.util.spec.ts` |
| `VideoProcessor` | Integration vs `ffmpeg`/MinIO/Redis reais + fixture: caminho feliz termina em `status: 'ready'` com thumbnail no storage e metadados persistidos | `src/worker/video.processor.integration-spec.ts` |
| `VideoProcessor` | Integration: fixture corrompida esgota os retries e termina em `status: 'error'` com `error_message` populado | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Ao final do processamento bem-sucedido, `Video.status` é `'ready'`, com `duration`/`width`/`height`/`size` persistidos e o objeto `videos/{videoId}/thumbnail.jpg` presente no storage
- O offset do frame de thumbnail é `max(1, duration * 0.1)`, com clamp aplicado para vídeos curtos
- Após esgotar as 3 tentativas de retry sobre uma fixture corrompida, `Video.status` é `'error'` com `error_message` populado com o erro real capturado
- Arquivos temporários locais usados no processamento não permanecem no disco do worker após o job, em sucesso ou falha

---

### SI-03.8 — Endpoint de streaming com Range/206

**Route:** GET /videos/:id/play
**Test Specs:** see `nestjs-project/specs/videos-play.plan.md`
**Authorization:** Public (`@Public()`) — vídeo `ready` assistível por anônimos (`phase-03-videos/TD-06`)

**Description:** _(revisado em 2026-07-05 — override de `phase-03-videos/TD-06`, ver addendum "Override" no TD)._ Endpoint faz proxy de streaming: repassa o header `Range` recebido ao `GetObjectCommand` do storage (leitura parcial, sem carregar o arquivo inteiro em memória), e monta a resposta HTTP manualmente com `206 Partial Content`/`Content-Range`/`Accept-Ranges`/`Content-Length`/`Content-Type` a partir do que o S3/MinIO retornar.

**Technical actions:**

1. Adicionar `VideoNotReadyException` (409) a `src/common/exceptions/domain.exception.ts`
2. Estender `StorageService` com `getObject(key, range?)` — `GetObjectCommand` repassando o parâmetro `Range` (formato `bytes=start-end`) recebido do cliente; retorna `{ stream, contentType, contentLength, contentRange, acceptRanges }` a partir da resposta do S3/MinIO, sem bufferizar o corpo
3. Estender `VideosService` com `getPlaybackStream(videoId, range?)` — valida `status: 'ready'` (senão `VideoNotReadyException`), resolve a storage key e delega a `storageService.getObject(key, range)`
4. Adicionar `GET /videos/:id/play` a `VideosController` — `@Public()`, lê o header `Range` da requisição, define status `206` (quando `contentRange` presente) ou `200`, define `Content-Type`/`Accept-Ranges`/`Content-Length`/`Content-Range` e faz `pipeline` do stream retornado direto para a resposta (`@Res()`, sem `StreamableFile` — evita o bug conhecido `nestjs/nest#14873` de Range + iOS), documentado via `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackStream` | Unit: branch `VIDEO_NOT_READY`, branch `VIDEO_NOT_FOUND`, repasse do `range` ao storage (storage mockado) | `src/videos/videos.service.spec.ts` |
| `StorageService.getObject` | Integration vs MinIO real: leitura sem `Range` retorna o objeto completo; leitura com `Range: bytes=0-N` retorna `contentRange`/`contentLength` refletindo a leitura parcial | `src/videos/storage.service.integration-spec.ts` |
| `GET /videos/:id/play` | E2E: sem `Range` → `200` com corpo completo; com `Range` → `206` + `Content-Range`; vídeo não-`ready` → `409`; vídeo inexistente → `404` | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.7

**Acceptance criteria:**

- `GET /videos/:id/play` sem autenticação, para um vídeo com `status: 'ready'` e sem header `Range`, retorna `200` com o corpo completo do vídeo e headers `Content-Type`/`Content-Length`/`Accept-Ranges: bytes`
- `GET /videos/:id/play` com header `Range` retorna `206 Partial Content` com `Content-Range` refletindo o intervalo servido, lendo apenas a porção solicitada do storage (sem download completo, sem bufferizar o arquivo inteiro em memória)
- `GET /videos/:id/play` para um vídeo que não está `'ready'` retorna `409` com `errorCode: 'VIDEO_NOT_READY'`
- `GET /videos/:id/play` com `id` inexistente retorna `404` com `errorCode: 'VIDEO_NOT_FOUND'`

---

### SI-03.9 — Endpoint de download

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Public (`@Public()`) — mesma URL pré-assinada do streaming, variando apenas o parâmetro de disposição (`phase-03-videos/TD-03`)

**Description:** Expõe a URL pré-assinada de download — mesma chave e endpoint do streaming, forçando `ResponseContentDisposition: attachment`.

**Technical actions:**

1. Estender `VideosService` com `getDownloadUrl(videoId)` — valida `status: 'ready'` (senão `VideoNotReadyException`), chama `storageService.presignGetObject(key, { attachment: true, filename: original_filename })` (`phase-03-videos/TD-03`)
2. Adicionar `GET /videos/:id/download` a `VideosController` — `@Public()`, retorna `{ url, expires_in }`, documentado via `@nestjs/swagger`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: branch `VIDEO_NOT_READY`, parâmetro `ResponseContentDisposition` | `src/videos/videos.service.spec.ts` |
| `StorageService.presignGetObject` (attachment) | Integration vs MinIO real: URL retornada serve o objeto com `Content-Disposition: attachment` | `src/videos/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.7

**Acceptance criteria:**

- `GET /videos/:id/download` sem autenticação, para um vídeo com `status: 'ready'`, retorna `200` com uma URL pré-assinada contendo disposição de anexo
- `GET /videos/:id/download` para um vídeo que não está `'ready'` retorna `409` com `errorCode: 'VIDEO_NOT_READY'`
- A URL de download referencia a mesma chave de storage da URL de streaming, diferindo apenas no parâmetro de disposição

---

### SI-03.10 — Testes, documentação e fechamento

**Description:** Fecha a fase com a suíte E2E do pipeline completo, fixtures de teste e a verificação da Definition of Done.

**Technical actions:**

1. Adicionar fixtures de vídeo minúsculas (1-3s, poucos KB, `mp4`/`webm`) em `nestjs-project/test/fixtures/` (`phase-03-videos/TD-10`)
2. Criar `test/videos-pipeline.e2e-spec.ts` — cobre o fluxo completo: criar draft → completar upload → worker processa (fila + `ffmpeg`/`ffprobe` reais) → status `'ready'` → URLs de `play`/`download` funcionais (`phase-03-videos/TD-10`)
3. Consolidar `.env.example` com o conjunto completo de variáveis novas (fila e storage) introduzidas em SI-03.1–SI-03.9
4. Rodar e corrigir a suíte completa — `docker compose exec nestjs-api npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint` — conforme a Definition of Done (`CLAUDE.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline completo (upload → processamento → ready) | E2E: draft, complete, processamento real (fila + `ffmpeg`/`ffprobe` + MinIO), status `'ready'`, URLs de play/download funcionais | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.8, SI-03.9

**Acceptance criteria:**

- O fluxo completo (criar draft → completar upload → worker processa com `ffmpeg`/`ffprobe` reais → `status: 'ready'`) passa em `test/videos-pipeline.e2e-spec.ts`, usando fixtures de poucos KB
- `docker compose exec nestjs-api npm test -- --runInBand` passa sem falhas
- `docker compose exec nestjs-api npm run test:e2e` passa sem falhas
- `npx tsc --noEmit` retorna código de saída `0`
- `npm run lint` não reporta erros

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Reaproveitado como chave pública da URL e como prefixo da chave de storage (`phase-03-videos/TD-07`, `phase-03-videos/TD-03`) |
| channel_id | uuid | FK → channels.id, not null | Canal dono do vídeo; resolvido do usuário autenticado (JWT) na criação |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | Enum nativo PostgreSQL, coluna única (`phase-03-videos/TD-08`) |
| original_filename | varchar | not null | Nome original enviado pelo cliente; fonte da extensão usada na chave `original.<ext>` (`phase-03-videos/TD-03`) |
| content_type | varchar | not null | MIME type declarado pelo cliente; usado no `PutObject`/multipart (`phase-03-videos/TD-03`) |
| size | bigint | not null | Bytes declarados na criação (validado ≤ 10GB); sobrescrito pelo valor de `format.size` do `ffprobe` ao concluir o processamento (`phase-03-videos/TD-04`, revisão 2026-07-03) |
| upload_id | varchar | nullable | `UploadId` do S3 Multipart Upload (`phase-03-videos/TD-02`) |
| duration | integer | nullable | Segundos; populado pelo worker via `ffprobe` (`phase-03-videos/TD-04`, revisão 2026-07-03) |
| width | integer | nullable | Pixels; populado pelo worker via `ffprobe` (`phase-03-videos/TD-04`, revisão 2026-07-03) |
| height | integer | nullable | Pixels; populado pelo worker via `ffprobe` (`phase-03-videos/TD-04`, revisão 2026-07-03) |
| error_message | text | nullable | Populado apenas na transição final para `error` — mensagem real capturada (stderr do ffmpeg/ffprobe, exception) (`phase-03-videos/TD-09`) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(channel_id)` — FK

---

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Content-Type: application/json

**Request body:**
- original_filename: string, required
- content_type: string, required
- size: number, required — bytes, max `10737418240` (10GB, `phase-03-videos/TD-02`)

**Response 201:**
- id: string (uuid)
- upload_id: string
- status: `'draft'`

**Error responses:**
- 413 FILE_TOO_LARGE: when `size` exceeds 10GB
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:id/upload-parts/:partNumber (SI-03.3, SI-03.4)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string (presigned S3 `PUT` URL for this part)
- part_number: number
- expires_in: number (seconds)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match an existing video
- 403 VIDEO_NOT_OWNED: when the video's `channel_id` does not belong to the authenticated user
- 409 VIDEO_NOT_DRAFT: when the video is no longer in `draft` status

---

#### POST /videos/:id/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — each item `{ part_number: number, etag: string }`

**Response 200:**
- id: string (uuid)
- status: `'draft'` (transição para `'processing'` ocorre quando o worker consome o job, `phase-03-videos/TD-08`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match an existing video
- 403 VIDEO_NOT_OWNED: when the video's `channel_id` does not belong to the authenticated user
- 409 VIDEO_NOT_DRAFT: when the video is no longer in `draft` status
- 400 validation error: when `parts` is missing or malformed

---

#### DELETE /videos/:id (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match an existing video
- 403 VIDEO_NOT_OWNED: when the video's `channel_id` does not belong to the authenticated user
- 409 VIDEO_NOT_DRAFT: when the video is no longer in `draft` status (upload already completed/processed)

---

#### GET /videos/:id/play (SI-03.8)

_(revisado em 2026-07-05 — override de `phase-03-videos/TD-06`, ver addendum "Override" no TD)._

**Response 200 (no `Range` header):** full video body, streamed from storage.
- Headers: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`

**Response 206 (with `Range` header):** partial video body, read directly from storage (no full download).
- Headers: `Content-Type`, `Content-Length` (partial), `Content-Range`, `Accept-Ranges: bytes`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match an existing video
- 409 VIDEO_NOT_READY: when the video's status is not `'ready'`

---

#### GET /videos/:id/download (SI-03.9)

**Response 200:**
- url: string (presigned S3 `GET` URL, `ResponseContentDisposition: attachment` — `phase-03-videos/TD-03`)
- expires_in: number (seconds, ~21600 / 6h)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match an existing video
- 409 VIDEO_NOT_READY: when the video's status is not `'ready'`

#### Validation Rules — Upload

| Field | Rule | Error message |
|-------|------|----------------|
| original_filename | required, non-empty string | original_filename should not be empty |
| content_type | required, non-empty string | content_type should not be empty |
| size | required, integer, max `10737418240` (10GB) | size must not exceed 10737418240 |
| parts | required, non-empty array of `{ part_number, etag }` | parts should not be empty |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|----------------|-------|-------|
| POST /videos | | ✓ | | Canal resolvido do usuário autenticado |
| GET /videos/:id/upload-parts/:partNumber | | ✓ | ✓ | Owner = `video.channel_id` pertence ao usuário |
| POST /videos/:id/complete | | ✓ | ✓ | Owner = `video.channel_id` pertence ao usuário |
| DELETE /videos/:id | | ✓ | ✓ | Owner = `video.channel_id` pertence ao usuário |
| GET /videos/:id/play | ✓ | | | `@Public()` — vídeo `ready` assistível por anônimos (`phase-03-videos/TD-06`) |
| GET /videos/:id/download | ✓ | | | `@Public()` — mesma URL pré-assinada, `ResponseContentDisposition: attachment` (`phase-03-videos/TD-03`) |

---

### Error Catalog

**Error response format:** (herdado da Fase 02, `## Inherited Conventions`)
```
{ statusCode: number, error: string, message: string }
```

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| FILE_TOO_LARGE | 413 | File size exceeds the 10GB upload limit | POST /videos com `size` > `10737418240` bytes |
| VIDEO_NOT_FOUND | 404 | Video not found | Qualquer endpoint com `:id` referenciando um vídeo inexistente |
| VIDEO_NOT_OWNED | 403 | Video does not belong to the authenticated user's channel | upload-parts / complete / abort chamado por um usuário que não é dono do vídeo |
| VIDEO_NOT_DRAFT | 409 | Video is not in draft status | upload-parts / complete / abort chamado após o vídeo sair do status `draft` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET .../play ou .../download chamado enquanto o status não é `ready` |

---

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (ao concluir o multipart upload — `POST /videos/:id/complete`, `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessor` (`video-worker`, `phase-03-videos/TD-04`)
**Trigger:** Multipart upload confirmado com sucesso (SI-03.5)
**Delivery semantics:** at-least-once (retry nativo do BullMQ — 3 tentativas, backoff exponencial, `phase-03-videos/TD-01`, `phase-03-videos/TD-09`); o processamento deve tolerar reentrega (checagem idempotente de status antes de reprocessar)

---

### Storage Keys/Buckets

**Bucket:** único, privado por padrão (`phase-03-videos/TD-03`) — nome fixado via config (`registerAs('storage', ...)`, ex. `streamtube`).

**Chaves:**

| Objeto | Chave | Gerado por |
|--------|-------|-----------|
| Original | `videos/{videoId}/original.<ext>` | `<ext>` derivada de `original_filename` (SI-03.4); upload multipart do cliente (SI-03.3/03.4) |
| Thumbnail | `videos/{videoId}/thumbnail.jpg` | Worker, frame único via `ffmpeg` (SI-03.7, `phase-03-videos/TD-05`) |

**Acesso:** exclusivamente via URL pré-assinada — `PUT` por parte (upload multipart), `GET` inline (streaming, sem `ResponseContentDisposition`), `GET` com `ResponseContentDisposition: attachment` (download). Mesma chave e endpoint em todos os casos; só muda o parâmetro (`phase-03-videos/TD-03`).

**Lifecycle policy:** `AbortIncompleteMultipartUpload` no bucket — limpa partes órfãs de uploads abandonados/abortados (`phase-03-videos/TD-02`).

---

### Worker Processing Flow

1. `video-worker` consome o job `process-video` da fila `video-processing` (`phase-03-videos/TD-01`, `phase-03-videos/TD-04`).
2. Na primeira tentativa do job, atualiza `Video.status` para `'processing'` (`phase-03-videos/TD-08`) — tentativas subsequentes de retry não revertem o status.
3. Baixa o objeto original do storage (`videos/{videoId}/original.<ext>`) para um caminho efêmero local (ou processa via stream, conforme dimensionamento de disco do worker — `phase-03-videos/TD-04`).
4. Extrai metadados via `ffprobe -print_format json -show_format -show_streams <input>` (`child_process.spawn`) — parse de `format.duration`, `format.size`, `streams[].width`/`height` (`phase-03-videos/TD-04`, revisão 2026-07-03).
5. Calcula o offset do frame de thumbnail: `offset = max(1, duration * 0.1)`, com clamp `min(offset, duration - 0.1)` para vídeos curtos (`phase-03-videos/TD-05`).
6. Gera o frame via `ffmpeg -ss <offset> -i <input> -vframes 1 <out.jpg>` e envia para `videos/{videoId}/thumbnail.jpg` (`phase-03-videos/TD-05`).
7. Persiste `duration`, `width`, `height`, `size` (sobrescrito pelo valor probado) na entity `Video` e atualiza `status` para `'ready'` (SI-03.7, `phase-03-videos/TD-04`, `phase-03-videos/TD-08`).
8. Em caso de falha em qualquer etapa (stream de vídeo ausente, timeout do `spawn`, exceção) — deixa o BullMQ reprocessar via retry (3 tentativas, backoff exponencial); após esgotar as tentativas, persiste `error_message` (erro real capturado) e atualiza `status` para `'error'` (`phase-03-videos/TD-09`).
9. Limpa arquivos temporários locais ao final (sucesso ou falha definitiva).

---

### Status Lifecycle

| Status | Definido em | Transição de entrada | Transição de saída |
|--------|-------------|----------------------|---------------------|
| `draft` | Criação do registro (`POST /videos`, SI-03.4) | — (estado inicial) | → `processing` (job consumido pelo worker) OU registro removido (`DELETE /videos/:id`, abort) |
| `processing` | Worker consome o job (primeira tentativa, SI-03.6) | `draft` → `processing` | → `ready` (sucesso) OU → `error` (falha após esgotar retries) |
| `ready` | Worker finaliza com sucesso (SI-03.7) | `processing` → `ready` | _(estado terminal nesta fase; edição/publicação é Fase 04)_ |
| `error` | Worker esgota retries (SI-03.7, `phase-03-videos/TD-09`) | `processing` → `error` | _(estado terminal nesta fase; sem endpoint de retry manual)_ |

Coluna única `status` (enum nativo PostgreSQL), sem histórico de auditoria — transições validadas na camada de serviço (`phase-03-videos/TD-08`).

---

### Streaming/Range behavior

_(revisado em 2026-07-05 — override de `phase-03-videos/TD-06`, ver addendum "Override" no TD; o texto original desta seção descrevia a Option A original, hoje válida apenas para o download, SI-03.9)._

`GET /videos/:id/play` atua como proxy de streaming: o cliente (player/browser) envia a requisição `Range` diretamente ao NestJS, que repassa o valor recebido ao `GetObjectCommand` do storage (leitura parcial do objeto, sem baixar o arquivo inteiro) e monta a resposta HTTP a partir do que o S3/MinIO retornar.

- Sem header `Range`: `200`, corpo completo, `Content-Length` = tamanho total, `Accept-Ranges: bytes`.
- Com header `Range` (`bytes=start-end`): `206 Partial Content`, `Content-Range` refletindo o intervalo efetivamente servido pelo storage, `Content-Length` = tamanho da porção parcial.
- Resposta montada manualmente (`@Res()` + `node:stream/promises.pipeline`), não via `StreamableFile` — evita o bug conhecido `nestjs/nest#14873` (Range + `StreamableFile` no iOS).
- Download (`GET /videos/:id/download`, SI-03.9) **não** é afetado por este override — continua usando a URL pré-assinada direta ao storage (Option A original), mesma chave/endpoint, diferindo apenas pelo parâmetro `ResponseContentDisposition: attachment` (`phase-03-videos/TD-03`).
- Pré-condição: vídeo com `status: 'ready'` — caso contrário, 409 `VIDEO_NOT_READY`.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (no deps)
SI-03.2 (no deps)

SI-03.1
└── SI-03.3

SI-03.2 + SI-03.3
└── SI-03.4

SI-03.1 + SI-03.4
└── SI-03.5
    └── SI-03.6
        └── SI-03.7

SI-03.3 + SI-03.7
├── SI-03.8
└── SI-03.9

SI-03.8 + SI-03.9
└── SI-03.10
```

Linearized implementation order: SI-03.1, SI-03.2 (paralelo) → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8, SI-03.9 (paralelo) → SI-03.10

---

## Deliverables

- [ ] SI-03.1 — Infraestrutura Docker: MinIO, Redis e worker
- [ ] SI-03.2 — Data model: entidade Video, migration, repository e relação com Channel
- [ ] SI-03.3 — Storage service e URL pré-assinada de upload
- [ ] SI-03.4 — API de pré-cadastro do vídeo como draft
- [ ] SI-03.5 — Confirmação de upload e publicação de job na fila
- [ ] SI-03.6 — Worker de processamento com FFmpeg/ffprobe
- [ ] SI-03.7 — Thumbnail, metadados e transição para ready/error
- [ ] SI-03.8 — Endpoint de streaming com Range/206
- [ ] SI-03.9 — Endpoint de download
- [ ] SI-03.10 — Testes, documentação e fechamento

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
