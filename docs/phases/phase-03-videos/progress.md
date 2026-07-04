# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/10 completed

### SI-03.1 — Infraestrutura Docker: MinIO, Redis e worker
- **Status:** completed
- **Objetivo:** Provisionar a infraestrutura Docker nova da fase (fila e storage) e o container do `video-worker`, além dos namespaces de configuração correspondentes — base para todos os SIs seguintes.
- **Testes planejados:** _(vazio — Infra; validado por AC via `docker compose ps`/smoke checks, sem novo arquivo de teste)_
- **Resultado dos testes:**
  - `docker compose up -d`: `redis`, `minio`, `video-worker` sobem sem erro, status `running`/`healthy` em `docker compose ps`.
  - `ffmpeg -version` / `ffprobe -version` executam com sucesso em `nestjs-api` e `video-worker` (mesma imagem, `Dockerfile.dev`).
  - MinIO acessível internamente em `http://minio:9000` (HTTP 200 a partir de `nestjs-api`); bucket `streamtube` criado automaticamente no boot pelo container `createbuckets` (`mc mb --ignore-existing`).
  - Redis acessível internamente (`redis-cli ping` → `PONG`), persistência AOF confirmada (`CONFIG GET appendonly` → `yes`).
  - Validação Joi confirmada diretamente no schema: payload sem `STORAGE_BUCKET`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` retorna erro `"... is required"` para os três; payload completo passa sem erro e aplica defaults (`REDIS_HOST=redis`, `REDIS_PORT=6379`).
  - Regressão: `docker compose exec nestjs-api npm test -- config --runInBand` → 2 suites, 7/7 passing (`env.validation.integration-spec.ts`, `swagger.config.spec.ts`).
  - `npx tsc --noEmit` → exit 0. `npm run lint` nos arquivos desta SI → 0 problemas (os 190 problemas reportados pelo lint completo do projeto são pré-existentes, em arquivos fora do escopo desta SI — ver observações).
- **Notas de implementação:**
  - `redis:8-alpine` e `minio/minio:RELEASE.2025-09-07T16-13-09Z` (tag fixada mais recente disponível; o repositório `minio/minio` foi arquivado pelo mantenedor em 2026-04-25, então esta é a última release existente) escolhidos via busca das tags reais no Docker Hub.
  - Criação do bucket no boot implementada via serviço `createbuckets` (imagem `minio/mc:RELEASE.2025-08-13T08-35-41Z`, one-shot, `depends_on: minio (healthy)`) rodando `mc alias set` + `mc mb --ignore-existing` — abordagem de infra (compose), distinta da rotina defensiva `HeadBucket`/`CreateBucket` que a SI-03.3 adiciona no `StorageService`.
  - `video-worker` não recebeu `command:` próprio nesta SI — herda o `CMD ["tail","-f","/dev/null"]` do `Dockerfile.dev` (mesmo padrão do `nestjs-api`), já que `src/worker.ts` só é criado na SI-03.6, que troca o `command` para o bootstrap compilado.
  - `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` e o nome do bucket no `createbuckets` são alimentados via interpolação `${STORAGE_ACCESS_KEY_ID}`/`${STORAGE_SECRET_ACCESS_KEY}`/`${STORAGE_BUCKET}` do `.env`, evitando duplicar credenciais entre o serviço MinIO e a config da aplicação.
  - `storage.config.ts`: `bucket`/`accessKeyId`/`secretAccessKey` sem default (obrigatórios via Joi, mesmo padrão de `DB_USERNAME`/`DB_PASSWORD`/`DB_NAME`); `endpoint`/`region` com default (mesmo padrão de `DB_HOST`/`DB_PORT`); `forcePathStyle: true` fixo no código (não vem de env, requisito do MinIO).
  - **Fora do escopo, corrigido para destravar a verificação desta SI:** `.env.example` tinha `MAIL_FROM="StreamTube" <noreply@streamtube.com>` (Fase 02) sem aspas em volta do valor inteiro, violando a própria convenção documentada em `nestjs-project/CLAUDE.md` ("Environment File Conventions") e quebrando o parsing de `.env` pelo `docker compose config`/`up` (erro `unexpected character "<" in variable name`). Corrigido para `MAIL_FROM="StreamTube <noreply@streamtube.com>"` — bug pré-existente da Fase 02, não relacionado ao escopo de vídeos.
  - **Regressão corrigida:** `env.validation.integration-spec.ts` tinha um fixture `requiredEnv` que não incluía os novos campos obrigatórios de storage; os 3 testes de `SWAGGER_ENABLED` quebraram. Corrigido adicionando `STORAGE_BUCKET`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` ao fixture (arquivo existente, não é "novo arquivo de teste").
  - Ambiente local não tinha `.env` (apenas `.env.example`, `.env` é gitignored) nem Docker Desktop em execução — ambos endereçados para permitir a verificação (copiado `.env.example` → `.env`; Docker Desktop iniciado). `node_modules` do container `nestjs-api` estava com arquivos corrompidos (`@babel/generator`, `@types/node`) de uma sessão anterior — reinstalado (`rm -rf node_modules && npm install`) para permitir `tsc --noEmit` limpo; não relacionado ao código desta SI.

### SI-03.2 — Data model: entidade Video, migration, repository e relação com Channel
- **Status:** completed
- **Objetivo:** Criar a entity `Video`, o módulo de vídeos e a migration correspondente, estabelecendo o schema base sobre o qual toda a fase é construída.
- **Testes planejados:**
  - `Video` — Integration: PK uuid, `status` enum + default `'draft'`, FK `channel_id`, colunas nullable (`src/videos/entities/video.entity.integration-spec.ts`)
- **Resultado dos testes:**
  - `docker compose exec nestjs-api npm test -- src/videos/entities/video.entity.integration-spec.ts --runInBand` → 6/6 passing (uuid PK, default `'draft'`, enum rejeita valor inválido, FK `channel_id` rejeitada quando inexistente, colunas nullable ficam `null`, relação `ManyToOne` carrega o `Channel`).
  - `npm run migration:run` → cria `videos` + tipo `videos_status_enum` (verificado via SQL gerado pelo TypeORM CLI, revisado antes de aplicar).
  - `npm run migration:revert` → desfaz a migration sem tabelas/tipos órfãos (`DROP TABLE "videos"` + `DROP TYPE "videos_status_enum"`, sem afetar `channels`/`users`/tokens); migration reaplicada em seguida para deixar o ambiente no estado esperado.
  - `npx tsc --noEmit` → exit 0. `npx eslint` nos arquivos desta SI → exit 0.
- **Notas de implementação:**
  - Relação `Video → Channel` implementada unidirecional (`@ManyToOne` + `@JoinColumn({ name: 'channel_id' })`, com coluna escalar `channel_id` explícita), mesmo padrão de `RefreshToken`/`VerificationToken` → `User` (child record sem lado inverso na entidade pai). `Channel` não foi modificado — mantém Single Responsibility do módulo de canais; o plano também não pede lado inverso.
  - `size` tipado como `string` (não `number`): colunas `bigint` do PostgreSQL são mapeadas pelo TypeORM como `string` no TypeScript, já que não cabem com segurança no range de `number` do JS (confirmado via doc oficial do TypeORM antes de implementar).
  - Enum `VideoStatus` exportado do próprio `video.entity.ts` (mesmo padrão de `VerificationTokenType` em `verification-token.entity.ts`), não em arquivo separado.
  - `VideosModule` criado apenas com `TypeOrmModule.forFeature([Video])`, sem `providers`/`exports` — não há `VideosService` nesta SI (fica para SI-03.4+); registrado em `AppModule` na posição após `AuthModule`.
  - **Migration gerada em duas tentativas:** a primeira execução de `migration:generate` rodou contra um volume Docker novo (containers recriados nesta sessão), sem nenhuma migration prévia aplicada — o diff resultante recriava `channels`/`users`/`verification_tokens`/`refresh_tokens` do zero junto com `videos`. Descartada; rodado `migration:run` primeiro (aplicando as 2 migrations existentes da Fase 02) e então regenerada — resultado limpo, só `CREATE TYPE videos_status_enum` + `CREATE TABLE videos` + FK.
  - **Decisão de escopo — helper de teste compartilhado:** `cleanAllTables` (`src/test/create-test-data-source.ts`) é reutilizado por 11 outros arquivos de teste (`auth`, `channels`, `users`) cujo `ALL_ENTITIES` não inclui `Video`; adicionar `DELETE FROM "videos"` diretamente nesse helper quebraria esses testes quando executados isoladamente ou antes do primeiro teste de vídeo (tabela ainda não sincronizada). Optou-se por um `DELETE FROM "videos"` local no `beforeEach` do próprio `video.entity.integration-spec.ts`, antes de chamar `cleanAllTables` — evita tocar em arquivos fora do escopo desta SI.
  - Ambiente Docker (containers `db`/`redis`/`minio`/`nestjs-api`/`video-worker`/`mailpit`/`createbuckets`) precisou ser subido nesta sessão (`docker compose up -d`) — não estava rodando previamente.

### SI-03.3 — Storage service e URL pré-assinada de upload
- **Status:** completed
- **Objetivo:** Implementar o `StorageService` sobre o AWS SDK v3 configurado para o MinIO, cobrindo o ciclo completo do multipart upload e a geração de URLs pré-assinadas de leitura — base reutilizada por todos os endpoints HTTP da fase.
- **Testes planejados:**
  - `StorageService` — Integration vs MinIO real: `createMultipartUpload`/`presignUploadPart`/`completeMultipartUpload`/`abortMultipartUpload` round-trip com bytes reais (`src/videos/storage.service.integration-spec.ts`)
  - `StorageService.presignGetObject` — Integration vs MinIO real: URL inline vs. `ResponseContentDisposition: attachment` (`src/videos/storage.service.integration-spec.ts`)
- **Resultado dos testes:**
  - `docker compose exec nestjs-api npm test -- --runInBand src/videos/storage.service.integration-spec.ts` → 5/5 passing: round-trip completo de multipart upload com bytes reais e verificação do conteúdo baixado; abort remove partes órfãs (`completeMultipartUpload` subsequente rejeita com upload já abortado); `presignGetObject` sem `ResponseContentDisposition` retorna objeto inline (sem header `content-disposition`); com `responseContentDisposition: 'attachment; filename="video.mp4"'` retorna `content-disposition: attachment`; bucket auto-criado no boot quando ainda não existe (testado com um bucket novo e aleatório, não o bucket padrão já criado pelo `createbuckets`).
  - `npx tsc --noEmit` → exit 0. `npx eslint` nos arquivos desta SI → exit 0 (após `--fix` para formatação Prettier).
- **Notas de implementação:**
  - `StorageService` (`src/videos/storage.service.ts`) instanciado com `S3Client` configurado via namespace `storage` (`endpoint`/`region`/`forcePathStyle`/credenciais do `storage.config.ts` criado na SI-03.1); métodos `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload` e `presignGetObject` (com `ResponseContentDisposition` opcional) recebem `key` já pronta — a montagem da chave `videos/{videoId}/original.<ext>` fica para a SI-03.4, que é quem conhece o `videoId`.
  - `onModuleInit` (lifecycle hook assíncrono, `perf-async-hooks`) roda `ensureBucketExists` (via `HeadBucketCommand`; cria via `CreateBucketCommand` quando `$metadata.httpStatusCode === 404`) e depois `configureLifecyclePolicy`.
  - TTLs e o prazo de expurgo de partes órfãs centralizados em `src/videos/storage.constants.ts` (`PRESIGNED_PUT_EXPIRES_IN_SECONDS = 3600`, `PRESIGNED_GET_EXPIRES_IN_SECONDS = 21600` conforme TD-06, `MULTIPART_UPLOAD_ABORT_DAYS = 7`) — nenhum desses valores é fixado explicitamente pelas TDs além do TTL de 6h do GET, então os demais foram escolhidos como default razoável.
  - **Achado de compatibilidade MinIO, verificado empiricamente (não documentado nas TDs):** o MinIO (`minio/minio:RELEASE.2025-09-07T16-13-09Z`, mesma imagem da SI-03.1) rejeita com `InvalidArgument: The XML you provided was not well-formed or did not validate against our published schema` qualquer regra de lifecycle cujo único action seja `AbortIncompleteMultipartUpload` — confirmado isolando a variável (testado com `Filter` vazio, com `Filter.Prefix` não-vazio, e sem `Filter` algum; todos falham; a mesma regra combinada com um action `Expiration` é aceita). Real S3 aceita `AbortIncompleteMultipartUpload` isolado normalmente — é uma divergência específica desta versão do MinIO, não um bug do código. `configureLifecyclePolicy` agora tenta a chamada padrão S3 (mesmo formato que funcionaria contra AWS real) e, especificamente quando `error.name === 'InvalidArgument'`, loga um `Logger.warn` e segue o boot sem falhar — o MinIO já expira uploads multipart incompletos por conta própria via config `api.stale_uploads_expiry` (default 24h), então a proteção contra partes órfãs citada em TD-02 continua válida mesmo com a policy explícita do bucket falhando nesta versão. Qualquer outro tipo de erro em `configureLifecyclePolicy` ainda propaga normalmente.
  - **Gap destravado desta SI, não modificado pela SI-03.1:** `storage.config.ts` (criado na SI-03.1) tinha `bucket`/`accessKeyId`/`secretAccessKey` sem non-null assertion (`process.env.STORAGE_BUCKET` etc., tipados como `string | undefined`), inconsistente com o padrão já usado em `auth.config.ts` (`process.env.JWT_SECRET!`) para os mesmos casos de env var obrigatória via Joi. Adicionado `!` aos três campos para alinhar ao padrão existente — sem essa mudança `npx tsc --noEmit` falha ao consumir o config tipado no `StorageService`. Também fora do escopo original da SI-03.1: `storageConfig` nunca tinha sido adicionado ao array `load` do `ConfigModule.forRoot` em `app.module.ts` (só `queueConfig` e `storageConfig` foram criados como arquivos, nenhum registrado) — adicionado `storageConfig` ao `load` (necessário para o `@Inject(storageConfig.KEY)` resolver); `queueConfig` continua não registrado, pois seu consumo (BullMQ) é escopo da SI-03.5.
  - Testes de integração instanciam `StorageService` diretamente via `new StorageService(config)` (mesmo padrão de `ChannelsService` em `channels.service.integration-spec.ts`), sem `Test.createTestingModule`, e chamam `onModuleInit()` explicitamente — evita ambiguidade sobre se `TestingModule.compile()` dispara lifecycle hooks automaticamente.

### SI-03.4 — API de pré-cadastro do vídeo como draft
- **Status:** completed
- **Objetivo:** Expor o pré-cadastro do vídeo como rascunho (cria o registro `draft` e inicia o multipart upload) e a obtenção sob demanda da URL pré-assinada de cada parte.
- **Testes planejados:**
  - `VideosService.createDraft` — Unit: branch `FILE_TOO_LARGE`, criação do draft, storage mockado (`src/videos/videos.service.spec.ts`)
  - `VideosService.createDraft` — Integration: persiste o registro `Video` com `status: 'draft'` (DB real) (`src/videos/videos.service.integration-spec.ts`)
  - Pipeline completo do endpoint (draft + upload-parts) — E2E via Test Spec `nestjs-project/specs/videos-draft.plan.md` (`test/videos.e2e-spec.ts`)
- **Resultado dos testes:**
  - `docker compose exec nestjs-api npm test -- --runInBand src/videos/videos.service.spec.ts src/videos/videos.service.integration-spec.ts src/channels/channels.service.integration-spec.ts` → 8/8 passing.
  - `docker compose exec nestjs-api npm run test:e2e -- --runInBand test/videos.e2e-spec.ts` → 6/6 passing (draft criado com sucesso; rejeita `size` acima de 10GB com 413 `FILE_TOO_LARGE`; requer autenticação; URL de parte para o dono; 403 `VIDEO_NOT_OWNED` para não-dono; 404 `VIDEO_NOT_FOUND` para vídeo inexistente).
  - Regressão: suíte completa de e2e (`npm run test:e2e -- --runInBand`) → 4 suites, 58/58 passing (`app`, `auth`, `swagger`, `videos`); batch de 7 outros arquivos `*.integration-spec.ts` que consomem `cleanAllTables` → 63/63 passing.
  - `npx tsc --noEmit` → exit 0. `npx eslint` nos arquivos desta SI → limpo, exceto 5 erros `@typescript-eslint/unbound-method` em `videos.service.spec.ts` (ver observações — débito sistêmico pré-existente, não introduzido por esta SI).
- **Notas de implementação:**
  - Rota `GET /videos/:id/upload-parts/:partNumber` (retorno da URL pré-assinada por parte) foi implementada nesta SI junto com `POST /videos`, conforme o plano (`API Contracts` já cita esta rota como "SI-03.3, SI-03.4"); `complete-upload` (SI-03.5) não foi tocado.
  - `ChannelsService.findByUserId(userId)` (novo método, `src/channels/channels.service.ts`) resolve o canal do usuário autenticado via `findOneByOrFail` — ausência é tratada como estado genuinamente excepcional (todo usuário autenticado tem exatamente 1 canal desde o registro na Fase 02), não um domain exception novo. Adicionado por necessidade desta SI (controller precisa resolver `channel_id` a partir do JWT) — não fazia parte do escopo original de Channels; testes de integração cobrindo o método (sucesso + ausência) adicionados a `channels.service.integration-spec.ts`.
  - Chave de storage `videos/{videoId}/original.<ext>` construída em `VideosService` via `node:path.extname`, com fallback `'bin'` quando o `original_filename` não tem extensão.
  - `size` validado (`≤ 10737418240`) inteiramente no `VideosService` (413 `FILE_TOO_LARGE`), não no DTO — o Error Catalog do plano distingue explicitamente esse caso de um erro de validação 400, então o DTO só valida `@IsInt() @IsPositive()`.
  - **Bug destravado por esta SI, não introduzido por ela:** `cleanAllTables` (`src/test/create-test-data-source.ts`) apagava `channels` antes de `videos`; como `videos.channel_id` tem FK para `channels`, qualquer linha de vídeo remanescente de uma suíte anterior quebrava o `beforeEach` de **qualquer** outro arquivo que dependa do helper (reproduzido concretamente: rodar `videos.service.integration-spec.ts` e depois `channels.service.integration-spec.ts` em invocações separadas derrubava as 5 suítes de channels com `QueryFailedError` de FK). Corrigido adicionando `DELETE FROM "videos"` como primeira linha do helper compartilhado — diferente da SI-03.2 (que evitou tocar o helper porque a tabela ainda não existia de forma estável), aqui a tabela já é estável via migration, então a correção central é segura e elimina a necessidade do `DELETE FROM "videos"` local por arquivo.
  - **Bug destravado por esta SI, não introduzido por ela:** `test/auth.e2e-spec.ts`, `test/app.e2e-spec.ts` e `test/swagger.e2e-spec.ts` (todos preexistentes) sofrem do mesmo timeout: o boot do `AppModule` completo (Postgres + MinIO reais, incluindo `StorageService.onModuleInit`) passou a exceder os 5000ms default do Jest em algum ponto após a SI-03.1/03.3 adicionarem essas conexões reais ao bootstrap, e nenhum desses arquivos declarava `jest.setTimeout(...)`. Descoberto ao rodar a suíte e2e completa como checagem de regressão desta SI. Corrigido adicionando `jest.setTimeout(30000)` no topo dos 3 arquivos (mesmo padrão aplicado em `test/videos.e2e-spec.ts`, que já nasceu com o timeout correto).
  - **Observação (não corrigida, fora do escopo):** `@typescript-eslint/unbound-method` dispara em qualquer `expect(mockedService.method).toHaveBeenCalledWith(...)` neste projeto (sem `eslint-plugin-jest` configurado para reconhecer mocks do Jest como seguros) — confirmado sistêmico: `src/auth/auth.service.spec.ts` sozinho tem 19 ocorrências do mesmo padrão, usando o idiom já estabelecido pelo próprio testing-guide do projeto. Os 5 erros em `videos.service.spec.ts` seguem essa mesma convenção pré-existente; corrigi-los exigiria uma mudança de config do ESLint em nível de projeto (fora do escopo de uma única SI).

### SI-03.5 — Confirmação de upload e publicação de job na fila
- **Status:** pending
- **Objetivo:** Concluir o multipart upload (ou o aborta) e, no caminho de sucesso, publicar o job de processamento na fila `video-processing` — ponte entre o upload e o worker.
- **Testes planejados:**
  - `VideosService.completeUpload` / `abortUpload` — Unit: branches de posse/status, storage e fila mockados (`src/videos/videos.service.spec.ts`)
  - `VideosService.completeUpload` — Integration vs Redis real: job `process-video` publicado com payload correto (`src/videos/videos.service.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.6 — Worker de processamento com FFmpeg/ffprobe
- **Status:** pending
- **Objetivo:** Estabelecer o segundo bootstrap da aplicação (`video-worker`) e o consumidor da fila que extrai metadados do vídeo original via `ffprobe`.
- **Testes planejados:**
  - `ffprobe.util` — Unit: parse de uma saída JSON de exemplo do `ffprobe` (`src/worker/ffprobe.util.spec.ts`)
  - `VideoProcessor` — Integration vs Redis + `ffprobe` reais + fixture de vídeo: extrai `duration`/`size`/`width`/`height` corretos, `status` vira `'processing'` (`src/worker/video.processor.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.7 — Thumbnail, metadados e transição para ready/error
- **Status:** pending
- **Objetivo:** Completar o pipeline do worker — geração de thumbnail via `ffmpeg`, persistência final dos metadados e a transição de status para `'ready'` ou `'error'` conforme o resultado do processamento.
- **Testes planejados:**
  - `ffmpeg-thumbnail.util` — Unit: cálculo do offset + clamp para vídeos curtos (`src/worker/ffmpeg-thumbnail.util.spec.ts`)
  - `VideoProcessor` — Integration vs `ffmpeg`/MinIO/Redis reais + fixture: caminho feliz termina em `status: 'ready'` com thumbnail no storage e metadados persistidos (`src/worker/video.processor.integration-spec.ts`)
  - `VideoProcessor` — Integration: fixture corrompida esgota os retries e termina em `status: 'error'` com `error_message` populado (`src/worker/video.processor.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.8 — Endpoint de streaming com Range/206
- **Status:** pending
- **Objetivo:** Expor a URL pré-assinada de reprodução — o streaming com `Range`/`206` é resolvido inteiramente pelo protocolo `GetObject` do storage, sem parsing de `Range` no NestJS.
- **Testes planejados:**
  - `VideosService.getPlaybackUrl` — Unit: branch `VIDEO_NOT_READY`, geração de URL, storage mockado (`src/videos/videos.service.spec.ts`)
  - `StorageService.presignGetObject` (inline) — Integration vs MinIO real: URL retornada aceita requisição `Range` e responde `206 Partial Content` (`src/videos/storage.service.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.9 — Endpoint de download
- **Status:** pending
- **Objetivo:** Expor a URL pré-assinada de download — mesma chave e endpoint do streaming, forçando `ResponseContentDisposition: attachment`.
- **Testes planejados:**
  - `VideosService.getDownloadUrl` — Unit: branch `VIDEO_NOT_READY`, parâmetro `ResponseContentDisposition` (`src/videos/videos.service.spec.ts`)
  - `StorageService.presignGetObject` (attachment) — Integration vs MinIO real: URL retornada serve o objeto com `Content-Disposition: attachment` (`src/videos/storage.service.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.10 — Testes, documentação e fechamento
- **Status:** pending
- **Objetivo:** Fechar a fase com a suíte E2E do pipeline completo, fixtures de teste e a verificação da Definition of Done.
- **Testes planejados:**
  - Pipeline completo (upload → processamento → ready) — E2E: draft, complete, processamento real (fila + `ffmpeg`/`ffprobe` + MinIO), status `'ready'`, URLs de play/download funcionais (`test/videos-pipeline.e2e-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_
