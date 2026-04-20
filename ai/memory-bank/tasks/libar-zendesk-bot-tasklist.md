# Libar Zendesk Bot Development Tasks

## Specification Summary
**Original Requirements**: Bot mora biti robustan, pouzdan, točno odgovarati na upite iz OneDrive i Zendesk baze znanja, razumjeti korisnikov intent, ne otvarati duple tickete i stabilno voditi support tokove.
**Technical Stack**: Node.js, Express, Zendesk Support API, Zendesk Help Center, OneDrive/SharePoint, OpenRouter.
**Target Timeline**: Iterativna stabilizacija u ovom ciklusu implementacije.

## Development Tasks

### [x] Task 1: Durable Runtime State
**Description**: Persistirati aktivne sessione i webhook dedupe stanje tako da restart procesa ne ruši aktivne support tokove.
**Acceptance Criteria**:
- Aktivne web chat sesije se mogu vratiti nakon restarta procesa.
- Webhook dedupe i recent-start dedupe nisu samo in-memory.
- Runtime state se periodički i pri shutdownu sprema na disk.

### [x] Task 2: Duplicate Ticket Prevention
**Description**: Spriječiti ponovno otvaranje istog web chat ticketa kod dvostrukog submit-a ili brzog refresh/retry ponašanja.
**Acceptance Criteria**:
- Ponovljeni `start` za istog korisnika i isti upit vraća postojeću sesiju.
- Sustav ne otvara novi ticket ako je već otvoren isti aktivni razgovor.
- Povratni payload zadržava postojeći session/ticket mapping.

### [x] Task 3: Retrieval Signal Hardening
**Description**: Ojačati query preprocessing i scoring za Help Center i OneDrive retrieval.
**Acceptance Criteria**:
- Sinonimi i tipične parafraze dižu relevanciju pravih članaka/dokumenata.
- Aktivna referenca iz razgovora dodatno boosta relevantne rezultate.
- Search opcije nose retrieval hintove iz intent i entity sloja.

### [x] Task 4: Sensitive Support Intake
**Description**: Za reklamacije i probleme s narudžbom prvo tražiti ključne operativne podatke kad to pomaže, umjesto trenutne prerane eskalacije.
**Acceptance Criteria**:
- Reklamacija bez broja narudžbe traži broj narudžbe.
- Kratka complaint poruka traži kratak opis problema.
- Visokorizične teme poput plaćanja/refunda i dalje sigurno eskaliraju.

### [x] Task 5: Extended Regression Coverage
**Description**: Pokriti nove pouzdanosne tokove testovima.
**Acceptance Criteria**:
- Testovi pokrivaju duplicate start flow.
- Testovi pokrivaju complaint clarification prije eskalacije.
- Testovi pokrivaju retrieval alias/signals poboljšanja.

### [x] Task 6: Runtime Metrics And Conflict Guard
**Description**: Dodati operativne metrike i spriječiti AI answer kad Zendesk i OneDrive daju konfliktne support informacije.
**Acceptance Criteria**:
- `/health` vraća runtime metrike relevantne za support kvalitetu.
- Duplicate start i duplicate webhook događaji ulaze u metrike.
- Konflikt ključnih support informacija (`hours`, `email`, `phone`, `address`) rezultira sigurnim handoffom umjesto AI odgovora.

### [x] Task 7: Deterministic Knowledge Replies
**Description**: Za jasne i jake KB hitove vratiti deterministic odgovor iz Zendesk/OneDrive sadržaja prije LLM sloja.
**Acceptance Criteria**:
- `support_info`, `delivery` i `buyback` upiti s jakim knowledge signalom mogu biti odgovoreni bez `generateReply`.
- Deterministic odgovor koristi stvarne rečenice iz najrelevantnijih članaka/dokumenata.
- Ako je LLM nedostupan, jaki KB upit i dalje može završiti točnim odgovorom.

## Quality Requirements
- [x] Nema background procesa u komandama.
- [x] Mobilni i postojeći widget flow ostaje kompatibilan.
- [x] Test suite mora proći nakon promjena.
- [x] Promjene moraju biti backward-compatible za postojeće Zendesk tokove.

## Technical Notes
**Special Instructions**: Fokus na funkcionalnu robusnost i support kvalitetu, bez scope creep-a na irelevantne frontend zahvate.
