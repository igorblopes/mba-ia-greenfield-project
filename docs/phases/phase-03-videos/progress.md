# phase-03-videos — Progress

**Status:** pending
**SIs:** 0/10 completed

### SI-03.1 — Infraestrutura Docker: MinIO, Redis e worker
- **Status:** pending
- **Objetivo:** Provisionar a infraestrutura Docker nova da fase (fila e storage) e o container do `video-worker`, além dos namespaces de configuração correspondentes — base para todos os SIs seguintes.
- **Testes planejados:** _(vazio — Infra; validado por AC via `docker compose ps`/smoke checks, sem novo arquivo de teste)_
- **Resultado dos testes:** _(a preencher)_
- **Notas de implementação:** _(a preencher)_

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
