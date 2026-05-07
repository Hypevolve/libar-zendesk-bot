# Zendesk Ticket Tool Za Copilot Studio

Ako zelis sto manje klikanja, koristi ovaj put:

1. uvezi `zendesk-ticket-custom-connector-flat.yaml`
2. dodaj ga kao tool u agenta
3. spoji Zendesk credentiale
4. pozovi tool iz topica `Kontakt podrške`

Ovo je bolji put od AI generatora tokova ako ti generator bira krivi konektor ili ne daje prijedlog.

## Datoteke za import

Koristi:

- `docs/copilot/zendesk-ticket-custom-connector-flat.yaml`
- `docs/copilot/zendesk-ticket-custom-code.cs`

Prije importa zamijeni:

- `YOUR_ZENDESK_SUBDOMAIN`

Primjer:

- ako ti je Zendesk adresa `https://libar.zendesk.com`
- onda u yaml datoteci host mora biti `libar.zendesk.com`

## Operacije u connectoru

Connector sada ima dvije operacije:

| Operacija | Metoda | Endpoint | Opis |
|---|---|---|---|
| `CreateZendeskTicketFlat` | POST | `/api/v2/tickets` | Kreira novi ticket s korisnikovim upitom |
| `AddCommentToTicketFlat` | PUT | `/api/v2/tickets/{ticketId}` | Dodaje komentar (odgovor agenta) na postojeci ticket |

## Kako uvesti custom connector

1. Otvori agenta u Copilot Studiu.
2. Idi na `Alati`.
3. Klikni `Dodaj alat`.
4. Klikni `Novi alat`.
5. Odaberi `Custom connector`.
6. Otvorit ce se Power Apps portal.
7. Klikni `New custom connector`.
8. Odaberi `Import an OpenAPI file`.
9. Uploadaj `docs/copilot/zendesk-ticket-custom-connector-flat.yaml`.
10. Daj connectoru ime, npr. `Libar Zendesk Ticket API`.
11. Na koraku `Code` zalijepi `docs/copilot/zendesk-ticket-custom-code.cs`.

Microsoft za custom connector podrzava OpenAPI definiciju kao ulaz:

- [Create a custom connector with an OpenAPI extension](https://learn.microsoft.com/en-us/connectors/custom-connectors/openapi-extensions)
- [Use Power Platform connectors as tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/copilot-ai-plugins)

## Kako postaviti autentikaciju

Najjednostavnije je koristiti Zendesk API token preko basic auth.

Zendesk navodi da se API token koristi u formatu:

- username: `email@firma.com/token`
- password: `ZENDESK_API_TOKEN`

Izvor:

- [Zendesk security and authentication](https://developer.zendesk.com/api-reference/introduction/security-and-auth/)

Kad te Power Platform pita za login:

1. Username: tvoj Zendesk admin ili agent email s `/token` na kraju
2. Password: Zendesk API token

Primjer:

- username: `support@libar.hr/token`
- password: `abc123...`

## Kako dodati connector kao tool u agenta

Dodaj obje operacije kao zasebne toolove:

### Tool 1: Create Zendesk ticket

1. Vrati se u Copilot Studio.
2. Idi na `Alati`.
3. Klikni `Dodaj alat`.
4. Odaberi `Connector`.
5. Pronadi `Libar Zendesk Ticket API`.
6. Odaberi operaciju `Create Zendesk ticket`.
7. Klikni `Add and configure`.
8. Pod credentials odaberi `Maker-provided credentials`.

### Tool 2: Add comment to Zendesk ticket

1. Ponovi korake 2-4.
2. Odaberi operaciju `Add comment to Zendesk ticket`.
3. Klikni `Add and configure`.
4. Pod credentials odaberi `Maker-provided credentials`.

Microsoft ovo zove maker-provided credentials:

- [Use Power Platform connectors as tools](https://learn.microsoft.com/en-us/microsoft-copilot-studio/copilot-ai-plugins)

## Kako pozvati iz topica — flow s odgovorom agenta

Napravi topic tipa `Kontakt podrške`.

Trigger phrases:

- `trebam podršku`
- `otvori ticket`
- `imam problem`
- `zelim kontaktirati podrsku`

### Dijagram toka

```
1. TRIGGER (fraze iznad)
       |
       v
2. QUESTION: Ime i prezime → UserName
       |
       v
3. QUESTION: Email → UserEmail
       |
       v
4. QUESTION: Opis problema → UserProblem
       |
       v
5. TOOL: Create Zendesk ticket
   - Subject = "Upit iz Copilot chata"
   - Comment body = UserProblem
   - Requester name = UserName
   - Requester email = UserEmail
   - Priority = "normal"
   - Status = "new"
   → Output: TicketResult
       |
       v
6. SET VARIABLE: TicketId = TicketResult.ticket.id
       |
       v
7. SET VARIABLE: AgentReply =
   "Hvala na upitu. Vas ticket #{TicketId} je zaprimljen.
    Podrska ce Vam odgovoriti u najkracem mogucem roku
    na {UserEmail}."
       |
       v
8. TOOL: Add comment to Zendesk ticket
   - Ticket ID = TicketId
   - Comment body = AgentReply
   - Public comment = true
       |
       v
9. MESSAGE: Prikazi AgentReply korisniku
```

### Koraci u Copilot Studio UI

1. Otvori ili kreiraj topic `Kontakt podrške` s trigger frazama.
2. Dodaj tri `Question` nodea za UserName, UserEmail i UserProblem.
3. Dodaj `Add a tool` node → odaberi `Create Zendesk ticket`.
4. Mapiraj polja:
   - `Subject` = `Upit iz Copilot chata`
   - `Comment body` = `UserProblem`
   - `Requester name` = `UserName`
   - `Requester email` = `UserEmail`
   - `Public comment` = `true`
   - `Priority` = `normal`
   - `Status` = `new`
5. Dodaj `Set Variable` node:
   - Variable: `TicketId`
   - Value: klikni `{x}` → odaberi output prethodnog tool nodea → `ticket.id`
6. Dodaj jos jedan `Set Variable` node:
   - Variable: `AgentReply`
   - Value: `Hvala na upitu. Vas ticket #{TicketId} je zaprimljen. Podrska ce Vam odgovoriti u najkracem mogucem roku na {UserEmail}.`
7. Dodaj `Add a tool` node → odaberi `Add comment to Zendesk ticket`.
8. Mapiraj polja:
   - `Ticket ID` = `TicketId`
   - `Comment body` = `AgentReply`
   - `Public comment` = `true`
9. Dodaj `Message` node s tekstom `AgentReply` (ili ponovi isti tekst).

## Sto agentu dodati u upute

Dodaj ovo u `Upute` agenta:

`Kad korisnik izricito trazi podrsku, prijavu problema, reklamaciju ili ljudski kontakt, prikupi ime, email i kratak opis problema. Zatim pozovi Zendesk ticket tool da otvori ticket, a nakon toga pozovi Add comment tool da zapisem odgovor agenta na isti ticket. Ne tvrdi da je ticket otvoren ako tool nije uspjesno vratio rezultat.`

## Ako zelis jos manje klikanja

Najmanje manualnog rada je:

1. import OpenAPI datoteke
2. add oba toola
3. jedan topic s 9 nodeova

Ne preporucujem trenutno AI flow generator za ovaj slucaj jer ti je vec:

- birao `Freshservice` umjesto `Zendesk`
- davao `No suggestions`

## Bitna ogranicenja

- `CreateZendeskTicketFlat` otvara novi ticket.
- `AddCommentToTicketFlat` dodaje komentar na postojeci ticket.
- Komentar je `public: true` sto znaci da korisnik dobiva odgovor i na email.
- Za vise turnova razgovora na istom ticketu, mozes ponoviti `AddCommentToTicketFlat` s novim tekstom i istim `TicketId`.

