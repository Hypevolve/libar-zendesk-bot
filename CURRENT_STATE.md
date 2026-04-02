# Trenutno Stanje Libar Chatbota

**Datum dokumentacije:** 2. travnja 2026.

## Sažetak

Libar chatbot je trenutno implementiran kao **Zendesk-first support middleware** za Antikvarijat Libar. Sustav spaja web chat widget, Node.js backend, Zendesk Support i Zendesk Help Center, te koristi LLM preko OpenRoutera za kontrolirani AI autopilot.

Bot trenutno nije zamišljen kao potpuno autonoman agent. Primarna logika je:

- odgovori odmah samo kad postoji dovoljno jak i siguran kontekst iz baze znanja
- osjetljive, nejasne ili attachment-based upite preusmjeri ljudima
- cijeli razgovor i status razgovora ostanu vezani uz Zendesk ticket

Sustav trenutno **nema dodatnu bazu podataka**. Perzistencija se oslanja na:

- Zendesk ticket kao glavni izvor istine
- requester identitet
- browser snapshot u `localStorage`
- kratkotrajni in-memory session map na serveru

## 1. Pregled Sustava

### Glavne komponente

- **Frontend chat widget** na `/chat`
- **Node.js + Express backend**
- **Zendesk Support** kao source of truth za ticket, transcript i lifecycle
- **Zendesk Help Center** kao trenutna knowledge base baza
- **OpenRouter / LLM** za AI odluke i generiranje odgovora

### Tehnološki stack

- `express`
- `multer`
- `axios`
- `openai` SDK prema OpenRouter API-ju
- plain HTML / CSS / JavaScript frontend bez dodatnog frameworka

### Opći arhitekturni model

- frontend razgovara s lokalnim backendom
- backend otvara i ažurira Zendesk ticket
- backend dohvaća kontekst iz Zendesk Help Centera
- backend traži AI odluku i zatim sam odlučuje kako se ticket ažurira
- frontend transcript nakon otvaranja sessiona koristi Zendesk kao kanonski izvor poruka

## 2. Kako Razgovor Funkcionira

### Onboarding flow

Prije otvaranja Zendesk ticketa widget vodi kratak onboarding unutar istog chata:

1. korisnik napiše prvu poruku
2. bot traži ime
3. bot traži email
4. tek tada backend otvara Zendesk ticket

Nakon uspješnog otvaranja ticketa, frontend prelazi s lokalnog onboarding statea na Zendesk-backed session.

### Aktivni AI chat flow

Kad session već postoji:

1. korisnička poruka ide u Zendesk ticket kao public comment
2. backend sinka transcript iz Zendeska
3. backend dohvaća najrelevantnije članke iz Zendesk Help Centera
4. AI sloj vraća strukturiranu odluku:
   - `safe_answer`
   - `soft_handoff`
   - `hard_handoff`
5. backend prema toj odluci:
   - ažurira state tagove
   - po potrebi zapisuje eskalaciju
   - dodaje AI public reply
   - dodaje internal note s autopilot sažetkom

### Human takeover

Kad agent odgovori iz Zendesk korisničkog sučelja:

- transcript se pri sljedećem syncu prepoznaje kao ljudski odgovor
- conversation state prelazi u `human-active`
- frontend prikazuje `Podrška uživo`
- nakon takeovera AI više ne odgovara
- korisničke poruke nastavljaju ići u isti Zendesk ticket, ali backend ih tada tretira kao **Zendesk pass-through**

### Resolution flow

Ako korisnička zadnja poruka izgleda kao signal da je problem riješen, sustav može prikazati resolution prompt:

- `Je li sve u redu?`
- `Da, riješeno je`
- `Ne, trebam još pomoć`

Ticket se ne zatvara automatski samo na temelju jedne poruke. Tek kad korisnik eksplicitno potvrdi, backend postavlja Zendesk ticket na `solved`.

## 3. Knowledge Base i AI Sloj

### Trenutna baza znanja

Trenutna knowledge base je **isključivo Zendesk Help Center**.

Bot trenutno ne koristi:

- OneDrive
- SharePoint
- vanjske dokumente
- dodatnu vektorsku bazu

### Retrieval model

Backend za svaki relevantni AI upit:

- dohvaća puni Help Center corpus iz Zendeska
- kratkotrajno ga cacheira u memoriji
- radi lokalni lexical ranking
- deduplicira slične članke
- uzima najbolje rezultate i slaže kontekst za AI

U kontekst ulaze:

- naslov članka
- lokalna relevantnost
- skraćeni sadržaj članka

### AI guardrails

AI sloj koristi strogi system prompt i strukturirani JSON output. Model mora vratiti:

- `safe_answer`
- `soft_handoff`
- `hard_handoff`

Ako model vrati neispravan ili nečitljiv output:

- backend ne ruši chat
- fallback odluka postaje `soft_handoff`

### Sigurnosna pravila

Bot ne koristi vanjsko znanje. Odgovori trebaju biti utemeljeni isključivo na dostavljenom kontekstu iz trenutne baze znanja.

Automatska eskalacija prema čovjeku se pokreće kad:

- postoje attachmenti
- tema izgleda osjetljivo ili rizično
- nema dovoljno jakog konteksta iz Help Centera
- model označi upit kao handoff

### Napomena o budućim izvorima

**OneDrive / SharePoint integracija trenutno nije dio aktivnog sustava.** To je planirana moguća sljedeća faza.

## 4. Zendesk Integracija i Source-of-Truth Pravila

### Zendesk kao glavni izvor istine

Zendesk ticket je glavni zapis razgovora. Backend se na njega oslanja za:

- transcript
- requester identitet
- status ticketa
- lifecycle tagove
- ljudski takeover

### Što backend upisuje u ticket

Backend može u ticket upisivati:

- customer public comments
- AI public replies
- internal notes za autopilot outcome
- lifecycle tagove i conversation state tagove

Najvažniji conversation stateovi su:

- `ai-active`
- `awaiting-human`
- `human-active`
- `resolved`

### Transcript sync

Transcript se više ne gradi samo iz `comments.json`, nego iz **Zendesk audits** feeda.

To omogućuje točnije mapiranje poruka jer backend koristi:

- audit metadata
- author/channel fallback
- razlikovanje AI odgovora i agent odgovora

Role mapping se koristi za:

- lijevo/desno poravnanje poruka
- oznaku `Podrška` vs `Podrška uživo`
- takeover logiku

### Restore politika

Kad se korisnik vrati u chat:

- `new`, `open`, `pending`, `hold` => nastavlja postojeći razgovor
- `solved`, `closed` => chat ide u read-only pregled prethodnog razgovora i nudi novi chat

To znači da se solved/closed ticket ne nastavlja kao aktivni session.

## 5. Frontend Widget i UX Ponašanje

### Transcript model

Frontend `/chat` koristi dva različita režima:

- **lokalni onboarding** prije otvaranja ticketa
- **Zendesk-first transcript** nakon otvaranja sessiona

Nakon što session postoji, frontend više ne tretira lokalni transcript kao glavni izvor istine. Server poruke iz Zendeska postaju kanonske.

### Optimistic poruke

Kad korisnik pošalje novu poruku u aktivnom sessionu:

- frontend može odmah prikazati optimistički bubble
- taj bubble je samo privremeni overlay
- čim stigne server response ili session refresh, transcript se ponovno renderira iz kanonskog session statea

### Trenutne UX mogućnosti

- attachment preview prije slanja
- uklanjanje attachmenta prije slanja
- prikaz attachmenta unutar poruke
- image thumbnail preview
- unread badge na launcheru
- typing indicator
- SSE stream za real-time update
- polling fallback
- closed-session panel za završene razgovore
- resolution prompt za korisničku potvrdu rješenja

### Closed session UX

Kad je ticket solved/closed:

- transcript ostaje vidljiv
- composer se skriva / gasi
- korisnik može pregledati prethodni razgovor
- korisnik može pokrenuti novi razgovor

## 6. Javni Endpointi i Integracije

### Chat API

- `POST /api/chat/start`
  - otvara Zendesk-backed session nakon onboardinga
- `POST /api/chat/message`
  - šalje novu poruku ili attachment u postojeći session
- `POST /api/chat/restore`
  - pokušava obnoviti razgovor iz browser snapshot podataka
- `POST /api/chat/resolve`
  - obrađuje korisničku potvrdu da je problem riješen
- `GET /api/chat/session/:sessionId`
  - vraća sinkani aktivni session
- `GET /api/chat/stream/:sessionId`
  - otvara SSE stream za live update

### Webhook endpointi

- `POST /webhook/zendesk/events`
  - prima Zendesk event webhook i broadcasta session update prema frontendima
- `POST /webhook/zendesk`
  - stariji / dodatni webhook flow za obradu poruke i shadow-mode AI ponašanje

### Ostalo

- `GET /health`
  - health check endpoint
- `GET /chat`
  - servira chat widget
- `GET /debug/zendesk/:ticketId`
  - pomoćni debug endpoint za provjeru pristupa ticketu

## 7. Konfiguracija i Ovisnosti

### Glavne konfiguracijske grupe

#### Zendesk

- subdomain
- agent email
- API token
- webhook token

Zendesk konfiguracija pokriva:

- ticket create/update
- uploads
- comments / audits
- Help Center retrieval
- webhook verification

#### OpenRouter / AI

- API key
- model
- optional site URL / title headers

#### Retrieval tuning

- Help Center cache TTL
- broj članaka koji ulaze u AI context

#### Server

- `PORT`

### Vanjske ovisnosti

- `express` za HTTP server i API
- `multer` za upload attachmenta
- `axios` za Zendesk API komunikaciju
- `openai` SDK za OpenRouter integraciju

## 8. Trenutna Ograničenja i Poznate Napomene

### Trenutna ograničenja

- knowledge base je samo Zendesk Help Center
- nema zasebne baze podataka
- aktivni sessioni se drže i u memoriji procesa
- transcript točnost ovisi o dostupnosti i konzistentnosti Zendesk audits feeda
- OneDrive / SharePoint još nije integriran
- retrieval je lexical, ne embedding-based

### Operativne napomene

- ako Zendesk audit ili webhook podaci ne stignu kako treba, transcript i state ovise o sljedećem syncu
- AI sloj je strogo ograničen guardrailima i namjerno češće eskalira kad nije siguran
- attachment-based razgovori automatski idu na ljudsku provjeru

### Sljedeći logični koraci

- OneDrive / SharePoint kao dodatni knowledge source
- jači monitoring i observability
- bolji admin/debug alati
- po potrebi trajna perzistencija session statea u nekoj budućoj fazi

## 9. Kratki Operativni Sažetak

Trenutni bot je produkcijski-orijentiran middleware sloj između web chata i Zendeska. Najvažnija karakteristika sustava je da **Zendesk ostaje glavni izvor istine**, dok AI služi kao kontrolirani prvi odgovor i routing sloj. Sustav je trenutno dovoljno razvijen za ozbiljniji support flow, ali je knowledge base još uvijek ograničen na Zendesk Help Center i zato su dodatni izvori znanja, poput OneDrivea, logičan sljedeći korak.
