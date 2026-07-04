# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/10 completed

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
- **Status:** pending
- **Objetivo:** Criar a entity `Video`, o módulo de vídeos e a migration correspondente, estabelecendo o schema base sobre o qual toda a fase é construída.
- **Testes planejados:**
  - `Video` — Integration: PK uuid, `status` enum + default `'draft'`, FK `channel_id`, colunas nullable (`src/videos/entities/video.entity.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.3 — Storage service e URL pré-assinada de upload
- **Status:** pending
- **Objetivo:** Implementar o `StorageService` sobre o AWS SDK v3 configurado para o MinIO, cobrindo o ciclo completo do multipart upload e a geração de URLs pré-assinadas de leitura — base reutilizada por todos os endpoints HTTP da fase.
- **Testes planejados:**
  - `StorageService` — Integration vs MinIO real: `createMultipartUpload`/`presignUploadPart`/`completeMultipartUpload`/`abortMultipartUpload` round-trip com bytes reais (`src/videos/storage.service.integration-spec.ts`)
  - `StorageService.presignGetObject` — Integration vs MinIO real: URL inline vs. `ResponseContentDisposition: attachment` (`src/videos/storage.service.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

### SI-03.4 — API de pré-cadastro do vídeo como draft
- **Status:** pending
- **Objetivo:** Expor o pré-cadastro do vídeo como rascunho (cria o registro `draft` e inicia o multipart upload) e a obtenção sob demanda da URL pré-assinada de cada parte.
- **Testes planejados:**
  - `VideosService.createDraft` — Unit: branch `FILE_TOO_LARGE`, criação do draft, storage mockado (`src/videos/videos.service.spec.ts`)
  - `VideosService.createDraft` — Integration: persiste o registro `Video` com `status: 'draft'` (DB real) (`src/videos/videos.service.integration-spec.ts`)
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

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
