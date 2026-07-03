---
libs:
  bullmq:
    version: "^5.79.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-03T20:18:41-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-07-03T20:18:41-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-03T20:18:41-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1079.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-03T20:18:41-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T20:14:49-03:00"
---

# phase-03-videos — Library References

Cache de bibliotecas e tecnologias fixadas para a Fase 03 (Upload e Processamento de Vídeos). Fecha o gap **MD-1** de `validation.md`: fixa versões (via context7, obrigatório por `CLAUDE.md` §"Library Documentation Lookup") das dependências novas decididas em `phase-03-videos/TD-01` (fila) e `phase-03-videos/TD-03` (storage) e registra as tecnologias de infra (FFmpeg, MinIO, Redis) que a fase adiciona.

As versões `libs:` no frontmatter são a fonte precisa; o campo `**Libraries:**` de cada TD carrega a faixa legível. Cada seção abaixo registra: **versão/critério**, **finalidade**, **documentação consultada**, **decisão de uso**, **impacto na implementação** e **cuidados de configuração em Docker**.

> **Nota Docker (global, aplica-se a todas as libs desta fase):** por `CLAUDE.md` §"Docker Networking", todo host de conexão usa o **nome do serviço no Compose** — `redis`, `minio`, `db` — nunca `localhost`/`127.0.0.1`.

---

## Bibliotecas npm (context7)

### bullmq

- **Versão / critério:** `^5.79.2` — caret no major 5 (v5.79.2 é a versão corrente resolvida em 2026-07-03). Não presente hoje em `nestjs-project/package.json`; a instalar na implementação.
- **Finalidade no projeto:** motor da fila de processamento em background (`phase-03-videos/TD-01`). Expõe `Queue` (produtor, usado na API) e `Worker`/processor (consumidor, usado no `video-worker` — `TD-04`). Também fornece o retry/backoff nativo usado por `TD-09`.
- **Documentação consultada:** context7 `/taskforcesh/bullmq` — `guide/connections.md`, `guide/retrying-failing-jobs.md`, `guide/going-to-production.md`, `elixir/guides/job_options.md`.
- **Decisão de uso:** Option A de `TD-01`. Conexão via objeto simples `{ host, port }` (não requer instanciar ioredis manualmente). Retry de `TD-09` configurado como default da fila:
  ```ts
  new Queue('video-processing', {
    connection: { host: 'redis', port: 6379 },
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
  });
  ```
- **Impacto na implementação:** novo namespace de config `registerAs` para a fila (padrão `phase-01/TD-03`); `AppModule` registra o lado produtor; o `WorkerModule` do `video-worker` registra o `Worker`. Enfileiramento disparado ao completar o multipart upload (`TD-02`).
- **Cuidados de configuração em Docker:** `connection.host` deve ser `redis` (nome do serviço Compose), nunca `localhost`. O serviço `redis` precisa de `--appendonly yes` para não perder jobs em crash (risco levantado em `TD-01`). BullMQ abre múltiplas conexões Redis por instância (`Queue` + `Worker`) — dimensionar `maxclients` do Redis se necessário.

### @nestjs/bullmq

- **Versão / critério:** `^11.0.4` — alinhado ao ecossistema `@nestjs/core ^11.0.1` já instalado (módulo oficial NestJS, mesmo nível de `@nestjs/jwt`/`@nestjs/throttler` já no projeto).
- **Finalidade no projeto:** integração idiomática do BullMQ com a DI do NestJS (`TD-01`): `BullModule.forRoot`/`registerQueue`, `@InjectQueue()` no service produtor, `@Processor()` + `WorkerHost` no consumer do worker.
- **Documentação consultada:** context7 `/nestjs/docs.nestjs.com` — `content/techniques/queues.md` (registerQueue, WorkerHost/process, InjectQueue, add job).
- **Decisão de uso:** usar o pacote **`@nestjs/bullmq`** (variante BullMQ), **não** `@nestjs/bull` (variante Bull v3 legada). Padrão consumer é estender `WorkerHost` e implementar `async process(job)`:
  ```ts
  import { Processor, WorkerHost } from '@nestjs/bullmq';
  import { Job } from 'bullmq';

  @Processor('video-processing')
  export class VideoProcessor extends WorkerHost {
    async process(job: Job): Promise<unknown> { /* ffprobe + ffmpeg + storage */ }
  }
  ```
- **⚠️ Cuidado de compatibilidade (cross-reference obrigatório por `CLAUDE.md`):** a doc oficial de queues mistura snippets de **Bull** (`import { Queue } from 'bull'`, `@InjectQueue`/`@Processor` de `@nestjs/bull`) com snippets de **BullMQ**. Para esta fase, importe **tudo de `@nestjs/bullmq`** (`BullModule`, `@Processor`, `WorkerHost`, `@InjectQueue`) e os tipos `Queue`/`Job` de **`bullmq`** — não misturar com o pacote `bull`.
- **Impacto na implementação:** `AppModule` importa `BullModule.forRoot({ connection })` + `BullModule.registerQueue({ name })` (produtor); o bootstrap standalone do `video-worker` (`createApplicationContext`, `TD-04`) importa `registerQueue` + o `Processor`.
- **Cuidados de configuração em Docker:** `connection` no `forRoot` aponta para o host `redis`. O `video-worker` (`depends_on: [db, redis, minio]`) só deve registrar o `Worker` — sem listener HTTP.

### @aws-sdk/client-s3

- **Versão / critério:** `^3.1079.0` — caret no major 3 do AWS SDK v3 (modular). Versão corrente resolvida em 2026-07-03.
- **Finalidade no projeto:** cliente do protocolo S3 contra o MinIO (`TD-03`). Cobre o multipart upload (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`AbortMultipartUpload` — `TD-02`), `GetObject`/`PutObject` e organização de chaves por `videoId` (`videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`).
- **Documentação consultada:** context7 `/aws/aws-sdk-js-v3` — `supplemental-docs/CLIENTS.md` (custom endpoint, `bucketEndpoint`), `clients/client-s3/src/schemas/schemas_0.ts` (mapeamento de `ResponseContentDisposition`).
- **Decisão de uso:** cliente único configurado para MinIO:
  ```ts
  new S3Client({
    endpoint: 'http://minio:9000',
    forcePathStyle: true,           // OBRIGATÓRIO para MinIO
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  ```
  `forcePathStyle: true` é obrigatório (MinIO não usa virtual-hosted buckets). **Não** usar `bucketEndpoint: true` (trataria o endpoint como URL de bucket e ignoraria o parâmetro `Bucket`).
- **Impacto na implementação:** novo `storage service` no módulo de vídeos; novo namespace `registerAs` de storage (credenciais, bucket, region, endpoint, path-style) validado por Joi (padrão `phase-01`). Bucket criado no boot.
- **Cuidados de configuração em Docker:** `endpoint` = `http://minio:9000` (serviço Compose, nunca `localhost`). Credenciais via env (`.env` + `registerAs` + Joi). A assinatura SigV4 é sensível a clock skew — em dev, API e MinIO no mesmo host Docker mitigam; monitorar em produção. Bucket **privado por padrão**; acesso só via URL pré-assinada.

### @aws-sdk/s3-request-presigner

- **Versão / critério:** `^3.1079.0` — par de versão com `@aws-sdk/client-s3` (mesmo major do SDK v3; manter as duas alinhadas).
- **Finalidade no projeto:** gerar URLs pré-assinadas **PUT** por parte para o upload multipart (cliente envia bytes direto ao MinIO, `TD-02`) e **GET** para download e streaming (`TD-03`/`TD-06`).
- **Documentação consultada:** context7 `/aws/aws-sdk-js-v3` — `packages/s3-request-presigner/README.md` (`getSignedUrl(client, command, { expiresIn })`).
- **Decisão de uso:** `getSignedUrl` com o comando correspondente:
  ```ts
  import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
  // streaming/playback (inline): sem ResponseContentDisposition
  await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 21600 }); // ~6h (TD-06)
  // download: força anexo
  await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="video.mp4"' }), { expiresIn: 21600 });
  ```
  `ResponseContentDisposition` vira o query param `response-content-disposition` na URL assinada — mesma chave/endpoint que o streaming, só muda o parâmetro (`TD-03`).
- **Impacto na implementação:** endpoint da API para obter URL de reprodução de vídeo `ready` retorna a URL pré-assinada (não um stream); nenhum parsing de `Range` na API (herdado do protocolo S3, `TD-06`).
- **Cuidados de configuração em Docker:** usa o mesmo `S3Client` (endpoint `minio`); `expiresIn` em **segundos**. TTL generoso (~6h) cobre uma sessão típica; renovação fica a cargo do frontend em fase futura.

---

## Dependências transitivas / condicionais

### ioredis

- **Versão / critério:** **transitiva** via `bullmq` — não instalar como dependência direta (o enunciado lista "ioredis, se necessário" → **não necessário** nesta fase).
- **Finalidade no projeto:** driver Redis que o BullMQ usa internamente para falar com o serviço `redis`.
- **Documentação consultada:** context7 `/taskforcesh/bullmq` (`guide/connections.md`, `going-to-production.md` — `retryStrategy` default exponencial 1s–20s).
- **Decisão de uso:** configurar a conexão do BullMQ via objeto `{ host, port }`; **não** importar `ioredis` diretamente. Só promover a dependência direta se surgir necessidade de opções avançadas (TLS, Sentinel/Cluster, `retryStrategy` customizado) — nesse caso, passar uma instância `IORedis` ao campo `connection`.
- **Impacto na implementação:** nenhum enquanto for transitiva; sem entrada em `package.json`.
- **Cuidados de configuração em Docker:** host = `redis`. O `retryStrategy` default do ioredis (backoff exponencial até 20s) já cobre reconexão a blips do container `redis`.

---

## Tecnologias de infraestrutura (não-npm)

### FFmpeg / ffprobe

- **Versão / critério:** binários de **sistema**, não npm. Instalados via `apt-get install ffmpeg` no `Dockerfile.dev` (fornece `ffmpeg` e `ffprobe`). Critério: versão do repositório da imagem base Debian/Ubuntu (esperado FFmpeg ≥ 6.x). Sem faixa em `package.json`.
- **Finalidade no projeto:** `ffprobe` extrai os metadados persistidos na entity `Video` — `duration`, `width`/`height`, `size` (`TD-04` + revisão de **AMB-1**); `ffmpeg` extrai 1 frame de thumbnail em offset relativo (`TD-05`).
- **Documentação consultada:** não é biblioteca JS (fora do escopo do context7). Referência: documentação oficial `ffmpeg.org`/`ffprobe`. Invocação decidida via `node:child_process.spawn` (`TD-04`), evitando o wrapper `fluent-ffmpeg` (não mantido).
- **Decisão de uso:** `child_process.spawn` direto:
  - metadados: `ffprobe -print_format json -show_format -show_streams <input>` → parse de `format.duration`, `format.size`, `streams[].width`/`height`;
  - thumbnail: `ffmpeg -ss <offset> -i <input> -vframes 1 <out.jpg>`, `offset = max(1, duration * 0.1)` com clamp (`TD-05`).
- **Impacto na implementação:** etapa central do job do `video-worker`; alimenta as colunas de metadados da entity `Video` e o `thumbnail.jpg` no storage.
- **Cuidados de configuração em Docker:** instalado no `Dockerfile.dev` compartilhado (também presente na imagem `nestjs-api`, que não o invoca — trade-off aceito em `TD-04`). Smoke test `ffmpeg -version` no boot do worker (falha cedo se ausente); **timeout no `spawn`** (kill após N min → falha `TD-09`) para input corrompido; disco efêmero do `video-worker` dimensionado para o pior caso (10GB) ou processamento via stream.

### MinIO (S3-compatible storage)

- **Versão / critério:** imagem Docker `minio/minio` com **tag fixada** (RELEASE estável recente). Object storage S3-compatível local de dev — premissa fixada pelo enunciado, não uma decisão em aberto.
- **Finalidade no projeto:** armazenar vídeos originais e thumbnails (`TD-03`); bucket único `streamtube` com chaves prefixadas por `videoId`.
- **Documentação consultada:** acessado exclusivamente via **AWS SDK v3** (protocolo S3) — ver seções `@aws-sdk/client-s3` / `s3-request-presigner`. O SDK oficial `minio` foi avaliado e **rejeitado** em `TD-03` (tratar MinIO como substituto local do protocolo S3, não como vendor permanente).
- **Decisão de uso:** bucket privado por padrão; criação do bucket no boot; lifecycle `AbortIncompleteMultipartUpload` para limpar partes órfãs (`TD-02`).
- **Impacto na implementação:** novo serviço `minio` no `compose.yaml`; namespace de config de storage aponta para ele.
- **Cuidados de configuração em Docker:** serviço `minio` no Compose; endpoint interno `http://minio:9000` (host = nome do serviço), console em `:9001`; `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` via env; **volume nomeado** para persistência dos objetos; `forcePathStyle: true` no cliente (MinIO não suporta virtual-hosted-style).

### Redis

- **Versão / critério:** imagem Docker `redis` com **tag fixada** (ex. `redis:7-alpine` ou superior estável). Backing store da fila BullMQ (`TD-01`).
- **Finalidade no projeto:** broker/estado da fila de processamento de vídeo (jobs, retries, estado de workers).
- **Documentação consultada:** context7 `/taskforcesh/bullmq` (`going-to-production.md` — recomendações de conexão/persistência).
- **Decisão de uso:** novo serviço Compose dedicado; **persistência AOF** habilitada (`--appendonly yes`) para não perder jobs enfileirados em caso de crash (risco explícito de `TD-01`).
- **Impacto na implementação:** ponto único de falha adicional do pipeline — aceito neste estágio (sem requisito de HA no plano), mitigado pela persistência AOF.
- **Cuidados de configuração em Docker:** serviço `redis` no Compose; host de conexão = `redis` (nunca `localhost`); `command: ["redis-server", "--appendonly", "yes"]` (ou config equivalente); **volume nomeado** para o arquivo AOF; `video-worker` e `nestjs-api` com `depends_on` incluindo `redis`.
