---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 2
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-03T19:34:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T15:40:16-03:00"
issues:
  - id: MD-1
    status: open
    summary: "Versões das libs novas de fila (TD-01) e storage (TD-03) não fixadas"
  - id: AMB-1
    status: open
    summary: "Metadados a extrair/persistir além de duration não enumerados (TD-04)"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

_(Observações não-bloqueantes, verificadas contra o enunciado em `docs/project-plan.md` e registradas apenas para ciência — não requerem ação e não afetam o veredito: (1) TD-02 cita a exigência "permita retomar em caso de falha de conexão" que não aparece nos bullets do enunciado da Fase 03; como o S3 Multipart escolhido a satisfaz nativamente via `ListParts` a custo zero e a lógica de retomada do cliente é frontend/diferida, não há criação de escopo. (2) TD-06 usa o termo "vídeos publicados" embora o fluxo de publicação/visibilidade seja explicitamente Fase 04; a decisão substantiva — playback `@Public` para vídeos `ready` acessados por UUID não-adivinhável — é coerente com o modelo "anônimo assiste livremente" e representa um estado interino "unlisted-by-default" válido até a Fase 04.)_

### Ambiguities

- **AMB-1** — A capability "Processamento automático do vídeo após upload (extração de duração e **metadados**)" pede metadados no plural, mas nenhum TD enumera **quais** metadados são extraídos e persistidos além de `duration`. TD-04 cobre a invocação do `ffprobe`, TD-08 a coluna `status` e TD-09 a coluna de mensagem de erro — nenhum define as colunas de metadados da entity `Video`. Sem isso, o plan-build não consegue derivar o Data Model completo (colunas tipadas por campo — resolução/dimensões, tamanho, codec, bitrate — vs. somente `duration` vs. blob JSON) sem adivinhar. Explicit choice: enumerar o conjunto concreto de campos de metadados (ex. `duration` + `width`/`height` + `size`, ou `duration`-only) via `/plan-resolve phase-03-videos` (ou `/research` se exigir uma decisão estratégica de modelagem).

### Missing Decisions

- **MD-1** — As dependências npm novas decididas em `phase-03-videos/TD-01` (`bullmq`, `@nestjs/bullmq`) e `phase-03-videos/TD-03` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) estão **sem versão fixada**: ausentes de `nestjs-project/package.json` e listadas sem faixa de versão no Decisions Index/Detail — divergindo do padrão das Fases 01/02, cujos TDs fixam faixas (ex. `argon2@^0.41.x`, `@nestjs/config@^4.x`, `joi@^17.x`). `CLAUDE.md` torna obrigatório o lookup de documentação via context7 e a resolução de versão antes de implementar; com o veredito `clean` o pipeline pularia o `plan-resolve` e chegaria ao `plan-build` sem `library-refs.md` para essas libs. Explicit choice: rodar `/plan-resolve phase-03-videos` (fixa as versões via context7 e grava `library-refs.md`) **ou** adicionar faixas de versão explícitas a `phase-03-videos/TD-01` e `phase-03-videos/TD-03` via `/research`. _(Os binários de sistema `ffmpeg`/`ffprobe` de TD-04 são corretamente não-fixados por npm — instalados via `Dockerfile.dev`; fora deste gap.)_

### Dependency Gaps

_None._

_(Verificado: dependências de Fase 01 — namespaces `registerAs`, Joi, `data-source.ts` — e Fase 02 — entity `Channel`/relação vídeo→canal, `JwtAuthGuard` + `@Public()`, `DomainException` filter, enum nativo PostgreSQL, migrations via CLI — todas presentes em `## Inherited Conventions`/`## Inherited Decisions Detail`. A nova infra — Redis, MinIO, `video-worker` — é adicionada nesta fase por TD-01/TD-03/TD-04/TD-10, não é prerequisito de fase anterior. Ordenação intra-fase implícita nos TDs — TD-02 depende de TD-03; `id` gerado no `draft` antes do upload por TD-07/TD-08.)_

### Inherited Constraint Conflicts

_None._

_(Verificado: TD-07 UUID PK, TD-08 enum nativo PostgreSQL, TD-06/TD-03 playback `@Public`, TD-01/TD-03 novos namespaces `registerAs`, reuso do `DomainException` filter e migrations via CLI — todos alinhados às convenções herdadas, sem contradição.)_

### Unresolved Open Questions

_None._

_(Os 10 TDs estão `decided`; nenhum `pending`. Sem `## UI Inventory`, não há Open Questions de inventário.)_

### UI Coverage Gaps

_None._

_(Fase backend-only — `next-frontend/` diferido, nenhum `## UI Inventory`. UIG não se aplica.)_

## Resolved Issues

_No issues resolved yet._
