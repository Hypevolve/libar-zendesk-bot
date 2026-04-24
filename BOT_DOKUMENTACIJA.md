# Dokumentacija Trenutnog Stanja Libar Chatbota

Datum: 17. travnja 2026.

## Sažetak

Libar chatbot je produkcijski backend i frontend sloj za korisničku podršku koji povezuje:

- web chat widget
- Zendesk Support
- Zendesk Help Center
- OneDrive / SharePoint knowledge base
- OpenRouter LLM sloj

Sustav radi kao Zendesk-centered support middleware. Zendesk ticket je glavni zapis razgovora, a bot koristi objedinjeni knowledge sloj za automatske odgovore kada postoji dovoljno dobar kontekst.

## Glavne funkcionalnosti

Trenutno aktivne funkcionalnosti sustava su:

- web chat widget na `/chat`
- WordPress embed preko `embed.js` i iframe moda
- Zendesk-backed chat sessioni
- AI odgovori iz Zendesk Help Centera i OneDrive / SharePoint knowledge baze
- multi-channel obrada upita za:
  - web chat
  - email
  - Facebook Messenger / Facebook ticket flow kroz Zendesk
- human handoff logika
- resolution flow za web chat
- email spam filter prije AI odgovaranja
- internal note logging za AI outcome i korištene izvore

## Arhitektura

### Backend

Backend je implementiran kao Node.js + Express aplikacija.

Glavne odgovornosti backenda:

- otvaranje i ažuriranje Zendesk ticketa
- sinkronizacija poruka i transcripta
- dohvat knowledge konteksta iz više izvora
- AI decision layer i generiranje odgovora
- channel-aware ponašanje za web chat, email i Facebook
- spam filtering za email kanal
- isporuka chat frontenda i WordPress embeda

### Source of Truth

Zendesk ticket je glavni izvor istine za:

- transcript
- status razgovora
- lifecycle state
- ljudski takeover
- customer-facing i internal note evidenciju

## Aktivni kanali

### 1. Web chat

Web chat radi preko frontenda na:

- `GET /chat`

Podržano ponašanje:

- onboarding unutar widgeta
- prikupljanje imena i emaila prije otvaranja ticketa
- otvaranje backing Zendesk ticketa
- slanje korisničkih poruka u Zendesk
- AI odgovori iz knowledge baze
- human takeover prikaz
- resolution flow i potvrda rješenja
- live transcript refresh preko SSE-a

### 2. Email

Email kanal radi kroz Zendesk trigger + webhook flow.

Podržano ponašanje:

- obrada novih korisničkih email poruka iz Zendesk ticketa
- knowledge retrieval iz Zendesk Help Centera i OneDrive / SharePoint izvora
- AI odgovor kada postoji dovoljno jak kontekst
- handoff ljudskom agentu kada kontekst nije dovoljan
- internal note s prikazom AI outcomea i korištenih izvora
- spam filtering prije retrievala i AI odgovora

### 3. Facebook

Facebook kanal radi kroz Zendesk ticket flow za Facebook poruke.

Podržano ponašanje:

- obrada novih korisničkih Facebook poruka kroz Zendesk ticket
- isti knowledge retrieval kao na web chatu i emailu
- AI odgovor kad je kontekst dovoljan
- handoff agentu kada kontekst nije dovoljan
- internal note s prikazom outcomea i izvora

## Knowledge Base Sloj

Bot koristi objedinjeni knowledge sloj iz dva izvora:

- Zendesk Help Center
- OneDrive / SharePoint dokumenti

### Zendesk Help Center

Bot lokalno dohvaća i kratkotrajno cacheira Help Center corpus te radi lokalni ranking po upitu.

Za svaki relevantni rezultat u kontekst ulazi:

- naslov članka
- relevantnost
- najrelevantniji odlomak / snippet članka

### OneDrive / SharePoint

OneDrive provider radi preko Microsoft Graph API-ja.

Bot dohvaća dokumente iz konfiguriranog SharePoint / OneDrive foldera i koristi ih kao knowledge source.

Podržani formati dokumenata:

- `.txt`
- `.md`
- `.csv`
- `.json`
- `.html`
- `.htm`
- `.docx`

Za svaki dokument bot radi:

- parsiranje sadržaja
- lokalni ranking po korisničkom upitu
- izdvajanje najrelevantnijeg odlomka / snippet konteksta

### Merge i ranking

Knowledge sloj trenutno radi:

- čišćenje korisničkog upita prije pretrage
- lokalni lexical scoring
- opcionalni Supabase `pgvector` semantic search preko OneDrive chunkova
- izdvajanje najrelevantnijih odlomaka umjesto generičkog početka dokumenta
- objedinjeni rerank između Supabase vector, OneDrive lexical i Zendesk izvora
- blagu prednost OneDrive dokumentima pri jednakim scoreovima

Kontekst koji se šalje AI sloju uključuje:

- tip izvora
- naslov izvora
- relevantnost
- sadržaj najrelevantnijeg odlomka

## AI Decision Layer

AI sloj koristi OpenRouter preko OpenAI SDK klijenta. Zadani primarni model je `openai/gpt-5`, a fallback model je `google/gemini-2.5-pro`.

Bot koristi channel-aware promptove za:

- web chat
- email
- Facebook

### Outcome tipovi

AI decision layer vraća jedan od tri outcomea:

- `safe_answer`
- `soft_handoff`
- `hard_handoff`

### Safe answer

Kad je knowledge kontekst dovoljno jak:

- bot generira customer-facing odgovor
- odgovor se upisuje u Zendesk kao public reply
- ticket ostaje u AI-active stanju

### Soft handoff

Kad pitanje nije dovoljno sigurno pokriveno kontekstom:

- bot ne šalje customer-facing AI odgovor
- ticket ide u awaiting-human stanje
- dodaje se internal note s razlogom i korištenim izvorima

### Hard handoff

Kod osjetljivih ili rizičnih tema:

- ticket se odmah prepušta ljudskom agentu
- dodaje se internal note i state update

### Grounded answer fallback

Ako structured decision model vrati `soft_handoff`, a retrieval pokazuje jak OneDrive-driven kontekst, backend radi dodatni fokusirani grounded-answer pokušaj na top izvorima.

To omogućuje da sustav češće isporuči odgovor kada top knowledge izvor jasno pokriva pitanje.

## Query Understanding

Prije retrievala upit prolazi kroz query preprocessing.

To uključuje:

- uklanjanje pozdrava
- uklanjanje filler fraza poput `zanima me`, `molim vas`, `možete li mi reći`
- normalizaciju teksta za stabilniji ranking

To poboljšava matching između prirodno formuliranih korisničkih poruka i knowledge dokumenata.

## Zendesk Ticket Lifecycle

Bot koristi conversation state tagove i transcript logiku u Zendesku.

Aktivni stateovi:

- `ai_active`
- `awaiting_human`
- `human_active`
- `resolved`

### Internal note logging

Za svaki AI decision backend zapisuje internal note koji uključuje:

- kanal
- AI outcome
- korisnički upit
- primarni izvor
- top relevantnost
- korištene izvore
- reason oznaku

### Human takeover

Kad agent preuzme razgovor kroz Zendesk:

- transcript ostaje u istom ticketu
- razgovor se nastavlja kroz Zendesk lifecycle
- state prelazi u ljudski support flow

## Email Spam Filter

Spam filter se primjenjuje samo na email kanal prije glavnog retrieval + AI flowa.

### Heuristički sloj

Filter provjerava:

- broj linkova
- tipične outreach i spam obrasce
- phishing signale
- marketing / SEO pitch obrasce
- support signale u tekstu

### AI classifier sloj

Za granične slučajeve koristi se dodatni AI spam classifier.

Ako je email klasificiran kao spam:

- ne radi se knowledge retrieval
- ne radi se support AI odgovor
- ticket dobiva internal note
- ticket dobiva tag `suspected_spam`

## WordPress Embed

Bot se može ugraditi na WordPress preko:

- `GET /embed.js`
- `GET /embed/chat`

Embed radi kao:

- JS loader
- floating launcher
- iframe chat panel prema chatbot serveru

Podržane embed konfiguracije:

- `baseUrl`
- `position`
- `offsetX`
- `offsetY`
- `zIndex`
- `launcherLabel`
- `theme`

## Frontend Chat Widget

Frontend koristi statične datoteke iz `public/` direktorija.

Glavne značajke widgeta:

- onboarding stanje
- customer / assistant poruke
- attachment upload podrška
- SSE stream za live osvježavanje
- resolution prompt
- embed mode za iframe prikaz

## Aktivni HTTP endpointi

### Javne rute

- `GET /health`
- `GET /chat`
- `GET /embed/chat`
- `GET /embed.js`

### Web chat API

- `POST /api/chat/start`
- `POST /api/chat/restore`
- `POST /api/chat/message`
- `POST /api/chat/resolve`
- `GET /api/chat/session/:sessionId`
- `GET /api/chat/stream/:sessionId`

### Zendesk webhook rute

- `POST /webhook/zendesk`
- `POST /webhook/zendesk/events`

### Admin i debug rute

- `POST /admin/cache/knowledge/refresh`
- `POST /admin/vector/knowledge/sync`
- `GET /debug/zendesk/:ticketId`

Vector sync se može pokrenuti i lokalno/cron naredbom:

- `npm run sync:vector`

## Konfiguracija

Sustav koristi environment-driven konfiguraciju za:

- Zendesk pristup
- OpenRouter primarni/fallback model i autentikaciju
- OpenAI embedding model za Supabase vector knowledge
- Supabase `pgvector` knowledge bazu
- OneDrive / SharePoint pristup
- retrieval tuning
- spam filter tuning
- WordPress embed allowed origins

## Operativni rezultat sustava

U trenutnom stanju bot radi kao objedinjeni support sloj koji:

- prima upite iz više kanala
- koristi Zendesk kao ticket backbone
- odgovara iz kombinirane knowledge baze
- zna razlikovati AI odgovor i handoff
- bilježi AI odluke i izvore u Zendesk internal noteovima
- podržava web widget i WordPress embed distribuciju
