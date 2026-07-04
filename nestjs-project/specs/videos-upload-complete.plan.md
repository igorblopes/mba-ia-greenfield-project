---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos.e2e-spec.ts
---

# Confirmação de upload e publicação de job na fila — Test Plan

## Application Overview

`POST /videos/:id/complete` conclui o S3 Multipart Upload (a partir das ETags das partes) e publica o job `process-video` na fila `video-processing` (BullMQ/Redis real), fazendo a ponte entre o upload do cliente e o `video-worker`. `DELETE /videos/:id` aborta o multipart upload no storage e remove o registro `Video`. Ambas as rotas exigem posse (`video.channel_id` do usuário autenticado) e um vídeo em `status: 'draft'` — fora desse estado, a operação é rejeitada. Os testes rodam contra Postgres, MinIO e Redis reais do `docker compose`, sem mocks de infraestrutura.

## Test Scenarios

### 1. POST /videos/:id/complete — confirmação do upload

**Setup:** `beforeEach` truncate test DB (`cleanAllTables(dataSource)`); bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com pipes/filters globais reproduzidos manualmente; MinIO e Redis reais via `docker compose`. Fila `video-processing` obtida do módulo de teste via `getQueueToken('video-processing')` para inspeção de jobs publicados. Usuário autenticado (`ownerUser`) cria um draft via `POST /videos` e faz upload real das partes declaradas nos parâmetros de `parts` antes de chamar `complete`.

#### 1.1. complete-upload-sucesso-publica-job

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `ownerUser` chama `POST /videos/:id/complete` com `Authorization: Bearer <access_token>` e `parts` válidas (`part_number`/`etag` das partes já enviadas ao MinIO)
    - expect: resposta `200`
    - expect: corpo contém `id` e `status: 'draft'` (a transição para `'processing'` só ocorre quando o worker consumir o job — fora do escopo desta rota)
    - expect: um job com nome `process-video` e payload `{ videoId: <id> }` está presente na fila `video-processing` (consultado via `Queue.getJobs`)

#### 1.2. complete-upload-video-ja-nao-draft-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `ownerUser` chama `POST /videos/:id/complete` com sucesso uma primeira vez sobre o mesmo vídeo
    - expect: resposta `200`
  2. `ownerUser` chama `POST /videos/:id/complete` novamente sobre o mesmo `id`
    - expect: resposta `409`
    - expect: `res.body.error === 'VIDEO_NOT_DRAFT'`

#### 1.3. complete-upload-nao-owner-retorna-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `otherUser` (canal diferente) chama `POST /videos/:id/complete` usando seu próprio `access_token`, onde `:id` é um vídeo `draft` criado por `ownerUser`
    - expect: resposta `403`
    - expect: `res.body.error === 'VIDEO_NOT_OWNED'`
    - expect: nenhum job `process-video` é publicado na fila para este `videoId`

### 2. DELETE /videos/:id — abort do upload

**Setup:** mesmo bootstrap do grupo 1. `ownerUser` e `otherUser` com canais distintos; `ownerUser` cria um draft via `POST /videos` (multipart upload iniciado no MinIO, sem completar).

#### 2.1. abort-upload-sucesso-remove-registro

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `ownerUser` chama `DELETE /videos/:id` com seu `access_token`, sobre um vídeo em `status: 'draft'`
    - expect: resposta `204`
    - expect: o registro `Video` não existe mais no Postgres (`repository.findOneBy({ id })` retorna `null`)
    - expect: o multipart upload correspondente é abortado no MinIO (partes órfãs removidas)

#### 2.2. abort-upload-nao-owner-retorna-403

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `otherUser` chama `DELETE /videos/:id` usando seu próprio `access_token`, onde `:id` é um vídeo `draft` criado por `ownerUser`
    - expect: resposta `403`
    - expect: `res.body.error === 'VIDEO_NOT_OWNED'`
    - expect: o registro `Video` de `ownerUser` continua existindo no Postgres
