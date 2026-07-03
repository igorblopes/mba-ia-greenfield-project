---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-03T20:36:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-03T20:35:34-03:00"
issues:
  - id: MD-1
    status: resolved
    summary: "Versões das libs novas de fila (TD-01) e storage (TD-03) não fixadas"
    resolved_by: "library-refs.md — versões fixadas via context7 + Libraries em TD-01/TD-03"
  - id: AMB-1
    status: resolved
    summary: "Metadados a extrair/persistir além de duration não enumerados (TD-04)"
    resolved_by: "phase-03-videos/TD-04 — Revisions: duration, width, height, size"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

_(Observações não-bloqueantes, verificadas contra o enunciado em `docs/project-plan.md` e registradas apenas para ciência — não requerem ação e não afetam o veredito: (1) TD-02 cita a exigência "permita retomar em caso de falha de conexão" que não aparece nos bullets do enunciado da Fase 03; como o S3 Multipart escolhido a satisfaz nativamente via `ListParts` a custo zero e a lógica de retomada do cliente é frontend/diferida, não há criação de escopo. (2) TD-06 usa o termo "vídeos publicados" embora o fluxo de publicação/visibilidade seja explicitamente Fase 04; a decisão substantiva — playback `@Public` para vídeos `ready` acessados por UUID não-adivinhável — é coerente com o modelo "anônimo assiste livremente" e representa um estado interino "unlisted-by-default" válido até a Fase 04. (3) Nenhum TD trata explicitamente a associação `Video` → `Channel`/`User` (FK de propriedade) nem autorização de upload por canal — não é sinalizado como gap porque decorre diretamente das convenções já herdadas da Fase 02 (`JwtAuthGuard` global, canal automático por usuário, PK UUID em todas as entities) sem exigir uma escolha estratégica com alternativas reais a pesar; é um detalhe de Data Model, não uma decisão em aberto.)_

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

_(Verificado: dependências de Fase 01 — namespaces `registerAs`, Joi, `data-source.ts` — e Fase 02 — entity `Channel`/relação vídeo→canal, `JwtAuthGuard` + `@Public()`, `DomainException` filter, enum nativo PostgreSQL, migrations via CLI — todas presentes em `## Inherited Conventions`/`## Inherited Decisions Detail`. A nova infra — Redis, MinIO, `video-worker` — é adicionada nesta fase por TD-01/TD-03/TD-04/TD-10, não é prerequisito de fase anterior. Ordenação intra-fase implícita nos TDs — TD-02 depende de TD-03; `id` gerado no `draft` antes do upload por TD-07/TD-08. Confirmado contra o estado atual de `nestjs-project/package.json` e `nestjs-project/compose.yaml`: nenhuma dependência de fila/storage/ffmpeg está instalada ainda e nenhum serviço `redis`/`minio`/`video-worker` existe no compose — esperado nesta etapa de planejamento, a ser adicionado em `/plan-build`/implementação, não uma lacuna de decisão.)_

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

- **MD-1** — Versões das libs novas de fila (TD-01) e storage (TD-03) não fixadas. resolved_by: `library-refs.md` (versões fixadas via context7 — `bullmq@^5.79.2`, `@nestjs/bullmq@^11.0.4`, `@aws-sdk/client-s3@^3.1079.0`, `@aws-sdk/s3-request-presigner@^3.1079.0`) + linhas `**Libraries:**` adicionadas a `phase-03-videos/TD-01` e `phase-03-videos/TD-03`. Binários de sistema `ffmpeg`/`ffprobe` (TD-04) registrados em `library-refs.md` como não-npm (fora do gap de versão npm).
- **AMB-1** — Metadados a extrair/persistir além de `duration` não enumerados (TD-04). resolved_by: `phase-03-videos/TD-04` — bloco `**Revisions:**` (2026-07-03) fixa o conjunto `duration` (int, s), `width`/`height` (int, px) e `size` (bigint, bytes), propagado ao `## Decisions Detail` de `context.md` para o plan-build derivar o Data Model.
</content>
