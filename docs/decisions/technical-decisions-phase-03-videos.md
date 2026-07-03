---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-03
scope_description: "Upload e processamento de vídeos: fila de background jobs, upload resiliente de até 10GB, organização do object storage S3/MinIO, worker FFmpeg/ffprobe, geração de thumbnail, streaming com Range/206, URL única por vídeo, ciclo de status e comportamento em falha."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe toda a decisão desta fase: módulo de fila, upload, storage, worker FFmpeg/ffprobe, streaming e ciclo de status do vídeo.
- `next-frontend/` — sem decisão aberta neste documento. Nenhuma bullet de capability da Fase 03 em `docs/project-plan.md` menciona tela ou componente de frontend (upload UI, player) — a página de visualização com player é explicitamente `Fase 05`, e o painel de gerenciamento/edição de vídeo é `Fase 04`. A Fase 03 é backend-only (upload resiliente, processamento em background, streaming via URL direta ao storage).

> **Premissas fixadas pelo enunciado:** o armazenamento de objetos é S3-compatível (MinIO local em Docker) — **não é uma decisão em aberto** neste documento (ver Context de TD-03). A **decisão de stack em aberto desta fase é a tecnologia de fila** (TD-01).

> **Nota sobre pesquisa:** o MCP `context7` (obrigatório por `CLAUDE.md` §"Library Documentation Lookup") não estava conectado nesta sessão — apenas o servidor `postgres` estava configurado em `.mcp.json`. As versões e comparações de bibliotecas abaixo foram obtidas via `npm view <pkg> version` (registry real, versões atuais em 2026-07-03) e busca na documentação oficial/comunidade via `WebSearch`. Sinalizado para o usuário na resposta desta etapa.

---

## TD-01: Tecnologia de Fila

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama `docs/diagrams/software-arch.mermaid` define um container `Message Queue` com tecnologia `"TBD"` — esta é a decisão de stack em aberto citada no enunciado. A API precisa enfileirar um job de processamento por vídeo enviado; o Video Worker consome esses jobs. A infra atual (`nestjs-project/compose.yaml`) tem apenas `nestjs-api`, `db` (PostgreSQL 17) e `mailpit` — nenhum broker de fila existe hoje.

**Options:**

### Option A: BullMQ (`bullmq` + `@nestjs/bullmq`), backed por Redis
- Fila madura baseada em Redis; `@nestjs/bullmq` (v11.0.4, compatível com `@nestjs/core ^11.0.1` já instalado) é o módulo de filas documentado oficialmente em docs.nestjs.com/techniques/queues. Separa `Queue` (produtor, usado na API) de `Worker` (consumidor, usado no Video Worker) como classes distintas — alinhado ao container separado do C4.
- **Pros:** Integração oficialmente documentada pela NestJS (mesmo nível de confiança que `@nestjs/throttler`/`@nestjs/jwt` já usados no projeto). Retry com backoff exponencial, controle de concorrência, detecção de jobs travados (stalled) e prioridade nativos — adequado a jobs longos de FFmpeg. `bullmq` v5.79.2 é ativamente mantido.
- **Cons:** Introduz Redis como nova infraestrutura (novo serviço no compose) além do MinIO que a fase já adiciona.

### Option B: pg-boss, backed por PostgreSQL
- Fila que usa `SKIP LOCKED` sobre uma tabela PostgreSQL própria (schema `pgboss`, auto-gerenciado pela lib, fora do controle de migrations do TypeORM). PostgreSQL 17 já está no stack.
- **Pros:** Zero infraestrutura nova — reaproveita o serviço `db` já existente em `compose.yaml`. Garantias ACID de job (mesma transação que grava dados de negócio, se necessário).
- **Cons:** Ecossistema de integração com NestJS é fragmentado e não-oficial — múltiplos pacotes concorrentes de terceiros (`@wisemen/pgboss-nestjs-job`, `@wavezync/nestjs-pgboss`, `@apricote/nest-pg-boss`), nenhum mantido pela organização NestJS, risco de manutenção maior que `@nestjs/bullmq`. Teto de throughput (~100-200 jobs/s por lock contention) é irrelevante aqui (processamento de vídeo é inerentemente baixo-throughput/CPU-bound), mas a lib cria e migra seu próprio schema (`pgboss`) fora da disciplina de migrations TypeORM já estabelecida no projeto (`npm run migration:generate`).

### Option C: RabbitMQ (`@nestjs/microservices` transporte RMQ, ou `@golevelup/nestjs-rabbitmq`)
- Broker de mensageria dedicado; combina literalmente com o rótulo genérico "Message Queue" do diagrama C4.
- **Pros:** Suporte oficial via `@nestjs/microservices` (transporte RMQ). Padrão de mercado para arquiteturas orientadas a eventos com múltiplos consumidores/exchanges.
- **Cons:** Maior footprint operacional (broker dedicado + configuração de exchanges/queues/bindings, UI de management) para um único par produtor/consumidor (API → Video Worker). Nenhum requisito do projeto pede múltiplos consumidores, exchanges topic/fanout ou roteamento complexo — overhead sem benefício correspondente neste escopo.

**Recommendation:** **Option A (BullMQ + `@nestjs/bullmq`)** — processamento de vídeo é trabalho de background pesado (FFmpeg, potencialmente minutos por job), não apenas enfileiramento simples; os recursos maduros de retry/backoff/concorrência/stalled-job recovery do BullMQ são o ajuste mais direto. Redis é um único container leve adicional (a fase já está adicionando MinIO de qualquer forma) e `@nestjs/bullmq` mantém o mesmo padrão de confiança de manutenção (módulo documentado oficialmente pela NestJS) já usado no projeto. A vantagem de "zero infra nova" do pg-boss é real, mas seu ecossistema de integração NestJS é de terceiros e fragmentado — um degrau de confiança abaixo do módulo oficial.

**Decision:** A (BullMQ + `@nestjs/bullmq`) — fila madura baseada em Redis, com módulo de integração oficialmente documentado pela NestJS e recursos nativos de retry/backoff/concorrência adequados a jobs longos de processamento de vídeo. Redis é aceito como nova infraestrutura por ser um único container leve de operar, frente ao degrau de maturidade de integração NestJS que separa esta opção de pg-boss.

**Impact on Implementation:** Novo serviço `redis` em `nestjs-project/compose.yaml`. Novo namespace de configuração para a fila, seguindo o padrão `registerAs` já estabelecido (`phase-01/TD-03`). `AppModule` registra o módulo de fila do lado produtor; o Video Worker (TD-04) registra o consumidor correspondente. Nomes exatos de arquivos e variáveis de ambiente ficam para a etapa de implementação.

**Risks & Mitigation:** Redis torna-se um ponto único de falha adicional para o pipeline de processamento — mitigado por `persistence` padrão do Redis (AOF/RDB) já suficiente neste estágio (sem requisito de alta disponibilidade no plano). Jobs perdidos em caso de crash do Redis sem persistência habilitada — mitigar configurando `appendonly yes` no serviço `redis` do compose.

---

## TD-02: Estratégia de Upload de Vídeo de até 10GB sem Travar a API

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` exige upload de até 10GB "sem impactar a performance do sistema" e, na seção "Pontos de Atenção", exige explicitamente que o upload "permita retomar em caso de falha de conexão" (resumable). A restrição do enunciado desta pesquisa é direta: **não passar o arquivo de 10GB pela API**. Nota de reconciliação com o diagrama: `Rel(api, storage, "Uploads")` em `software-arch.mermaid` é compatível com a leitura "a API orquestra/inicia o upload no storage" (inicia o multipart, gera URLs assinadas, finaliza) sem que os bytes do arquivo atravessem o processo da API — não há contradição, apenas uma leitura mais específica do relacionamento genérico do C4.

**Options:**

### Option A: S3/MinIO Multipart Upload com URLs pré-assinadas por parte
- A API expõe endpoints para: (1) `CreateMultipartUpload` no storage e persistir o `uploadId` + registro de vídeo em status `draft`; (2) gerar URLs `PUT` pré-assinadas por número de parte, sob demanda do cliente (partes tipicamente de 5-100MB); (3) `CompleteMultipartUpload` recebendo os ETags coletados pelo cliente. Os bytes do arquivo vão do cliente diretamente ao MinIO/S3 — nunca passam pelo processo Node.js da API.
- **Pros:** Satisfaz a restrição "não passar pela API" nativamente. Resumível o suficiente para o requisito: partes já enviadas não precisam ser reenviadas (`ListParts` recupera o estado após reconexão); só a parte incompleta no momento da falha é reenviada. Recurso nativo do protocolo S3 — nenhuma infraestrutura nova além do MinIO já decidido.
- **Cons:** Cliente (frontend, fora de escopo nesta fase) precisa implementar a lógica de chunking + coleta de ETags + retry por parte — mais lógica no lado do consumidor do que um simples `PUT` único.

### Option B: Protocolo tus via servidor dedicado (`tusd` com S3 store)
- Protocolo aberto de upload resumível (padrão com `tus-js-client`/`uppy` no client). Requer um novo serviço `tusd` no Docker Compose, configurado com S3 store apontando para o mesmo bucket MinIO.
- **Pros:** Resumabilidade em granularidade de byte exato (não por parte), tooling de client maduro (`uppy`).
- **Cons:** Adiciona um componente de infraestrutura inteiro (`tusd`) só para ganhar precisão de resumo em nível de byte vs. nível de parte (5-100MB) — ganho marginal frente ao requisito declarado. Mais uma peça a operar/configurar (credenciais S3 duplicadas no tusd, mapeamento upload-concluído → registro de vídeo).

### Option C: Streaming multipart/form-data através da API (proxy com streaming em disco, sem buffer total em memória)
- API recebe o upload via `multer`/Busboy com streaming para disco, depois envia ao storage.
- **Rejeitada explicitamente pela restrição do enunciado:** mesmo com streaming (sem buffer completo em memória), os 10GB ainda atravessam a pilha de rede do processo da API e ocupam uma conexão/thread HTTP pela duração inteira do upload (potencialmente horas em conexões lentas) — viola diretamente "não passar o arquivo de 10GB pela API" e é exatamente o risco de "travar o sistema" citado em Pontos de Atenção. Incluída para evidenciar por que é descartada, não como alternativa viável.

**Recommendation:** **Option A (S3 Multipart Upload com URLs pré-assinadas)** — satisfaz a restrição explícita sem introduzir infraestrutura nova, e a resumabilidade por parte é suficiente para o requisito "permita retomar em caso de falha de conexão" (o usuário não precisa retomar do byte exato, apenas não reenviar partes já confirmadas). Depende de TD-03 para o cliente/SDK usado para assinar as URLs.

**Decision:** Option A (S3 Multipart Upload com URLs pré-assinadas). Ajuda a reduzir a infraestrutura necessária e já tem o requisito de enviar chuncks para não travar e não passar pela API.

**Impact on Implementation:** Endpoints novos no módulo de vídeos: iniciar upload (cria registro `draft` + `uploadId`), obter URL assinada por parte, completar upload (dispara enfileiramento do job de processamento — TD-01/TD-04), abortar upload. Nenhuma mudança em `compose.yaml` além do já previsto para MinIO (TD-03).

**Risks & Mitigation:** Uploads multipart abandonados (usuário fecha a aba a meio caminho) deixam partes órfãs consumindo espaço no bucket — mitigar com uma lifecycle policy do bucket (`AbortIncompleteMultipartUpload` nativa do S3/MinIO) expirando uploads incompletos após N dias. Geração de URL assinada requer relógio sincronizado entre API e MinIO (assinatura SigV4 é sensível a clock skew) — mitigado por ambos rodarem no mesmo host Docker em dev; monitorar em produção.

---

## TD-03: Estratégia de Uso do Object Storage S3/MinIO — Buckets, Chaves, Upload e Download

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Download do vídeo pelo usuário"

**Context:** O uso de storage S3-compatível com MinIO local já está definido no enunciado (não é uma decisão em aberto). O que precisa ser decidido é: qual SDK client usar, como organizar buckets/chaves de forma que "URL única por vídeo, sem conflito" (TD-07) seja natural, e como upload/download interagem com essa organização.

**Cliente SDK (premissa, não listada como opções lettered por ter resposta de menor controvérsia):** AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, v3.1079.0) é recomendado sobre o pacote `minio` (SDK oficial MinIO, v8.0.7): a frase do enunciado "já está direcionado para S3 compatível, com MinIO local" trata o MinIO como um substituto local de dev para um protocolo, não um compromisso permanente de vendor. O AWS SDK é o cliente de-facto do protocolo S3 independente do provedor por trás (basta configurar `endpoint` customizado + `forcePathStyle: true` para apontar ao MinIO), minimizando custo de troca se o storage de produção não for MinIO.

**Options (organização de bucket/chave):**

### Option A: Bucket único, chaves prefixadas por vídeo
- Um bucket (ex. `streamtube`) com chaves `videos/{videoId}/original.<ext>` e `videos/{videoId}/thumbnail.jpg`, usando o UUID do próprio registro de vídeo (TD-07) como prefixo.
- **Pros:** Zero provisionamento extra por vídeo. Prefixo por vídeo já agrupa naturalmente os dois artefatos (vídeo + thumbnail). Uma única configuração de CORS/policy a manter tanto em MinIO (dev) quanto no storage de produção.
- **Cons:** Nenhuma política de lifecycle/cache diferenciada entre vídeo e thumbnail sem regras por prefixo (mitigável — S3 lifecycle rules suportam filtro por prefixo do mesmo jeito que por bucket).

### Option B: Dois buckets — um por tipo de artefato
- `streamtube-videos` e `streamtube-thumbnails`.
- **Pros:** Separação de responsabilidade mais explícita; políticas de cache/lifecycle por bucket sem precisar de filtro por prefixo.
- **Cons:** Dobra o provisionamento (CORS, policy, criação) em dois ambientes (MinIO dev + storage prod) sem que o plano do projeto descreva qualquer política diferenciada entre vídeo e thumbnail que justifique o isolamento.

### Option C: Bucket por vídeo
- Um bucket dedicado por vídeo (`video-{videoId}`).
- **Rejeitada:** provedores S3 (incluindo AWS) impõem cotas de contagem de bucket por conta (tipicamente 100 por padrão) — não escala para uma plataforma de compartilhamento de vídeos onde cada upload criaria um bucket novo. Criação de bucket também é operação mais pesada/lenta que um `PUT` de objeto.

**Recommendation:** **Option A (bucket único, chaves prefixadas por `videoId`)** — mais simples, sem teto de escala (ao contrário da Option C) e sem provisionamento duplicado sem justificativa de requisito (ao contrário da Option B). A chave usa o mesmo UUID decidido em TD-07 como identificador público, unificando "chave de storage" e "identificador de URL" — nenhuma tabela de mapeamento extra necessária.

**Decision:** A (bucket único, chaves prefixadas por `videoId`, cliente AWS SDK v3) — evita o teto de cota de buckets por conta (Option C) e o provisionamento duplicado sem requisito correspondente no plano (Option B); a chave reaproveita o UUID de TD-07, unificando identificador público e chave de storage.

**Impact on Implementation:** Novo namespace de configuração para storage (padrão `registerAs`), com as variáveis de conexão ao endpoint S3-compatível (credenciais, bucket, region, path-style). Novo serviço `minio` em `compose.yaml` com criação do bucket no boot. Download e streaming (TD-06) reaproveitam o mesmo mecanismo de GET pré-assinado: download força disposição de anexo na assinatura, streaming/playback omite esse parâmetro (inline) — mesma chave, mesmo endpoint, apenas o parâmetro de assinatura muda. Nomes exatos de arquivos e variáveis de ambiente ficam para a etapa de implementação.

**Risks & Mitigation:** Credenciais MinIO hardcoded em dev vs. credenciais reais de S3 em produção — já mitigado pelo padrão `registerAs` + Joi validation já estabelecido (TD-01/TD-02 da Fase 01), sem necessidade de mecanismo novo. Bucket policy mal configurada expondo objetos publicamente antes do vídeo estar `ready` — mitigado por bucket privado por padrão + acesso exclusivamente via URL pré-assinada (TD-06), nunca ACL pública.

---

## TD-04: Execução do Worker e Processamento com FFmpeg/ffprobe

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O C4 (`software-arch.mermaid`) define um container `Video Worker` separado, rotulado `"FFmpeg"`, que lê/salva no storage e atualiza o banco (`Rel(worker, storage, "Reads/Saves")`, `Rel(worker, db, "Updates")`). Falta decidir a topologia de processo/container do worker e como ele invoca FFmpeg/ffprobe.

**Options (topologia):**

### Option A: Mesmo codebase NestJS, dois bootstraps, dois containers
- `nestjs-api` roda `main.ts` (`NestFactory.create(AppModule)`, servidor HTTP). Um novo serviço `video-worker` em `compose.yaml` usa a mesma imagem/Dockerfile, comando diferente, bootando um `worker.ts` enxuto via `NestFactory.createApplicationContext(WorkerModule)` — sem listener HTTP, apenas registra o `Worker`/processor do BullMQ (TD-01) + TypeORM + client de storage (TD-03).
- **Pros:** Bate com o container `Video Worker` separado do C4, sem duplicar entities/config/dependências (mesmo `package.json`, mesmo `node_modules`). `createApplicationContext` é o padrão documentado da NestJS para bootstraps não-HTTP.
- **Cons:** Mesma imagem Docker carrega dependências de ambos os papéis (ex. binário `ffmpeg` termina instalado também na imagem do `nestjs-api`, que nunca o invoca diretamente).

### Option B: Subprojeto totalmente separado (próprio `package.json`, próprio Dockerfile)
- Análogo a como `next-frontend` é um subprojeto separado de `nestjs-project`.
- **Pros:** Isolamento máximo de processo/dependências; deploy/scale independentes.
- **Cons:** Duplica definições de entities TypeORM (ou exige extrair um pacote interno compartilhado — decisão de tooling de monorepo fora do escopo desta fase) e duplica configuração de CI/lint/build para um projeto neste estágio de maturidade.

### Option C: Worker in-process (mesmo container do `nestjs-api`)
- O `Worker` do BullMQ roda registrado no mesmo processo do servidor HTTP.
- **Rejeitada:** contradiz o container `Video Worker` explícito do C4. Um job de FFmpeg pesado competiria pelo mesmo event loop/recursos do processo que atende requisições HTTP — exatamente o risco de "travar o sistema" que o projeto quer evitar (agora aplicado ao processamento, não só ao upload).

**Recommendation:** **Option A** — cumpre o container separado do C4 sem o custo de duplicação de dependências da Option B; é o padrão de bootstrap standalone já documentado pela NestJS.

**Options (invocação FFmpeg/ffprobe):**

### Option A: `child_process.spawn` direto sobre os binários `ffmpeg`/`ffprobe`
- `ffprobe -print_format json -show_format -show_streams <input>` para metadados (duração, codec, resolução); `ffmpeg -ss <t> -i <input> -vframes 1 <output.jpg>` para thumbnail (TD-05). Binários instalados na imagem Docker do worker via `apt-get install ffmpeg`.
- **Pros:** Nenhuma dependência de wrapper para um conjunto pequeno e bem delimitado de operações (probe + extração de um frame).
- **Cons:** Construção manual de arrays de argumentos CLI e parsing de stdout/stderr — mais código boilerplate que uma lib wrapper ofereceria.

### Option B: `fluent-ffmpeg`
- Wrapper chainable historicamente popular sobre os mesmos binários.
- **Rejeitada:** pesquisa (`npm`/comunidade, 2026) indica que o pacote não é mais mantido ativamente e tem problemas de compatibilidade reportados com versões recentes do FFmpeg — fundação de risco para o pipeline central de processamento da fase.

### Option C: Serviço de transcoding gerenciado na nuvem (ex. AWS MediaConvert, Mux)
- Terceiriza o FFmpeg para uma API gerenciada.
- **Rejeitada:** introduz dependência de vendor externo e custo sem base no `project-plan.md` ou `CLAUDE.md` — o C4 já especifica um worker self-hosted rotulado `"FFmpeg"`, não um serviço gerenciado. Inventa requisito fora do enunciado.

**Recommendation:** **Option A (`child_process.spawn` direto)** — evita depender de um wrapper sinalizado como não mantido para um escopo de operações pequeno e estável; alinhado ao rótulo `"FFmpeg"` self-hosted do C4.

**Decision:** A para as duas sub-decisões — (1) Topologia: mesmo codebase NestJS com dois bootstraps/containers (`nestjs-api` via `main.ts`, Video Worker via um bootstrap standalone), evitando duplicar entities/config em um segundo subprojeto; (2) Invocação FFmpeg/ffprobe: `child_process.spawn` direto sobre os binários, evitando a dependência não mantida do `fluent-ffmpeg`.

**Impact on Implementation:** Novo serviço `video-worker` em `compose.yaml` (mesma imagem/build de `nestjs-api`, `command` diferente, `depends_on: [db, redis, minio]`). Dockerfile (dev e produção) precisa instalar `ffmpeg` (fornece ambos os binários `ffmpeg` e `ffprobe`). Worker baixa o objeto original do storage (ou processa via stream, a definir na implementação), roda ffprobe, roda ffmpeg para thumbnail, sobe o resultado ao storage (TD-03), atualiza o registro do vídeo (TD-08) via TypeORM.

**Risks & Mitigation:** Binário `ffmpeg` ausente ou versão incompatível quebra o worker silenciosamente até o primeiro job — mitigar com um healthcheck/smoke test no boot do worker (`ffmpeg -version`) falhando o container cedo. Processos `ffmpeg` travados (input corrompido) consomem CPU indefinidamente — mitigar com timeout no `spawn` (kill do processo após N minutos) e reportar como falha (TD-09), não travar a fila. Vídeos de até 10GB baixados integralmente para processamento local exigem espaço em disco efêmero proporcional no container do worker — risco direto da escala de arquivo definida no enunciado, não endereçado hoje; mitigar dimensionando o volume/disco do serviço `video-worker` para o pior caso (10GB) ou avaliando processamento via stream direto do storage na implementação.

---

## TD-05: Estratégia de Geração de Thumbnail

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O plano exige apenas "geração automática de thumbnail a partir de um frame do vídeo" — sem exigir seleção "inteligente" do melhor frame. A Fase 04 já introduz "thumbnail customizada" editável pelo usuário — a thumbnail automática desta fase é um placeholder padrão, não a experiência final.

**Options:**

### Option A: Frame único em offset relativo fixo (ex. 10% da duração, mínimo 1s)
- Usa a duração já extraída por ffprobe (TD-04) para calcular o timestamp; `ffmpeg -ss <offset> -vframes 1`.
- **Pros:** Determinístico, custo desprezível (reaproveita a duração já obtida no mesmo job). Evita a maior parte dos frames pretos/tela de abertura que aparecem no frame `0s`.
- **Cons:** Ainda pode ocasionalmente capturar um frame de transição/corte ruim — não há garantia de qualidade "ideal".

### Option B: Primeiro frame (`-ss 0`)
- Extração no timestamp zero.
- **Cons:** Frequentemente um frame preto, fade-in ou card de abertura — problema bem documentado em pipelines de processamento de vídeo. Rejeitada como estratégia principal por gerar más thumbnails com frequência sem ganho de simplicidade relevante sobre a Option A (mesmo custo de chamada ao ffmpeg).

### Option C: Múltiplos frames candidatos + heurística de qualidade (descartar frames quase pretos/baixa variância)
- Extrai N frames e aplica uma heurística simples para escolher o "melhor".
- **Cons:** Complexidade e tempo de processamento adicionais (múltiplas extrações + lógica de comparação de histograma/variância) para uma funcionalidade que o próprio plano trata como default substituível pelo usuário na Fase 04 — não há requisito que justifique esse investimento agora.

**Recommendation:** **Option A (frame em offset relativo, ex. 10% da duração)** — melhor equilíbrio: evita o problema comum de frame preto da Option B a custo quase zero (a duração já está disponível do mesmo job ffprobe de TD-04), sem a complexidade adicional da Option C para uma feature que a Fase 04 já torna substituível pelo usuário.

**Decision:** Option A (frame em offset relativo, ex. 10% da duração). Evita o problema do frame preto e garante uma thumbnail.

**Impact on Implementation:** Etapa do job do worker (TD-04): calcular `offset = max(1, duration * 0.1)` segundos, extrair frame único, salvar em `videos/{videoId}/thumbnail.jpg` (TD-03).

**Risks & Mitigation:** Vídeos muito curtos (ex. < 2s) podem ter `offset` calculado além da duração real — mitigar com clamp (`min(offset, duration - 0.1)`). Vídeos sem stream de vídeo (áudio puro com extensão de vídeo) fazem a extração de thumbnail falhar — tratado como falha de processamento (TD-09), não como caso especial de thumbnail.

---

## TD-06: Estratégia de Streaming com Suporte a Range / 206 Partial Content

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** `docs/diagrams/software-arch.mermaid` declara explicitamente `Rel(frontend, storage, "Streams", "HTTPS")` — o frontend consome vídeo diretamente do Object Storage, não via proxy da API. Isso é decisivo para esta decisão: dado que TD-03 já define GET pré-assinado como mecanismo de leitura, a pergunta real é se o cliente acessa o storage diretamente (herdando suporte nativo a Range/206) ou se a API atua como proxy (obrigando a reimplementar Range/206 manualmente).

**Options:**

### Option A: Cliente acessa o storage diretamente via URL pré-assinada (GET)
- A API apenas emite uma URL pré-assinada (TD-03) para o objeto do vídeo; o elemento `<video>` do cliente aponta seu `src` diretamente para essa URL no MinIO/S3. Suporte a `Range`/206 é comportamento nativo do protocolo `GetObject` do S3 — nenhum código customizado na API NestJS.
- **Pros:** Zero implementação de Range/206 na API (correção "de graça", herdada do protocolo). Bate exatamente com `Rel(frontend, storage, "Streams", "HTTPS")` do C4. API sai do caminho de dados de reprodução — sem gargalo de banda no processo Node.js para cada segundo assistido de cada vídeo.
- **Cons:** URL pré-assinada tem TTL — sessões de visualização muito longas podem exigir que o frontend busque uma nova URL (detalhe de implementação de frontend, fora de escopo desta fase).

### Option B: API como proxy de streaming
- Endpoint NestJS (`GET /videos/:id/stream`) lê o objeto do storage via SDK (repassando o header `Range` recebido como parâmetro `Range` do `GetObject`) e retorna como `StreamableFile`, setando manualmente `Content-Range`/`Accept-Ranges`/206.
- **Cons:** Todo byte reproduzido atravessa o processo da API — anti-padrão de escala para uma plataforma de vídeo, e contradiz diretamente o relacionamento `frontend → storage` do C4. Há um issue conhecido do próprio NestJS (`nestjs/nest#14873`) reportando bugs de `StreamableFile` com Range em iOS — risco de implementação adicional sobre o descompasso arquitetural.

### Option C: URL pública permanente, sem assinatura (bucket/objeto com ACL pública)
- Objetos servidos por URL estável, sem expiração.
- **Cons:** Torna todo objeto público no instante em que existe no bucket — inclusive vídeos ainda em `draft`/`processing`/`error` (TD-08), sem mecanismo de revogação. Conflita implicitamente com o ciclo de status: um vídeo em `processing` não deveria ser servível.

**Recommendation:** **Option A (acesso direto via URL pré-assinada)** — a única opção consistente com a arquitetura já documentada no C4 (`frontend → storage: Streams, HTTPS`), e obtém corretude de Range/206 de graça a partir do protocolo S3 em vez de reimplementá-la (com seus casos de borda) dentro do NestJS.

**Decision:** Option A (acesso direto via URL pré-assinada). Consistencia com a arquitetura documentada no C4

**Impact on Implementation:** Endpoint da API para obter a URL de reprodução de um vídeo `ready` retorna a URL pré-assinada (TD-03), não um stream. Nenhum código de parsing de `Range` necessário na API.

**Risks & Mitigation:** Expiração da URL pré-assinada durante reprodução longa — mitigar com TTL generoso (ex. 6h) suficiente para cobrir uma sessão de visualização típica; renovação fica a cargo do frontend em fase futura. Vazamento de URL pré-assinada permite acesso por terceiros até a expiração — aceitável neste estágio dado que vídeos publicados são, por natureza do produto, assistíveis por usuários anônimos (`docs/project-plan.md`: "Usuários anônimos podem assistir livremente").

---

## TD-07: Estratégia de URL Única por Vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Todas as entities já existentes no projeto (`User`, `Channel`, `RefreshToken`, `VerificationToken` — ver `docs/decisions/technical-decisions-phase-02-auth.md`, seção Data Model) usam `id: uuid, PK, generated` como padrão estabelecido. A pergunta é se o vídeo segue o mesmo padrão ou introduz um identificador público separado.

**Options:**

### Option A: Reaproveitar o UUID (PK) do registro de vídeo como identificador público
- A URL do vídeo usa diretamente `video.id` (uuid gerado pelo Postgres/TypeORM), sem coluna de slug separada.
- **Pros:** Consistente com o padrão já estabelecido em todas as entities da Fase 02. Nenhuma lógica de colisão/retry necessária (diferente do nickname de canal — TD-10 da Fase 02 — que precisa de retry por operar sobre um valor derivado de texto livre; UUID v4 tem colisão desprezível por construção). Mesmo valor serve como chave de storage (TD-03), unificando "identificador de URL" e "chave de objeto".
- **Cons:** UUIDs são longos (36 caracteres) e não têm apelo de legibilidade — irrelevante para os requisitos declarados (nenhuma menção a "vanity URL" no plano).

### Option B: Identificador curto separado (NanoID) em coluna própria
- Coluna `slug` adicional gerada com NanoID (ex. 12-21 caracteres, alfabeto URL-safe), independente da PK interna.
- **Pros:** URLs mais curtas/amigáveis.
- **Cons:** Coluna e índice único extras. Exige a mesma lógica de verificação/retry em colisão que o nickname de canal já precisou implementar (baixíssima probabilidade, mas não nula, exigindo tratamento). Nenhum requisito do plano pede URLs curtas — introduziria complexidade sem necessidade declarada.

### Option C: Identificador sequencial (auto-increment)
- **Rejeitada:** todas as entities do projeto usam UUID como PK (nenhum precedente de auto-increment no schema atual); IDs sequenciais são enumeráveis/adivinháveis — indesejável para vídeos `unlisted` (Fase 04, "acessível somente via link").

**Recommendation:** **Option A (reaproveitar o UUID da PK)** — consistente com o padrão de identificador já estabelecido em todas as entities do projeto (rastreável a `phase-02-auth/TD` Data Model), sem lógica de colisão adicional (diferente do nickname), e o mesmo valor já serve como chave de storage em TD-03 — nenhuma tabela ou coluna extra de mapeamento necessária.

**Decision:** A (reaproveitar o UUID da PK) — mesmo padrão já usado em `User`, `Channel`, `RefreshToken` e `VerificationToken` (Fase 02), sem lógica de colisão adicional e reaproveitando o mesmo valor como chave de storage (TD-03).

**Impact on Implementation:** Nenhuma coluna extra na entity de vídeo além da PK `id: uuid`. Rotas públicas usam `:id` diretamente (ex. `GET /videos/:id`).

**Risks & Mitigation:** Nenhum risco de colisão prático (UUID v4). Único cuidado: garantir que o `id` seja gerado no momento da criação do registro `draft` (TD-08) — antes do upload começar — já que TD-03 usa esse mesmo valor como prefixo de chave de storage desde o início do fluxo.

---

## TD-08: Ciclo de Status do Vídeo — draft, processing, ready, error

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O plano exige "pré-cadastro automático do vídeo como rascunho ao iniciar o upload" e processamento automático após o upload — implicando uma máquina de estados: `draft` (registro criado, upload em andamento/concluído, processamento não iniciado) → `processing` (job de worker em execução) → `ready` (processado com sucesso) ou `error` (falha — TD-09). O projeto já tem um precedente direto de coluna enum de status: `VerificationToken.type` (`docs/decisions/technical-decisions-phase-02-auth.md`, Data Model) — `enum` nativo do PostgreSQL.

**Options:**

### Option A: Coluna única `status` (enum nativo PostgreSQL: `draft | processing | ready | error`)
- Um enum Postgres, transições de estado validadas na camada de serviço (não no banco).
- **Pros:** Consistente com o precedente já estabelecido (`VerificationToken.type`). Estado sempre consistente — impossível representar combinações inválidas (ex. "pronto e com erro" simultaneamente). Índice simples sobre uma única coluna para queries por status.
- **Cons:** Nenhuma modelagem nativa de histórico de transições (quando cada mudança ocorreu) — se necessário no futuro, exigiria uma tabela de auditoria separada (fora do escopo declarado desta fase).

### Option B: Múltiplas colunas booleanas (`is_processed`, `has_error`, `is_uploaded`, ...)
- **Rejeitada:** permite estados inválidos/contraditórios sem constraint (ex. `is_processed=true` e `has_error=true` juntos), exigindo validação de aplicação redundante que uma única coluna enum já torna impossível por construção. Sem ganho correspondente sobre a Option A.

### Option C: Enum + tabela de histórico de transições (`video_status_history`)
- Estende a Option A com uma tabela de auditoria de cada mudança de status.
- **Cons:** Nenhuma capability do plano da Fase 03 pede histórico/auditoria de status visível ao usuário ou ao sistema — over-engineering para um requisito não declarado. Pode ser adicionado depois sem migração destrutiva caso surja essa necessidade.

**Recommendation:** **Option A (coluna única `status`, enum nativo PostgreSQL)** — segue diretamente o precedente já estabelecido no projeto (`VerificationToken.type`), elimina estados inconsistentes por construção (ao contrário da Option B), e não introduz modelagem de auditoria não requisitada pelo plano (ao contrário da Option C).

**Decision:** Option A (coluna única `status`, enum nativo PostgreSQL). Por ser mais simples e não precisar de modelagem de auditoria.

**Impact on Implementation:** Coluna `status` na entity de vídeo (enum Postgres `'draft' | 'processing' | 'ready' | 'error'`, default `'draft'`). Transições: criação do registro → `draft`; job de worker iniciado (consumido da fila) → `processing`; job concluído com sucesso → `ready`; job falho após esgotar retries (TD-09) → `error`.

**Risks & Mitigation:** Corrida entre múltiplas tentativas do mesmo job (retry) tentando transicionar o status concorrentemente — mitigar fazendo o worker atualizar o status apenas ao final de cada tentativa (sucesso ou falha definitiva), nunca em estados intermediários que outra tentativa concorrente possa sobrescrever.

---

## TD-09: Comportamento em Caso de Falha de Processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Serviço de processamento em segundo plano (filas)"

**Context:** Falhas de processamento são esperadas (arquivo corrompido, codec não suportado, timeout de FFmpeg, falha transitória de rede ao ler/escrever no storage). É preciso decidir a política de retry e o que acontece quando o processamento falha definitivamente. Esta decisão depende de TD-01 (tecnologia de fila), já que o mecanismo de retry é nativo da fila escolhida.

**Options:**

### Option A: Retry automático limitado (ex. 3 tentativas, backoff exponencial) via mecanismo nativo da fila, depois `error`
- Usa `attempts`/`backoff` do BullMQ (se TD-01 = Option A) ou `retryLimit`/`retryDelay` do pg-boss (se TD-01 = Option B) para tentativas automáticas; após esgotadas, o registro do vídeo transiciona para `error` (TD-08) com uma mensagem de erro persistida.
- **Pros:** Resiliente a falhas transitórias (blip de rede no storage, OOM momentâneo do worker) sem intervenção manual. Não mascara falhas permanentes indefinidamente — converge para `error` de forma previsível.
- **Cons:** Falhas permanentes (arquivo genuinamente corrompido) ainda consomem N tentativas de processamento antes de desistir — custo de CPU/tempo previsível e limitado (não ilimitado).

### Option B: Sem retry automático — primeira falha marca `error` imediatamente
- Qualquer exceção no job de processamento transiciona o vídeo direto para `error`, sem nova tentativa automática.
- **Pros:** Mais simples de implementar e raciocinar. Não mascara falhas sistêmicas (ex. bug no worker) atrás de múltiplas tentativas.
- **Cons:** Falhas transitórias legítimas (ex. blip de rede de 2 segundos ao ler do storage) levam um vídeo perfeitamente válido a `error` desnecessariamente, exigindo reprocessamento manual (fora de escopo desta fase, já que não há endpoint de "retry" no plano da Fase 03).

### Option C: Retry automático indefinido (sem limite de tentativas)
- **Rejeitada:** risco real de loop infinito consumindo recursos do worker sobre um arquivo permanentemente malformado — o worker ficaria preso reprocessando o mesmo job para sempre, bloqueando o processamento de outros vídeos na fila (efeito equivalente a "travar o sistema", que o plano explicitamente quer evitar, ainda que no worker em vez da API).

**Recommendation:** **Option A (retry limitado via mecanismo nativo da fila)** — equilibra resiliência a falhas transitórias (rede, OOM momentâneo) contra não mascarar falhas permanentes para sempre (ao contrário da Option C), sem exigir uma UI/endpoint de retry manual não previsto no plano (que a Option B tornaria necessário logo em seguida, na prática). Depende diretamente de TD-01: os parâmetros exatos (número de tentativas, estratégia de backoff) usam a API nativa de retry da tecnologia de fila escolhida.

**Decision:** A (retry limitado via mecanismo nativo da fila, depois `error`) — absorve falhas transitórias (rede, storage, OOM momentâneo) sem intervenção manual e converge para `error` de forma previsível, em vez de reprocessar indefinidamente (Option C) ou desistir sem tolerância a falhas transitórias (Option B).

**Impact on Implementation:** Configuração de tentativas/backoff no registro do job, usando o mecanismo nativo da tecnologia de fila escolhida em TD-01. Nova coluna na entity de vídeo para armazenar a mensagem de erro, populada apenas na transição final para `error` — tipo e nulidade exatos ficam para a etapa de implementação (convenções TypeORM já estabelecidas no projeto).

**Risks & Mitigation:** Erros genéricos ("Internal processing error") sem detalhe suficiente para debugging — mitigar exigindo que o worker capture e persista a mensagem de erro real (stderr do ffmpeg/ffprobe, mensagem da exception), não um texto fixo genérico. Objeto já enviado ao storage antes da falha (ex. upload ok, ffprobe falha) fica órfão — mitigar reaproveitando a mesma lifecycle policy de limpeza mencionada em TD-02 (ou exclusão explícita do objeto original ao marcar `error`, a definir na implementação).

---

## TD-10: Implicações para Testes e Docker Compose

**Scope:** Backend

**Capability:** Transversal — covers todas as capabilities da Fase 03 (infraestrutura habilitadora comum): "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `nestjs-project/CLAUDE.md` já estabelece um precedente explícito para a Fase 02: testes de integração rodam contra infraestrutura real dentro do Docker Compose (`mail.service.integration-spec.ts` testa contra o Mailpit real, não um mock), e a convenção de execução de testes é fixa: `docker compose exec nestjs-api npm test -- --runInBand`. A Fase 03 adiciona MinIO, uma fila (TD-01) e um container de worker (TD-04) com dependência de binários FFmpeg — é preciso decidir se essa mesma convenção se estende ou se um novo caminho de teste é necessário.

**Options:**

### Option A: Estender a imagem/Dockerfile única existente; testes continuam via `docker compose exec nestjs-api`
- `compose.yaml` ganha os serviços `minio`, `redis` (se TD-01 = BullMQ) e `video-worker` (reaproveitando a mesma imagem/Dockerfile.dev de `nestjs-api`, comando diferente — TD-04 Option A). O binário `ffmpeg` é instalado no `Dockerfile.dev` compartilhado. Testes de integração relacionados a vídeo (upload contra MinIO real, job de fila real, ffprobe/ffmpeg reais sobre fixtures de poucos KB) continuam rodando via `docker compose exec nestjs-api npm test -- --runInBand`, sem novo comando.
- **Pros:** Consistente com o precedente já estabelecido (infra real, não mock) e com a convenção de execução de testes já fixada em `nestjs-project/CLAUDE.md` — nenhuma nova convenção de comando a documentar/lembrar. Segue diretamente de TD-04 Option A (mesma imagem para API e worker).
- **Cons:** Imagem do `nestjs-api` carrega o binário `ffmpeg` mesmo não o invocando diretamente (mesmo trade-off já aceito em TD-04). Testes de processamento de vídeo ficam mais lentos que testes puramente unitários (processos reais de ffmpeg/ffprobe, upload real ao MinIO) — mitigável usando fixtures de vídeo pequenas (segundos de duração, poucos KB), nunca arquivos de teste próximos a 10GB.

### Option B: Dockerfile separado para o worker; testes do worker rodam via `docker compose exec video-worker`
- Segue de TD-04 Option B (subprojeto separado) ou de uma Option A com Dockerfile distinto por serviço.
- **Cons:** Fragmenta a convenção de execução de testes em dois comandos (`nestjs-api` vs `video-worker`) dependendo de qual código está sendo testado — nova convenção a documentar e memorizar, ausente hoje em `nestjs-project/CLAUDE.md`. Duplica instalação de dependências (ex. `ffmpeg`) entre dois Dockerfiles.

### Option C: Mockar FFmpeg/ffprobe e MinIO/fila inteiramente em todos os testes automatizados
- Nenhum teste toca binários reais ou storage real; apenas testes manuais/exploratórios usariam o MinIO real.
- **Rejeitada:** contradiz diretamente o precedente já estabelecido no projeto (Mailpit real em `mail.service.integration-spec.ts`, não mockado) e a própria definição de `*.integration-spec.ts` em `nestjs-project/CLAUDE.md` ("exercita DB real, repositórios reais, módulos reais") — mockar toda a integração de storage/fila/FFmpeg reintroduziria exatamente o risco que a convenção de testes do projeto já existe para evitar (testes que passam mas divergem do comportamento real de produção).

**Recommendation:** **Option A** — direta continuação do precedente já estabelecido em `nestjs-project/CLAUDE.md` (infraestrutura real em testes de integração, convenção única de comando `docker compose exec nestjs-api`), decorrência natural de TD-04 Option A (mesma imagem para API e worker).

**Decision:** Option A: Estender a imagem/Dockerfile única existente; testes continuam via `docker compose exec nestjs-api`. Consistencia com o que foi decidido no TD-04

**Impact on Implementation:** `nestjs-project/compose.yaml` ganha 3 novos serviços: `minio` (com criação do bucket no boot), `redis` (se TD-01 = BullMQ), `video-worker` (mesma imagem de `nestjs-api`, `depends_on: [db, redis, minio]`, comando de bootstrap standalone). `Dockerfile.dev` passa a instalar o binário `ffmpeg` (fornece `ffmpeg` e `ffprobe`). Fixtures de vídeo pequenas (ex. 1-3s, poucos KB, formato mp4/webm) versionadas em `nestjs-project/test/fixtures/` para uso em specs de integração/e2e do pipeline de processamento.

**Risks & Mitigation:** Tempo de `docker compose up` e de build da imagem aumenta (instalação de `ffmpeg` + mais serviços) — aceitável dado que já é o padrão do projeto adicionar serviços incrementalmente por fase (Mailpit foi adicionado na Fase 02 do mesmo jeito). Testes de integração de processamento de vídeo tornam a suíte mais lenta — mitigar mantendo fixtures de vídeo propositalmente minúsculas e reservando a suíte `*.e2e-spec.ts` (mais lenta, já rodada separadamente via `npm run test:e2e`) para os cenários de pipeline completo, seguindo a mesma separação unit/integration/e2e já convencionada no projeto.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de Fila | A (BullMQ + `@nestjs/bullmq`, Redis) | **A** |
| TD-02 | Backend | Estratégia de Upload de 10GB sem Travar a API | A (S3 Multipart Upload com URLs pré-assinadas) | **A** |
| TD-03 | Backend | Object Storage — Buckets, Chaves, Upload e Download | A (bucket único, chaves prefixadas por `videoId`; AWS SDK v3) | **A** |
| TD-04 | Backend | Execução do Worker e Processamento FFmpeg/ffprobe | A (mesmo codebase, dois bootstraps/containers; `child_process.spawn` direto) | **A** (ambas as sub-decisões) |
| TD-05 | Backend | Estratégia de Geração de Thumbnail | A (frame único em offset relativo, ex. 10% da duração) | **A** |
| TD-06 | Backend | Streaming com Range/206 Partial Content | A (cliente acessa storage diretamente via URL pré-assinada) | **A** |
| TD-07 | Backend | Estratégia de URL Única por Vídeo | A (reaproveitar UUID da PK) | **A** |
| TD-08 | Backend | Ciclo de Status — draft/processing/ready/error | A (coluna única `status`, enum nativo PostgreSQL) | **A** |
| TD-09 | Backend | Comportamento em Falha de Processamento | A (retry automático limitado via mecanismo nativo da fila, depois `error`) | **A** |
| TD-10 | Backend | Implicações para Testes e Docker Compose | A (estender imagem/Dockerfile existente; testes via `docker compose exec nestjs-api`) | **A** |
