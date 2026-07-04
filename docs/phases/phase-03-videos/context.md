---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-27T19:39:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T20:35:34-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-27T19:39:34-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-27T19:39:34-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo (título, descrição, categoria, thumbnail customizada), visibilidade público/unlisted, fluxo rascunho→publicação e painel de gerenciamento (Fase 04). Página de visualização com player, contagem de visualizações e sugestões (Fase 05). Qualquer tela/componente de frontend — a fase é **backend-only** (upload resiliente, processamento em background, streaming via URL direta ao storage).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — nenhuma capability da Fase 03 menciona tela ou componente de frontend. A UI de upload e o player pertencem às Fases 04/05; permanecem diferidos enquanto o subprojeto frontend não é iniciado.

**Sequencing notes:** Depende de Fase 01 (Configuração Base) e Fase 02 (Cadastro/Login/Conta). Cada usuário possui um canal (Fase 02); vídeos pertencem a canais.

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta (prior) — entrega `User`/`Channel`, auth por JWT e canal automático por usuário.
- **Fase 04:** Gerenciamento de Vídeos e Canal (next) — edição de vídeo, visibilidade, publicação, thumbnail customizada e painel do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Tecnologia de Fila | decided | A (BullMQ + `@nestjs/bullmq`, Redis) | bullmq@^5.79.2, @nestjs/bullmq@^11.0.4 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload de até 10GB sem travar a API | decided | A (S3 Multipart Upload, URLs pré-assinadas por parte) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage — buckets, chaves, upload/download | decided | A (bucket único, chaves por `videoId`; AWS SDK v3) | @aws-sdk/client-s3@^3.1079.0, @aws-sdk/s3-request-presigner@^3.1079.0 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Worker + processamento FFmpeg/ffprobe | decided | A (mesmo codebase, 2 bootstraps/containers; `child_process.spawn`) | ffmpeg/ffprobe (binários de sistema, não-npm) |
|     └─ Last revision: 2026-07-03 — Metadados persistidos na entity Video: duration, width, height, size | | | | | | |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Geração de thumbnail | decided | A (frame em offset relativo, ~10% da duração) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Streaming com Range / 206 Partial Content | decided | A (cliente acessa storage direto via URL pré-assinada) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | URL única por vídeo | decided | A (reaproveitar UUID da PK) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Ciclo de status — draft/processing/ready/error | decided | A (coluna única `status`, enum nativo PostgreSQL) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Comportamento em falha de processamento | decided | A (retry limitado via fila, depois `error`) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Implicações para testes e Docker Compose | decided | A (estender imagem/Dockerfile; testes via `docker compose exec nestjs-api`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07, phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06, phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-03, phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Processamento de vídeo é trabalho de background pesado (FFmpeg, potencialmente minutos por job), não apenas enfileiramento simples; os recursos maduros de retry/backoff/concorrência/stalled-job recovery do BullMQ são o ajuste mais direto. Redis é um único container leve adicional (a fase já está adicionando MinIO de qualquer forma) e `@nestjs/bullmq` mantém o mesmo padrão de confiança de manutenção (módulo documentado oficialmente pela NestJS) já usado no projeto. A vantagem de "zero infra nova" do pg-boss é real, mas seu ecossistema de integração NestJS é de terceiros e fragmentado — um degrau de confiança abaixo do módulo oficial. Novo serviço `redis` em `compose.yaml` (com `appendonly yes`); `AppModule` registra o lado produtor (`Queue`), o Video Worker registra o consumidor (`Worker`).

**Libraries:** bullmq@^5.79.2, @nestjs/bullmq@^11.0.4

### phase-03-videos/TD-02

**Recommendation:** S3 Multipart Upload com URLs pré-assinadas por parte satisfaz a restrição explícita ("não passar o arquivo de 10GB pela API") sem introduzir infraestrutura nova. A API expõe endpoints para iniciar o multipart (cria registro `draft` + `uploadId`), gerar URLs `PUT` pré-assinadas por parte sob demanda, completar (recebe ETags) e abortar — os bytes vão do cliente direto ao MinIO/S3, nunca pelo processo Node. A resumabilidade por parte é suficiente para "permita retomar em caso de falha de conexão" (`ListParts` recupera o estado após reconexão; só a parte incompleta é reenviada). Depende de TD-03 para o SDK usado na assinatura. Mitigar partes órfãs com lifecycle policy `AbortIncompleteMultipartUpload`.

**Libraries:** — _(usa o SDK definido em TD-03)_

### phase-03-videos/TD-03

**Recommendation:** Bucket único com chaves prefixadas por `videoId` (`videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`) — mais simples, sem teto de escala (ao contrário de bucket-por-vídeo) e sem provisionamento duplicado sem requisito (ao contrário de dois buckets). A chave reaproveita o mesmo UUID de TD-07, unificando identificador público e chave de storage — nenhuma tabela de mapeamento extra. Cliente SDK: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) sobre o pacote `minio`, tratando MinIO como substituto local de dev do protocolo S3 (`endpoint` customizado + `forcePathStyle: true`). Bucket privado por padrão; download força disposição de anexo na assinatura, streaming omite (inline) — mesma chave e endpoint, só muda o parâmetro. Novo namespace de config (padrão `registerAs`) e novo serviço `minio` em `compose.yaml` (bucket criado no boot).

**Libraries:** @aws-sdk/client-s3@^3.1079.0, @aws-sdk/s3-request-presigner@^3.1079.0

### phase-03-videos/TD-04

**Recommendation:** Topologia: mesmo codebase NestJS com dois bootstraps/containers — `nestjs-api` roda `main.ts` (servidor HTTP); um novo serviço `video-worker` usa a mesma imagem/Dockerfile com `command` diferente, bootando um `worker.ts` enxuto via `NestFactory.createApplicationContext(WorkerModule)` (sem listener HTTP, apenas o `Worker`/processor do BullMQ + TypeORM + client de storage). Bate com o container `Video Worker` separado do C4 sem duplicar entities/config/dependências. Invocação FFmpeg/ffprobe: `child_process.spawn` direto sobre os binários (`ffprobe` para metadados, `ffmpeg` para thumbnail), evitando o `fluent-ffmpeg` (sinalizado como não mantido). `Dockerfile.dev` instala `ffmpeg`; `video-worker` tem `depends_on: [db, redis, minio]`. Mitigar: smoke test `ffmpeg -version` no boot; timeout no `spawn` (kill após N min → falha, TD-09); dimensionar disco efêmero do worker para o pior caso (10GB) ou processar via stream.

**Libraries:** ffmpeg/ffprobe (binários de sistema, instalados no Dockerfile; invocados via `node:child_process`)

**Revisions:**

- 2026-07-03 — Metadados extraídos via `ffprobe` e persistidos na entity `Video` fixados em: `duration` (int, segundos), `width`/`height` (int, px) e `size` (bigint, bytes). Rationale: conjunto mínimo útil que satisfaz a capability "extração de duração e metadados" (plural) sem modelar campos de transcoding (codec/bitrate) fora do escopo da Fase 03 — resolve AMB-1.

### phase-03-videos/TD-05

**Recommendation:** Frame único em offset relativo fixo (ex. 10% da duração, mínimo 1s) — melhor equilíbrio: evita o problema comum de frame preto do primeiro frame (`-ss 0`) a custo quase zero (a duração já está disponível do mesmo job ffprobe de TD-04), sem a complexidade da heurística de múltiplos frames candidatos, para uma feature que a Fase 04 já torna substituível pelo usuário (thumbnail customizada). Etapa do job do worker: `offset = max(1, duration * 0.1)`, extrair frame único, salvar em `videos/{videoId}/thumbnail.jpg`. Clamp para vídeos muito curtos (`min(offset, duration - 0.1)`); vídeo sem stream de vídeo → falha de processamento (TD-09).

**Libraries:** — _(reutiliza `ffmpeg` de TD-04)_

### phase-03-videos/TD-06

**Recommendation:** Cliente acessa o storage diretamente via URL pré-assinada (GET) — a única opção consistente com a arquitetura do C4 (`Rel(frontend, storage, "Streams", "HTTPS")`), e obtém corretude de `Range`/206 de graça a partir do protocolo `GetObject` do S3 em vez de reimplementá-la no NestJS (evita o anti-padrão de todo byte de reprodução atravessar o processo da API, e o bug conhecido de `StreamableFile`+Range em iOS). O endpoint da API para um vídeo `ready` retorna a URL pré-assinada (TD-03), não um stream — nenhum código de parsing de `Range`. Mitigar: TTL generoso (ex. 6h) cobre uma sessão típica; renovação fica a cargo do frontend em fase futura; vazamento de URL é aceitável dado que vídeos publicados são assistíveis por anônimos.

**Libraries:** — _(reutiliza o GET pré-assinado do AWS SDK de TD-03)_

### phase-03-videos/TD-07

**Recommendation:** Reaproveitar o UUID (PK) do registro de vídeo como identificador público — consistente com o padrão já estabelecido em todas as entities do projeto (`User`, `Channel`, `RefreshToken`, `VerificationToken`), sem lógica de colisão/retry (diferente do nickname de canal, que opera sobre texto livre; UUID v4 tem colisão desprezível). O mesmo valor já serve como chave de storage em TD-03, unificando "identificador de URL" e "chave de objeto" — nenhuma coluna/tabela de mapeamento extra. Rotas públicas usam `:id` diretamente (ex. `GET /videos/:id`). Cuidado único: o `id` deve ser gerado na criação do registro `draft` (TD-08), antes do upload começar, já que TD-03 usa esse valor como prefixo de chave desde o início do fluxo.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Coluna única `status` (enum nativo PostgreSQL: `draft | processing | ready | error`), com transições validadas na camada de serviço — segue o precedente já estabelecido (`VerificationToken.type`), elimina estados inconsistentes por construção (ao contrário de múltiplas booleanas) e não introduz auditoria de histórico não requisitada pelo plano. Coluna `status` na entity de vídeo (default `'draft'`). Transições: criação → `draft`; job consumido da fila → `processing`; sucesso → `ready`; falha após esgotar retries (TD-09) → `error`. Mitigar corrida entre tentativas de retry: o worker atualiza o status apenas ao final de cada tentativa (sucesso ou falha definitiva), nunca em estados intermediários.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Retry automático limitado (ex. 3 tentativas, backoff exponencial) via mecanismo nativo da fila (`attempts`/`backoff` do BullMQ, TD-01), depois `error` — equilibra resiliência a falhas transitórias (blip de rede no storage, OOM momentâneo do worker) contra não mascarar falhas permanentes para sempre (ao contrário de retry indefinido, que travaria a fila) e sem exigir UI/endpoint de retry manual não previsto (que "sem retry" tornaria necessário). Nova coluna na entity de vídeo para a mensagem de erro, populada apenas na transição final para `error`, exigindo que o worker capture o erro real (stderr do ffmpeg/ffprobe, exception) — não um texto genérico. Objeto órfão após falha: reaproveitar a lifecycle policy de limpeza (TD-02) ou exclusão explícita ao marcar `error`.

**Libraries:** — _(usa a API de retry nativa do BullMQ de TD-01)_

### phase-03-videos/TD-10

**Recommendation:** Estender a imagem/Dockerfile única existente; testes continuam via `docker compose exec nestjs-api npm test -- --runInBand` — consistente com o precedente já estabelecido em `nestjs-project/CLAUDE.md` (infra real em testes de integração, ex. Mailpit real em `mail.service.integration-spec.ts`; não mock) e decorrência natural de TD-04 Option A (mesma imagem para API e worker). `compose.yaml` ganha 3 serviços: `minio` (bucket criado no boot), `redis`, `video-worker` (mesma imagem, `command` de bootstrap standalone, `depends_on: [db, redis, minio]`). `Dockerfile.dev` instala `ffmpeg`. Fixtures de vídeo propositalmente minúsculas (1-3s, poucos KB, mp4/webm) versionadas em `nestjs-project/test/fixtures/`; cenários de pipeline completo reservados à suíte `*.e2e-spec.ts`. Nunca usar arquivos de teste próximos a 10GB.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Auth Library Approach — plugin architecture via `@nestjs/passport` was recommended, but the **decision diverged during implementation**: custom guards with `@nestjs/jwt` only were preferred to keep the dependency surface smaller (social login is not on the near-term roadmap). Videos endpoints reuse the existing `JwtAuthGuard` + `@Public()` opt-out.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11. Video upload/patch DTOs follow this same pattern.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. Single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. Videos module reuses the same filter and `DomainException` base.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to a module only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Refresh Token Format — Opaque was recommended (DB lookup is mandatory, so JWT signature adds no security value), but the **decision diverged**: JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — A strict `[a-z0-9_]` allowlist is the simplest and most portable choice for channel handles: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function. New storage/queue config namespaces (TD-01/TD-03) follow this pattern.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

## Inherited Conventions

- Backend config uses `@nestjs/config` com fábricas namespaced `registerAs(name, () => ({...}))` — um arquivo por domínio em `src/config/`. Novos namespaces de storage e fila seguem o mesmo padrão. _(from phase 01)_
- Env variables são validadas por um schema Joi em `src/config/env.validation.ts`, passado a `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config é injetada via `ConfigType<typeof xxxConfig>` e `@Inject(xxxConfig.KEY)`; a mesma fábrica é importável como função plana para contextos não-DI (ex. TypeORM CLI). _(from phase 01)_
- `data-source.ts` carrega `.env` via `import 'dotenv/config'` no topo, importa `databaseConfig` e o chama como função plana; parâmetros de conexão nunca são duplicados entre `AppModule` e `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (não `forRoot`) com `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` retornando `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Entities: nome de tabela explícito em `@Entity('table_name')`, PK UUID via `@PrimaryGeneratedColumn('uuid')`, timestamps `@CreateDateColumn()` + `@UpdateDateColumn()`. Campos sensíveis usam `{ select: false }`. _(from phase 02)_
- Colunas de status/tipo usam enum nativo do PostgreSQL (`{ type: 'enum', enum: SomeEnum }`) — precedente `VerificationToken.type`; a entity de vídeo segue isso em TD-08. _(from phase 02)_
- Mudanças de schema sempre via migration gerada pela CLI TypeORM (`npm run migration:generate`), nunca escrita à mão e nunca `synchronize: true`. _(from phase 02)_
- Respostas de erro padronizadas por um filtro de exceção de domínio (`{ statusCode, error, message }` com códigos de domínio); o módulo de vídeos reutiliza o mesmo filtro e a base `DomainException`. _(from phase 02)_
- Validação de request via `class-validator` + `class-transformer` com `ValidationPipe` global; DTOs de upload/patch de vídeo seguem o mesmo padrão. _(from phase 02)_
- Todo endpoint é protegido por padrão pelo `JwtAuthGuard` global (`APP_GUARD`), com opt-out via `@Public()`; rotas públicas de vídeo (ex. obter URL de reprodução) usam `@Public()`. _(from phase 02)_
- Testes de integração exercitam infraestrutura real dentro do Docker (não mocks) e rodam via `docker compose exec nestjs-api npm test -- --runInBand`; sufixos `*.spec.ts` (unit), `*.integration-spec.ts` (DB/IO real), `*.e2e-spec.ts` (HTTP completo). _(from phase 02)_
- Cada feature de domínio tem seu próprio módulo registrado em `AppModule`; controllers tratam HTTP, services concentram regra de negócio; nomes kebab-case (arquivos) / PascalCase (classes), módulos no plural, entities no singular. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não inicializado na fase; telas ficam para fase futura ao iniciar o subprojeto frontend. |
| Telas de frontend (genérico) | deferred | phase-01-configuracao-base | `next-frontend/` não inicializado na fase; superfícies de UI começam em fase posterior. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None — todas as capabilities da Fase 03 são backend e estão cobertas por TDs; plan-resolve acrescenta linhas se o usuário diferir alguma._ | | | |

## Testing Requirements

### nestjs-project

Consulte a Skill `testing-guide-nestjs-project` para os requisitos de camada por tipo de artefato em `nestjs-project/`. A Fase 03 introduz novos tipos de artefato que herdam a pirâmide de testes já estabelecida (unit + integration + e2e), com estas ênfases específicas desta fase:

- **Video entity + migration (TD-07/TD-08/TD-09):** teste de integração com DB real cobrindo PK UUID, coluna `status` (enum nativo) e coluna de mensagem de erro; migration verificada pela suíte de migrations existente.
- **Videos service/controller + DTOs de upload (TD-02):** unit para regra de negócio e transições de estado; integration para persistência; e2e para o ciclo HTTP dos endpoints de multipart (iniciar/assinar parte/completar/abortar).
- **Storage service (TD-03):** integration contra **MinIO real** no Docker (não mock), seguindo o precedente do Mailpit — gerar URLs pré-assinadas, upload/download, organização de chaves por `videoId`.
- **Queue producer + Worker/FFmpeg processor (TD-01/TD-04/TD-05/TD-09):** integration contra **Redis real** e binários **ffmpeg/ffprobe reais** sobre fixtures de vídeo minúsculas (1-3s, poucos KB) em `nestjs-project/test/fixtures/`; cobrir extração de metadados, geração de thumbnail, retry/backoff e transição para `error`.
- **Pipeline completo (upload → processamento → ready/error):** reservado à suíte `*.e2e-spec.ts` (mais lenta, rodada via `npm run test:e2e`). Nunca usar arquivos de teste próximos a 10GB.

Convenção de execução inalterada (TD-10): `docker compose exec nestjs-api npm test -- --runInBand`. A cobertura de camada por SI é registrada em `progress.md` durante a implementação.
