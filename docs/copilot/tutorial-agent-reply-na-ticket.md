# Tutorial: Kako dodati odgovor agenta na Zendesk ticket

Ovaj tutorial te vodi korak po korak kroz cijeli proces.
Na kraju, tvoj bot će:

- otvoriti Zendesk ticket s korisnikovim upitom
- zapisati svoj odgovor kao komentar na isti ticket
- korisnik dobiva taj odgovor i na email

---

## DIO 1: Ažuriraj connector u Power Automate

### Korak 1 — Otvori connector

1. Odi na https://make.powerautomate.com
2. U lijevom izborniku klikni **More** → **Discover all**
3. Pronadi **Custom connectors** (pod Data)
4. Klikni na **Libar Zendesk Ticket API** (ili kako si ga nazvao)
5. Klikni **Edit** (ikona olovke)

### Korak 2 — Dodaj novu akciju (Definition tab)

1. Klikni na tab **2. Definition** (gore u koracima)
2. Na lijevoj strani klikni **+ New action**
3. Popuni:
   - **Summary**: `Add comment to Zendesk ticket`
   - **Description**: `Dodaje komentar na postojeci ticket`
   - **Operation ID**: `AddCommentToTicketFlat`

### Korak 3 — Definiraj request

1. Ispod **Request** klikni **+ Import from sample**
2. U prozoru koji se otvori popuni:
   - **Verb**: odaberi `PUT`
   - **URL**: `https://antikvarijat-libar.zendesk.com/api/v2/tickets/{ticketId}`
   - **Body**: zalijepi ovo:
     ```json
     {
       "commentBody": "Primjer komentara",
       "commentPublic": true
     }
     ```
3. Klikni **Import**

### Korak 4 — Provjeri parametre

Nakon importa trebao bi vidjeti:

- **ticketId** (path parametar) — klikni na njega i provjeri:
  - Is required: **Yes**
  - Type: **integer**
- **commentBody** (body parametar) — klikni na njega:
  - Is required: **Yes**
- **commentPublic** (body parametar) — klikni na njega:
  - Is required: **No**
  - Default value: `true`

### Korak 5 — Ažuriraj custom code

1. Klikni na tab **5. Code** (gore u koracima)
2. Uključi **Code Enabled** ako nije uključen
3. Obriši sav postojeći kod
4. Otvori datoteku `docs/copilot/zendesk-ticket-custom-code.cs` iz ovog repoa
5. Kopiraj **cijeli sadržaj** te datoteke
6. Zalijepi ga u code editor

### Korak 6 — Spremi connector

1. Klikni **✓ Update connector** (gore desno)
2. Pričekaj da se spremi (zelena poruka "Custom connector has been updated")

### Korak 7 — Testiraj novu akciju

1. Klikni na tab **6. Test**
2. Ako nemaš connection, klikni **+ New connection** i upiši:
   - Username: `tvoj-email@firma.com/token`
   - Password: tvoj Zendesk API token
3. Pod **Operations** odaberi `AddCommentToTicketFlat`
4. Popuni:
   - **ticketId**: upiši ID nekog postojećeg ticketa (npr. `123`)
   - **commentBody**: `Test komentar iz connectora`
   - **commentPublic**: `true`
5. Klikni **Test operation**
6. Trebao bi dobiti **Status 200** i vidjeti ticket u odgovoru
7. Otvori Zendesk i provjeri da komentar postoji na tom ticketu

> Ako dobiješ grešku 404, provjeri da ticketId postoji.
> Ako dobiješ 401, provjeri username i password.

---

## DIO 2: Dodaj novi tool u Copilot Studio

### Korak 8 — Otvori agenta

1. Odi na https://copilotstudio.microsoft.com
2. Otvori svog agenta (Libar Asistent)

### Korak 9 — Dodaj tool za dodavanje komentara

1. U lijevom izborniku klikni **Tools** (Alati)
2. Klikni **+ Add a tool**
3. U tražilici upiši `Libar Zendesk` ili `Add comment`
4. Trebao bi vidjeti **Add comment to Zendesk ticket** — klikni na nju
5. Klikni **Add tool**
6. Kad te pita za credentials, odaberi **Maker-provided credentials**
   (ovo znači da bot koristi tvoje Zendesk credentiale, ne korisnikove)

---

## DIO 3: Ažuriraj topic u Copilot Studio

### Korak 10 — Otvori topic

1. U lijevom izborniku klikni **Topics**
2. Pronadi i otvori topic **Kontakt podrške**
   (ili kako si ga nazvao — onaj koji otvara Zendesk ticket)

### Korak 11 — Provjeri da imaš ove varijable

Tvoj topic bi već trebao imati ove korake iz postojećeg flowa:

- Question node → varijabla `UserName` (ime korisnika)
- Question node → varijabla `UserEmail` (email korisnika)
- Question node → varijabla `UserProblem` (opis problema)
- Tool node → `Create Zendesk ticket`

Ako ih nemaš, dodaj ih prije nego nastaviš.

### Korak 12 — Izvuci Ticket ID iz odgovora

Odmah **ispod** tool nodea `Create Zendesk ticket`:

1. Klikni **+** (dodaj node) → **Variable management** → **Set a variable value**
2. Postavi:
   - **Variable**: klikni na polje i odaberi **Create new** → upiši `TicketId`
   - **To value**: klikni na **{x}** ikonu → pronadi output od Create Zendesk ticket nodea → odaberi **ticket** → **id**

> Ovo sprema ID novootvorenog ticketa u varijablu `TicketId` da ga možeš koristiti dalje.

### Korak 13 — Pripremi tekst odgovora agenta

1. Klikni **+** → **Variable management** → **Set a variable value**
2. Postavi:
   - **Variable**: klikni **Create new** → upiši `AgentReply`
   - **To value**: upiši tekst, npr:

```
Hvala na Vašem upitu. Vaš ticket je zaprimljen pod brojem #{TicketId}. Podrška će Vam se javiti u najkraćem mogućem roku na {UserEmail}.
```

> Kad upisuješ tekst, za varijable (`TicketId`, `UserEmail`) klikni **{x}** ikonu i odaberi ih iz liste.

### Korak 14 — Pozovi Add comment tool

1. Klikni **+** → **Call an action** → odaberi **Add comment to Zendesk ticket**
2. Mapiraj polja:
   - **Ticket ID**: klikni **{x}** → odaberi `TicketId`
   - **Comment body**: klikni **{x}** → odaberi `AgentReply`
   - **Public comment**: upiši `true`

### Korak 15 — Dodaj završnu poruku korisniku

1. Klikni **+** → **Send a message**
2. U tekst poruke upiši istu stvar kao u koraku 13, ili klikni **{x}** i odaberi varijablu `AgentReply`

### Korak 16 — Spremi i testiraj

1. Klikni **Save** (gore desno)
2. Otvori **Test** panel (donji desni kut)
3. Upiši: `Trebam podršku`
4. Odgovori na pitanja (ime, email, opis problema)
5. Bot bi trebao:
   - otvoriti ticket
   - reći ti broj ticketa
   - zapisati svoj odgovor na ticket
6. Odi u Zendesk i provjeri:
   - ticket postoji
   - ima **dva komentara**: korisnikov upit + odgovor agenta

---

## Kako bi gotov flow trebao izgledati

```
[Trigger: "trebam podršku", "imam problem"...]
         ↓
[Question: Kako se zovete? → UserName]
         ↓
[Question: Koji je Vaš email? → UserEmail]
         ↓
[Question: Opišite problem → UserProblem]
         ↓
[Tool: Create Zendesk ticket]
  Subject = "Upit iz Copilot chata"
  Comment body = UserProblem
  Requester name = UserName
  Requester email = UserEmail
         ↓
[Set variable: TicketId = ticket.id iz prethodnog koraka]
         ↓
[Set variable: AgentReply = "Hvala... ticket #{TicketId}..."]
         ↓
[Tool: Add comment to Zendesk ticket]
  Ticket ID = TicketId
  Comment body = AgentReply
  Public comment = true
         ↓
[Message: AgentReply]
```

---

## Česta pitanja

**P: Što ako Create Zendesk ticket ne vrati ticket.id?**
Provjeri da je connector ispravan i da custom code ima obje metode. Ako test u Power Automate radi, problem je u mapiranju outputa u Copilot Studio.

**P: Što ako Add comment vrati grešku?**
Najčešće je krivi ticketId. Provjeri da Set Variable node koristi ispravan output path (`ticket.id`, ne cijeli ticket objekt).

**P: Mogu li koristiti generative answer umjesto fiksnog teksta?**
Da, ali tada moraš generative answer node staviti umjesto Set Variable za AgentReply, i output tog nodea proslijediti u Add comment tool.

**P: Hoće li korisnik dobiti email?**
Da, jer je `commentPublic` postavljeno na `true`. Zendesk šalje email notification korisniku za svaki public comment.
