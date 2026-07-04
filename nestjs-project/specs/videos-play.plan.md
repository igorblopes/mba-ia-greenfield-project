---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos.e2e-spec.ts
---

# Endpoint de streaming com Range/206 — Test Plan

## Application Overview

`GET /videos/:id/play` é público (`@Public()`) e devolve uma URL `GET` pré-assinada apontando direto para o objeto original no storage — o NestJS nunca faz streaming nem faz parsing de `Range`/`Content-Range`; esse comportamento é resolvido inteiramente pelo protocolo `GetObject` do MinIO/S3. A rota só é servida para vídeos com `status: 'ready'`; caso contrário, retorna `409`. Os cenários de vídeo `'ready'` são preparados inserindo o registro `Video` diretamente no Postgres (sem rodar o worker completo — o pipeline fim-a-fim já é coberto por `test/videos-pipeline.e2e-spec.ts`, SI-03.10) e enviando um objeto real para a chave correspondente no MinIO, para que a URL pré-assinada resultante seja de fato utilizável.

## Test Scenarios

### 1. GET /videos/:id/play — URL de streaming

**Setup:** `beforeEach` truncate test DB (`cleanAllTables(dataSource)`); bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com pipes/filters globais reproduzidos manualmente; MinIO real via `docker compose`. Fixture: inserir um `Video` com `status: 'ready'` diretamente via repository e fazer upload de um objeto pequeno de teste (poucos KB, `mp4`) para a chave `videos/{id}/original.mp4` no MinIO.

#### 1.1. play-video-ready-retorna-url-assinada

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima (sem header `Authorization`) a `GET /videos/:id/play`, onde `:id` é um vídeo com `status: 'ready'`
    - expect: resposta `200`
    - expect: corpo contém `url` (string não vazia) e `expires_in` (number, ~21600)

#### 1.2. play-url-aceita-range-e-responde-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play` para um vídeo `ready`, capturando a `url` retornada
    - expect: resposta `200`
  2. Requisição HTTP direta (fora do NestJS, contra a `url` retornada) com header `Range: bytes=0-1`
    - expect: resposta `206 Partial Content`
    - expect: header `Content-Range` presente na resposta, refletindo o intervalo de bytes servido

#### 1.3. play-video-nao-ready-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play`, onde `:id` é um vídeo com `status: 'draft'` (ou `'processing'`/`'error'`)
    - expect: resposta `409`
    - expect: `res.body.error === 'VIDEO_NOT_READY'`

#### 1.4. play-video-inexistente-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play` com um `id` de vídeo aleatório (uuid válido, mas inexistente)
    - expect: resposta `404`
    - expect: `res.body.error === 'VIDEO_NOT_FOUND'`
