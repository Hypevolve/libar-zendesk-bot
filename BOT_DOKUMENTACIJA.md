# Libar Bot Dokumentacija (Kanonska)

Datum uskladjenja: 29.04.2026
Status: aktivno, uskladjeno s kodom u `index.js`, `services/*` i `public/*`

## Svrha sustava

Libar bot je Zendesk-first middleware za korisnicku podrsku Antikvarijata Libar.

Sustav pokriva:
- web chat widget (`/chat`, `/embed/chat`)
- webhook automaciju za email i Facebook tok kroz Zendesk
- knowledge retrieval iz Zendesk Help Centera, OneDrive i opcionalno vektorskog sloja
- strogo policy-gated odgovaranje (safe answer, clarifying question, handoff)

## Arhitektura

## Backend

Glavni entrypoint je `index.js` (Express server).

Kljucevi slojevi:
- Session/lifecycle orchestration preko Zendesk ticketa
- Retrieval orchestration (`knowledgeService`)
- Policy routing i fallback guardovi
- Channel-aware customer copy (web chat / email / facebook)
- Runtime persist in-memory stanja (`runtimeStore`)

## Servisi

- `services/zendeskService.js`: Zendesk ticket/audit/help-center API
- `services/knowledgeService.js`: merge OneDrive + vector + Zendesk knowledge
- `services/oneDriveService.js`: OneDrive/SharePoint retrieval + cache
- `services/vectorKnowledgeService.js`: Supabase vector retrieval i sync
- `services/aiService.js`: grounded answer generation i model fallback
- `services/siteLinkService.js`: canonical website link fallback
- `services/spamFilterService.js`: email spam filter
- `services/metricsService.js`: runtime brojac metrike
- `services/productFeedService.js`: query preprocessing i legacy product metadata support

## Frontend

- `public/chat.html`, `public/chat.js`, `public/chat.css`: widget UI i client flow
- `public/embed.js`: WordPress/third-party embed launcher + iframe shell

## Source of truth i perzistencija

Primarni source of truth je Zendesk ticket.

Lokalni runtime state je dodatni sloj:
- `chatSessions` (in-memory)
- `processedWebhookAudits` (idempotency cache)
- `recentChatStarts` (start dedupe cache)
- persist/hydrate kroz `runtimeStore` (`.runtime` datoteke)

Sustav nema zasebnu aplikacijsku bazu podataka.

## Kanali

## Web chat

Web chat API upravlja ticketom od starta do resolve flowa.

Bitno trenutno stanje:
- Start forma trazi obavezno samo `message`
- `name` i `email` su opcionalni
- Ako je `email` poslan, mora biti validan
- Linkovi u porukama se renderiraju kao klikabilni
- Privitci odmah guraju ticket u handoff (`attachments_present`)

## Email

Email automation ide preko `/webhook/zendesk`.

Specificno:
- primjenjuje se spam filter prije AI odgovora
- quoted/forwarded parsing ostaje u Zendesk -> normalized poruka
- ako nije siguran odgovor, ide handoff

## Facebook

Facebook tok ide preko `/webhook/zendesk`.

Specificno:
- channel-specific copy (kraci, chat-like)
- idempotency preko audit ID cachea

## Decision pipeline

`resolveAutomatedOutcome(session, userMessage, { hasAttachments, channelType })` radi ovim redom:

1. Route/context hydration
2. Policy pre-check (`buildPolicyOutcome`)
3. Retrieval (`knowledgeService.searchKnowledgeDetailed`)
4. Grounded AI odgovor (ako postoji quality kontekst)
5. Knowledge fallback odgovor (deterministicki)
6. No-context autonomous fallback (`buildNoContextAutonomousOutcome`)
7. Hard handoff (`no_answer_found`) ako nista nije sigurno

## Outcome tipovi

- `safe_answer`
- `ask_clarifying_question`
- `hard_handoff`
- `soft_handoff` (koristi se kroz quality gate odluku)

## State tagovi (ticket/web state)

- `ai_active`
- `awaiting_customer_detail`
- `awaiting_human`
- `resolved`

UI tone map:
- `ai-active`
- `awaiting-customer-detail`
- `awaiting-human`
- `human-active`
- `resolved`

## Aktualna policy pravila (bitna za routing)

## Product lookup

Trenutni customer-facing model je webshop guidance:
- `purchase_search_guidance` usmjerava na `/kupi-udzbenike/`
- bot daje uputu za pretragu (sifra, ISBN, naslov, autor, nakladnik)
- heuristike aktivno smanjuju product bleed iz support konteksta

## Buyback

Podrzani fast-path outcomei:
- `online_buyback_guidance`
- `buyback_package_guidance`
- `buyback_accepted_books_guidance`
- `buyback_bonus_guidance`
- `buyback_price_guidance`
- `buyback_delivery_exchange_guidance` (predaja knjiga dostavljacu pri isporuci narudzbe)

## Order/reklamacija

Podrzani fast-path outcomei:
- `order_issue_clarification`
- `order_merge_guidance`

## Conversation quality fixevi (29.04.2026)

Dodani guardovi i intent detektori:
- positive feedback detekcija (`positive_feedback_acknowledgement`)
- contact-details-only detekcija (`contact_details_without_intent`)
- feasibility follow-up detekcija (`followup_without_context`)
- explicit domain correction (`ne radi se o ... nego ...`)
- bolji prioritet order signala iznad buyback/product za mixed correction poruke

## Web chat lifecycle

## Start (`POST /api/chat/start`)

Ulaz:
- `message` obavezno
- `name` opcionalno
- `email` opcionalno (ako je poslan, validacija)
- `entryIntent`, `entryPromptAnswer`, `entryFlowVersion` opcionalno
- `attachments[]` opcionalno (max 5, max 10MB po fileu)

Ponasanje:
- start dedupe radi samo ako postoji identitet (`name` ili `email`)
- anonimni start ne ulazi u identitet-based dedupe
- ako `name`/`email` fale, backend koristi fallback requester identitet za Zendesk ticket

## Restore (`POST /api/chat/restore`)

Ulaz:
- `ticketId` + `requesterId` obavezni

Izlaz mode:
- `active_session`
- `closed_session`

Kad Zendesk privremeno nije dostupan, moze vratiti `degraded: true` ako postoji lokalna session kopija.

## Message (`POST /api/chat/message`)

Ulaz:
- `sessionId` obavezno
- `message` ili barem jedan privitak

Ako je ticket vec `solved/closed`, vraća 409 i `conversationState.resolved`.

## Resolve (`POST /api/chat/resolve`)

Ulaz:
- `sessionId`
- `confirmed` (boolean)

Ponasanje:
- `confirmed=true` i validan prompt -> solve ticket
- `confirmed=false` -> razgovor ostaje otvoren, prompt se gasi

## Session read

- `GET /api/chat/session/:sessionId`
- `GET /api/chat/stream/:sessionId` (SSE)

## Zendesk webhook lifecycle

## `POST /webhook/zendesk`

Glavni automation webhook:
- normalizira payload envelope
- radi audit idempotency cache
- blokira automation kad je thread human-managed ili resolved
- primjenjuje spam filter na emailu
- pokrece `resolveAutomatedOutcome`
- upisuje customer reply + internal note + state tag

## `POST /webhook/zendesk/events`

Event webhook za ticket status/state sinkronizaciju prema aktivnim web sessionima.

Zahtijeva validan `x-zendesk-webhook-token`.

## Entry flow (web)

Aktivna verzija: `v1`

Podrzani `entryIntent`:
- `kupnja_knjiga`
- `narudzba`
- `dostava`
- `otkup_knjiga`
- `reklamacija_problem`
- `opci_upit`

Entry flow kontekst ulazi u:
- retrieval hints
- internal note
- inicijalni routing signal

## Spam filter (email)

Spam filter se primjenjuje samo na email kanalu.

Model je dvoslojan:
- heuristika
- AI klasifikacija za granicne slucajeve

Ako je oznaceno kao spam:
- nema AI odgovora korisniku
- ticket dobiva interni note i spam oznaku

## Knowledge sloj

`knowledgeService` spaja tri izvora paralelno:
- vector hits (ako je konfigurirano)
- OneDrive lexical hits
- Zendesk Help Center hits

Merge pravilo:
- sort po score
- tie-break favorizira OneDrive entry
- top `KNOWLEDGE_CONTEXT_ITEMS` ulazi u AI context

## Konfiguracija

Minimalno za pokretanje:
- Zendesk env (`ZENDESK_*`)
- OpenRouter key (`OPENROUTER_API_KEY`)

Model fallback:
- primary: `openai/gpt-5`
- fallback: `google/gemini-2.5-pro`

Dodatno opcionalno:
- OneDrive (`ONEDRIVE_*`)
- Supabase vector (`SUPABASE_*`, embedding env)
- `ADMIN_TOKEN` za admin endpointe

Referenca svih env varijabli: `.env.example`

## Health i admin endpointi

- `GET /embed.js` (static loader za iframe embed)
- `GET /health`
- `POST /admin/cache/knowledge/refresh?token=...`
- `POST /admin/vector/knowledge/sync?token=...`
- `GET /debug/zendesk/:ticketId?token=...`

## Sigurnosni i operativni guardovi

- rate limit na web chat API rutama
- webhook idempotency (audit cache)
- chat start dedupe prozor (`CHAT_START_DEDUPLICATION_TTL_MS`)
- attachment hard handoff
- anti-leak odgovor quality check

## Test status

Automatizirani test suite je trenutni gate za regresije.

Core komande:
- `npm test`
- `npm run report:regression`
- `npm run report:real-queries`

## Poznata ogranicenja

- nema trajne aplikacijske baze; runtime cache je process-local
- fallback requester identitet za anonimne chat startove je tehnicki identitet, ne verifikacija korisnika
- policy je namjerno konzervativan i radije eskalira nego da daje nesiguran odgovor
