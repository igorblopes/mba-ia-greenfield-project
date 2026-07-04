---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos.e2e-spec.ts
---

# Endpoint de download — Test Plan

## Application Overview

`GET /videos/:id/download` é público (`@Public()`) e devolve a mesma URL `GET` pré-assinada usada pelo streaming, na mesma chave de storage, diferindo apenas por forçar `ResponseContentDisposition: attachment` — o cliente recebe o arquivo como anexo em vez de reprodução inline. Assim como `play`, só é servido para vídeos com `status: 'ready'`. As fixtures de vídeo `'ready'` seguem o mesmo padrão de `videos-play.plan.md` (registro inserido diretamente no Postgres + objeto real no MinIO, sem rodar o worker completo).

## Test Scenarios

### 1. GET /videos/:id/download — URL de download

**Setup:** `beforeEach` truncate test DB (`cleanAllTables(dataSource)`); bootstrap `Test.createTestingModule({ imports: [AppModule] }).compile()` com pipes/filters globais reproduzidos manualmente; MinIO real via `docker compose`. Fixture: inserir um `Video` com `status: 'ready'` diretamente via repository e fazer upload de um objeto pequeno de teste para a chave `videos/{id}/original.mp4` no MinIO.

#### 1.1. download-video-ready-retorna-url-com-attachment

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima (sem header `Authorization`) a `GET /videos/:id/download`, onde `:id` é um vídeo com `status: 'ready'`
    - expect: resposta `200`
    - expect: corpo contém `url` (string não vazia) e `expires_in` (number)
    - expect: a query string da `url` contém o parâmetro de disposição de anexo (`response-content-disposition=attachment...`)

#### 1.2. download-video-nao-ready-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Chamada anônima a `GET /videos/:id/download`, onde `:id` é um vídeo com `status: 'draft'` (ou `'processing'`/`'error'`)
    - expect: resposta `409`
    - expect: `res.body.error === 'VIDEO_NOT_READY'`

#### 1.3. download-e-play-referenciam-mesma-chave-storage

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-04T15:00:00Z

**Steps:**
  1. Para o mesmo vídeo `ready`, chamar `GET /videos/:id/play` e `GET /videos/:id/download` anonimamente
    - expect: ambas retornam `200`
    - expect: o caminho do objeto (host + path, ignorando query string de assinatura/disposição) nas duas URLs retornadas é idêntico
    - expect: apenas a `url` de `download` contém o parâmetro `response-content-disposition=attachment`; a de `play` não contém esse parâmetro
