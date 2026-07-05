---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos.e2e-spec.ts
---

# Endpoint de streaming com Range/206 — Test Plan

## Application Overview

_(revisado em 2026-07-05 — override de `phase-03-videos/TD-06`; a versão original deste spec assumia a Option A, presigned URL. Ver addendum "Override" no TD e a seção "Streaming/Range behavior" do plano.)_

`GET /videos/:id/play` é público (`@Public()`) e atua como proxy de streaming: o NestJS repassa o header `Range` recebido ao `GetObjectCommand` do storage (leitura parcial, sem download completo) e monta a resposta HTTP diretamente — `200` com corpo completo quando não há `Range`, `206 Partial Content` com `Content-Range` quando há. A rota só é servida para vídeos com `status: 'ready'`; caso contrário, retorna `409`. Os cenários de vídeo `'ready'` são preparados inserindo o registro `Video` diretamente no Postgres (sem rodar o worker completo — o pipeline fim-a-fim já é coberto por `test/videos-pipeline.e2e-spec.ts`, SI-03.10) e enviando um objeto real para a chave correspondente no MinIO, para que o streaming resultante seja de fato servido a partir de bytes reais.

## Test Scenarios

### 1. GET /videos/:id/play — streaming com Range/206

**Setup:** `beforeEach` truncate test DB (`cleanAllTables(dataSource)`); bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com pipes/filters globais reproduzidos manualmente; MinIO real via `docker compose`. Fixture: inserir um `Video` com `status: 'ready'` diretamente via repository e fazer upload de um objeto pequeno de teste (poucas dezenas de bytes, `mp4`) para a chave `videos/{id}/original.mp4` no MinIO.

#### 1.1. play-video-ready-sem-range-retorna-200-completo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-05T00:00:00Z

**Steps:**
  1. Chamada anônima (sem header `Authorization`) a `GET /videos/:id/play`, onde `:id` é um vídeo com `status: 'ready'`, sem header `Range`
    - expect: resposta `200`
    - expect: header `Content-Length` igual ao tamanho total do objeto de teste
    - expect: header `Accept-Ranges` igual a `bytes`
    - expect: corpo da resposta igual aos bytes completos do objeto de teste

#### 1.2. play-com-range-responde-206-com-leitura-parcial

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-05T00:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play` para um vídeo `ready`, com header `Range: bytes=0-9`
    - expect: resposta `206 Partial Content`
    - expect: header `Content-Range` presente, refletindo o intervalo `0-9` sobre o tamanho total do objeto
    - expect: header `Content-Length` igual a `10`
    - expect: corpo da resposta igual aos primeiros 10 bytes do objeto de teste

#### 1.3. play-video-nao-ready-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-05T00:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play`, onde `:id` é um vídeo com `status: 'draft'` (ou `'processing'`/`'error'`)
    - expect: resposta `409`
    - expect: `res.body.error === 'VIDEO_NOT_READY'`

#### 1.4. play-video-inexistente-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-05T00:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/play` com um `id` de vídeo aleatório (uuid válido, mas inexistente)
    - expect: resposta `404`
    - expect: `res.body.error === 'VIDEO_NOT_FOUND'`
