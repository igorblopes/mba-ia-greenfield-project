---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos.e2e-spec.ts
---

# API de pré-cadastro do vídeo como draft — Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como rascunho: valida o tamanho declarado (máx. 10GB), cria o registro `Video` com `status: 'draft'` resolvendo o `channel_id` do usuário autenticado (via JWT), e inicia um S3 Multipart Upload real contra o MinIO, persistindo o `upload_id` retornado. `GET /videos/:id/upload-parts/:partNumber` devolve, sob demanda, a URL `PUT` pré-assinada de cada parte do multipart upload — protegida por posse (`video.channel_id` deve pertencer ao usuário autenticado). Ambos os endpoints rodam contra o MinIO real do `docker compose` (sem mocks de storage) e contra o Postgres real, seguindo o padrão já estabelecido em `auth.e2e-spec.ts`.

## Test Scenarios

### 1. POST /videos — criação do rascunho

**Setup:** `beforeEach` truncate test DB (`cleanAllTables(dataSource)`); bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com os pipes/filters globais reproduzidos manualmente (`ValidationPipe`, `DomainExceptionFilter`, `ValidationExceptionFilter`); MinIO real via `docker compose` (bucket já criado no boot da app). Usuário autenticado obtido via fluxo `register → confirm-email → login` (mesmo helper padrão de `auth.e2e-spec.ts`), com canal já existente (criado automaticamente no registro).

#### 1.1. draft-criado-com-sucesso

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Usuário autenticado envia `POST /videos` com `Authorization: Bearer <access_token>` e body válido (`original_filename`, `content_type`, `size` dentro do limite)
    - expect: resposta `201`
    - expect: corpo contém `id` (uuid), `upload_id` (string não vazia) e `status: 'draft'`
    - expect: o registro `Video` persistido no Postgres tem `channel_id` igual ao canal do usuário autenticado

#### 1.2. draft-rejeita-arquivo-acima-de-10gb

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Usuário autenticado envia `POST /videos` com `size: 10737418241` (10GB + 1 byte)
    - expect: resposta `413`
    - expect: `res.body.error === 'FILE_TOO_LARGE'`
    - expect: nenhum registro `Video` é criado no Postgres

#### 1.3. draft-requer-autenticacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada `POST /videos` com payload válido, sem header `Authorization`
    - expect: resposta `401`
    - expect: nenhum registro `Video` é criado no Postgres

### 2. GET /videos/:id/upload-parts/:partNumber — URL pré-assinada de parte

**Setup:** mesmo bootstrap do grupo 1. Dois usuários autenticados distintos (`ownerUser`, `otherUser`), cada um com seu próprio canal. `ownerUser` cria um draft via `POST /videos` para obter um `id` de vídeo real com `upload_id` válido no MinIO.

#### 2.1. upload-part-url-para-dono-do-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `ownerUser` chama `GET /videos/:id/upload-parts/1` com seu próprio `access_token`, onde `:id` é o vídeo criado por ele
    - expect: resposta `200`
    - expect: corpo contém uma URL (`url`) pré-assinada `PUT` válida para a parte 1 do multipart upload no MinIO

#### 2.2. upload-part-nao-owner-retorna-403

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `otherUser` chama `GET /videos/:id/upload-parts/1` usando seu próprio `access_token`, onde `:id` é o vídeo criado por `ownerUser`
    - expect: resposta `403`
    - expect: `res.body.error === 'VIDEO_NOT_OWNED'`

#### 2.3. upload-part-video-inexistente-retorna-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. `ownerUser` chama `GET /videos/:id/upload-parts/1` com um `id` de vídeo aleatório (uuid válido, mas inexistente)
    - expect: resposta `404`
    - expect: `res.body.error === 'VIDEO_NOT_FOUND'`
