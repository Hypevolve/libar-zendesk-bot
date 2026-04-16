# Email Spam Filter

Datum: 16. travnja 2026.

## Svrha

Email spam filter je uveden kao zaštitni sloj prije glavnog AI odgovaranja na Zendesk email ticketima.

Cilj je:
- smanjiti nepotrebno trošenje knowledge retrieval i AI API poziva
- spriječiti da bot odgovara na spam, outreach ili phishing poruke
- zadržati isti support flow za legitimne korisničke upite

Spam filter se trenutno primjenjuje samo na `email` kanal. Web chat i Facebook nisu uključeni u ovaj filter.

## Gdje se izvršava

Spam filter se izvršava u [index.js](/Volumes/Arien's%20SSD/_KONTRA/libar-zendesk-bot/index.js) unutar `POST /webhook/zendesk` flowa, prije:
- `knowledgeService.searchKnowledgeDetailed(...)`
- `determineChatOutcome(...)`
- glavnog AI support odgovora

Logika filtriranja je izdvojena u [services/spamFilterService.js](/Volumes/Arien's%20SSD/_KONTRA/libar-zendesk-bot/services/spamFilterService.js).

AI klasifikacija graničnih slučajeva koristi [services/aiService.js](/Volumes/Arien's%20SSD/_KONTRA/libar-zendesk-bot/services/aiService.js).

## Kako flow radi

Za email ticket backend radi sljedeće:

1. Zendesk webhook dohvaća ticket summary i audits.
2. Backend utvrđuje kanal i validira da automation uopće smije raditi.
3. Zadnja korisnička poruka prolazi kroz spam filter.
4. Ako je poruka označena kao spam:
   - ne radi se knowledge retrieval
   - ne poziva se support AI reply flow
   - ticket dobiva interni note
   - ticket dobiva tag `suspected_spam`
   - webhook završava s `action: "ignored_spam"`
5. Ako poruka nije spam:
   - nastavlja se normalni multi-channel knowledge + AI flow
   - bot odgovara samo ako postoji dovoljno siguran odgovor
   - inače ide handoff ljudskom agentu

## Dvoslojni model

### 1. Heuristički filter bez AI-a

Prvi sloj koristi jeftina pravila bez dodatnog AI troška.

Trenutno provjerava:
- broj linkova u poruci
- guest post / sponsored post obrasce
- backlink / link exchange / domain authority obrasce
- SEO service pitch obrasce
- phishing i account verification obrasce
- crypto / wallet / gift card obrasce
- casino / adult spam obrasce
- generički outreach jezik
- marketing agency / lead generation pitch jezik
- masovni email stil poput `dear website owner`
- dugačke poruke bez stvarnog pitanja
- nedostatak support signala

Support signali smanjuju spam score. Primjeri support signala:
- `narudžba`
- `dostava`
- `račun`
- `otkup`
- `procjena`
- `knjiga`
- `strip`
- `gramofon`
- `reklamacija`
- `problem`
- `antikvarijat`
- `libar`

Heuristički rezultat može biti:
- `normal`
- `likely_spam`
- `spam`

Ako heuristike vrate `spam`, poruka se odmah blokira bez dodatnog AI klasifikatora.

### 2. AI classifier za granične slučajeve

Ako heuristike vrate `likely_spam`, opcionalno se poziva mali AI classifier.

Classifier vraća jednu od oznaka:
- `support_message`
- `sales_outreach`
- `marketing_spam`
- `phishing_or_malicious`
- `unknown`

AI classifier ne generira customer-facing odgovor. Njegova jedina svrha je procjena treba li poruku blokirati prije glavnog support flowa.

Poruka se blokira ako classifier vrati:
- `marketing_spam` ili `phishing_or_malicious` s dovoljno visokom sigurnošću
- `sales_outreach` s višim pragom sigurnosti

Ako classifier ne potvrdi spam, poruka nastavlja u standardni support flow.

## Zendesk ponašanje kad se spam otkrije

Kad je poruka blokirana kao spam:
- dodaje se interni note s razlogom blokiranja
- dodaje se tag `suspected_spam`
- korisniku se ne šalje nikakav automatski odgovor
- ticket ostaje vidljiv agentima u Zendesku

Sadržaj internog notea uključuje:
- kanal
- razlog blokiranja
- pogođene heuristike
- AI klasifikaciju ako je korišten drugi sloj

## Environment varijable

Spam filter trenutno koristi ove konfiguracije iz [.env.example](/Volumes/Arien's%20SSD/_KONTRA/libar-zendesk-bot/.env.example):

- `ENABLE_EMAIL_SPAM_CLASSIFIER`
  - uključuje ili isključuje AI classifier za granične slučajeve
  - default: `true`

- `EMAIL_SPAM_AI_MIN_CONFIDENCE`
  - minimalna sigurnost za blokiranje poruke na temelju AI klasifikacije
  - default: `0.75`

Ako je `ENABLE_EMAIL_SPAM_CLASSIFIER=false`, aktivan ostaje samo heuristički spam filter bez AI sloja.

## Što spam filter trenutno ne radi

Trenutna verzija ne radi:
- automatsko zatvaranje spam ticketa
- brisanje ili suspendiranje ticketa u Zendesku
- spam filtriranje za web chat
- spam filtriranje za Facebook
- učenje iz povijesnih agent odluka
- posebnu bazu sender domena ili allow/block listu

## Ograničenja

- Niti heuristike niti AI classifier nisu 100% točni.
- Loše napisani legitimni upiti mogu završiti u `likely_spam` kategoriji.
- AI classifier uvodi mali dodatni trošak, ali samo za sumnjive slučajeve.
- Točnost ovisi o kvaliteti ulazne poruke i pravilnoj Zendesk channel detekciji.

## Operativna preporuka

Za rad u praksi najvažnije je pratiti:
- koliko emailova završi kao `ignored_spam`
- je li neki legitimni support mail pogrešno blokiran
- koliko često AI classifier uopće bude pozvan

Ako se pokaže da heuristike dobro rade same, AI classifier se može ostaviti isključenim. Ako ima previše sivih slučajeva, classifier ostaje koristan drugi sloj.
