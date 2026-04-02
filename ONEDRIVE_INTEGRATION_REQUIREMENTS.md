# OneDrive Integracija za Libar Chatbot

**Datum dokumenta:** 2. travnja 2026.

## Svrha dokumenta

Ovaj dokument opisuje što je potrebno da se Libar chatbot spoji i na OneDrive dokumentaciju kao dodatnu bazu znanja.

Trenutno je bot spojen samo na **Zendesk Help Center**. To je bila početna i jednostavnija faza implementacije, kako bismo najbrže validirali osnovni support flow i način rada bota.

Sljedeća faza može biti proširenje baze znanja tako da bot, uz Zendesk članke, koristi i internu dokumentaciju iz **Microsoft 365 / OneDrive for Business / SharePoint** sustava.

## Trenutno stanje

Bot danas koristi:

- web chat widget na stranici
- Zendesk ticket kao glavni zapis razgovora
- Zendesk Help Center kao trenutnu bazu znanja
- AI sloj koji odgovara samo kad postoji dovoljno siguran kontekst

To znači da bot trenutno **ne koristi dokumente iz OneDrivea**, čak i ako takva dokumentacija postoji unutar Microsoft 365 okruženja.

## Što želimo postići

Cilj OneDrive integracije je da chatbot može koristiti internu dokumentaciju kao dodatni izvor znanja, na primjer:

- interne procedure
- opise procesa
- upute za kupnju ili narudžbe
- dokumentaciju za korisničku podršku
- FAQ dokumente koji nisu objavljeni u Zendesk Help Centeru

Na taj način bot može davati kvalitetnije i potpunije odgovore, pod uvjetom da je dokumentacija strukturirana i odobrena za korištenje u korisničkoj podršci.

## Preporučeni model integracije

Preporučeni model za produkciju je:

- **Microsoft 365 business / OneDrive for Business / SharePoint**
- pristup preko **Microsoft Graph API-ja**
- autentikacija preko **Azure / Microsoft Entra app registrationa**
- čitanje samo točno definiranog foldera s dokumentacijom

Ovo je stabilnije i sigurnije od oslanjanja na običan browser link ili javni share link.

## Što nam treba od klijenta

### 1. Potvrda lokacije dokumentacije

Potrebno je potvrditi:

- koja će točno mapa biti korištena kao knowledge base
- smije li bot koristiti dokumente iz te mape za korisničke odgovore
- postoje li dokumenti unutar te mape koje bot **ne smije** koristiti

Potrebno nam je dostaviti:

- link na točnu mapu
- po mogućnosti i tehničke identifikatore mape ako ih IT tim ima

### 2. Potvrda tipa sustava

Potrebno je potvrditi da se dokumentacija nalazi u:

- **Microsoft 365 / OneDrive for Business**
- ili **SharePoint Online** dokumentnoj biblioteci

Ovo je važno jer se backend na takav sustav spaja preko Microsoft Graph API-ja.

### 3. Azure / Microsoft Entra aplikacija

Za sigurnu produkcijsku integraciju potrebno je kreirati ili omogućiti pristup aplikaciji u Azure / Microsoft Entra ID-u.

Od klijenta ili njihovog IT tima trebamo:

- `Tenant ID`
- `Client ID`
- `Client Secret`

Ovi podaci služe za sigurno spajanje backend servisa na Microsoft Graph API.

Napomena:

- nije potrebno podizati novi server u Azureu
- ali je potrebno imati **registriranu aplikaciju** koja ima odobren pristup dokumentaciji

### 4. Dozvole za pristup dokumentima

IT tim treba odobriti aplikaciji pravo čitanja ciljanog OneDrive / SharePoint sadržaja.

Praktično trebamo:

- read access nad odabranim folderom
- potvrdu da aplikacija smije čitati sadržaj preko Microsoft Graph API-ja

Idealno je da pristup bude ograničen samo na potrebnu lokaciju, a ne na cijeli tenant.

### 5. Dokumenti koje bot treba podržavati

Potrebno je potvrditi koje tipove datoteka želite uključiti u bazu znanja.

Preporučeni početni set:

- `PDF`
- `DOCX`
- `TXT`
- `MD`

Ako postoje i drugi formati, potrebno ih je unaprijed navesti jer to utječe na parser i kvalitetu rezultata.

### 6. Testni skup dokumentacije

Za početnu implementaciju poželjno je pripremiti jedan testni folder s manjim brojem reprezentativnih dokumenata.

Preporuka:

- 5 do 20 dokumenata
- različiti tipovi datoteka
- dokumenti koji stvarno predstavljaju sadržaj koji bi bot trebao koristiti

To nam omogućuje da najprije testiramo kvalitetu dohvaćanja i odgovora prije puštanja cijelog foldera u rad.

### 7. Sigurnosna i sadržajna potvrda

Potrebna je potvrda:

- da dokumenti u toj mapi smiju biti korišteni za customer support odgovore
- da mapa ne sadrži osjetljive interne informacije koje bot ne smije koristiti
- da je sadržaj dovoljno aktualan i uređen za korištenje kao knowledge base

Ovo je važno jer bot ne bi smio odgovarati na temelju internih napomena ili dokumenata koji nisu namijenjeni podršci.

## Step-by-step vodič: kako dobiti potrebne podatke

Ovaj dio je namijenjen osobi iz IT-a ili administraciji koja ima pristup Microsoft 365 / Azure okruženju.

### Korak 1: Potvrdite točnu mapu koja ulazi u bazu znanja

Potrebno je prvo odlučiti koja će mapa biti korištena za chatbot knowledge base.

Pošaljite nam:

- link na točnu mapu
- potvrdu da je to jedina mapa koju bot treba čitati
- potvrdu da dokumenti u toj mapi smiju biti korišteni za korisničku podršku

Preporuka:

- koristiti jednu jasno definiranu mapu
- ne koristiti osobne ili miješane radne mape s osjetljivim sadržajem

### Korak 2: Provjerite radi li se o Microsoft 365 business / SharePoint lokaciji

Ako link izgleda otprilike ovako:

- `tenant-my.sharepoint.com/...`

onda se radi o Microsoft 365 / SharePoint / OneDrive for Business okruženju i to je odgovarajući tip sustava za integraciju.

Pošaljite nam:

- potvrdu da je dokumentacija na Microsoft 365 / OneDrive for Business / SharePoint sustavu

### Korak 3: Otvorite Microsoft Entra / Azure portal

Osoba s odgovarajućim administratorskim pravima treba otvoriti:

- [https://entra.microsoft.com](https://entra.microsoft.com)

ili:

- [https://portal.azure.com](https://portal.azure.com)

### Korak 4: Kreirajte App Registration

U Microsoft Entra / Azure portalu:

1. otvorite `Microsoft Entra ID`
2. otvorite `App registrations`
3. kliknite `New registration`
4. upišite naziv aplikacije, npr. `Libar Chatbot OneDrive Access`
5. za tip računa ostavite organizational / single tenant opciju
6. redirect URI nije nužan za backend integraciju ako koristimo server-to-server pristup
7. kliknite `Register`

Nakon toga pošaljite nam:

- `Application (client) ID`
- `Directory (tenant) ID`

To su:

- `Client ID`
- `Tenant ID`

### Korak 5: Kreirajte Client Secret

Nakon što je aplikacija kreirana:

1. otvorite novokreiranu aplikaciju
2. otvorite `Certificates & secrets`
3. kliknite `New client secret`
4. upišite naziv, npr. `Libar chatbot secret`
5. odaberite odgovarajući expiry period prema vašoj sigurnosnoj politici
6. kliknite `Add`

Vrlo važno:

- vrijednost secreta se vidi samo jednom nakon kreiranja
- potrebno ju je odmah kopirati i sigurno pohraniti

Pošaljite nam:

- `Client Secret` value

### Korak 6: Dodijelite Microsoft Graph dozvole

U istoj aplikaciji:

1. otvorite `API permissions`
2. kliknite `Add a permission`
3. odaberite `Microsoft Graph`
4. odaberite permission tip koji odgovara vašoj politici pristupa

Za nas je cilj da aplikacija ima **read pristup** ciljanoj dokumentaciji.

Po mogućnosti koristite:

- ograničeni pristup samo ciljanoj lokaciji

Ako to vaš tenant i politika ne podržavaju jednostavno, IT tim može privremeno odobriti širi read pristup za pilot fazu.

Nakon toga je često potrebno kliknuti:

- `Grant admin consent`

Pošaljite nam:

- potvrdu da je aplikacija dobila read pristup dokumentaciji
- informaciju je li pristup ograničen samo na ciljanu lokaciju ili je širi

### Korak 7: Potvrdite točnu lokaciju foldera

Osim samog linka na mapu, idealno je da IT ili administrator potvrdi:

- naziv mape
- gdje se nalazi
- da je to mapa koju aplikacija smije čitati

Nama je za početak dovoljan:

- link na mapu

Ako imate tehničke identifikatore, možete poslati i:

- `Drive ID`
- `Folder ID`

Ako te identifikatore ne znate dohvatiti, nije problem. Link na mapu je dovoljan za početnu konfiguraciju.

### Korak 8: Potvrdite koje dokumente uključujemo

Pošaljite nam potvrdu koje formate treba podržati u toj mapi.

Preporučeni početni set:

- PDF
- DOCX
- TXT
- MD

Ako u mapi postoje i druge vrste dokumenata, potrebno je unaprijed reći:

- koje bot smije koristiti
- koje bot treba ignorirati

### Korak 9: Pripremite testni folder za pilot

Za početnu integraciju preporučujemo manji pilot set.

Idealno:

- 5 do 20 dokumenata
- reprezentativni sadržaj
- sadržaj koji stvarno treba biti uključen u support odgovore

To nam omogućuje da prvo provjerimo:

- kvalitetu parsiranja
- kvalitetu retrievala
- kvalitetu odgovora bota

### Korak 10: Potvrdite sigurnosna pravila

Prije spajanja nam treba potvrda:

- da bot smije koristiti sadržaj tih dokumenata za odgovaranje korisnicima
- da mapa ne sadrži osjetljive interne dokumente koji nisu za customer-facing odgovore
- da je sadržaj dovoljno ažuran za korištenje u podršci

### Korak 11: Ako želite napredniji sync

Ako želite near-real-time sinkronizaciju promjena iz OneDrivea, potrebno je dodatno pripremiti:

- javno dostupan `HTTPS` endpoint na našoj strani
- mogućnost korištenja Microsoft Graph webhook / subscription modela
- dogovor oko validacije webhook poziva

Ovo nije obavezno za početni pilot, ali jest za napredniju produkcijsku integraciju.

## Što nam konkretno trebate poslati

Najjednostavnije je da nam klijent ili IT pošalje sljedeći paket informacija:

- link na ciljnu mapu
- potvrdu da je to Microsoft 365 / OneDrive for Business / SharePoint lokacija
- `Tenant ID`
- `Client ID`
- `Client Secret`
- potvrdu da aplikacija ima read pristup toj lokaciji
- popis tipova dokumenata koje uključujemo
- potvrdu da bot smije koristiti sadržaj tih dokumenata za support odgovore

## Dvije moguće varijante implementacije

### Opcija A: Brži pilot

Ovo je jednostavnija početna faza.

Koristi:

- jedan odabrani folder
- ograničen broj dokumenata
- periodički sync

Prednosti:

- brža implementacija
- manji operativni rizik
- lakše testiranje kvalitete odgovora

Za ovu varijantu nam treba:

- pristup aplikaciji
- read dozvole
- testni folder
- potvrda podržanih formata

### Opcija B: Produkcijska integracija

Ovo je puniji i stabilniji model.

Koristi:

- Microsoft Graph API
- veći ili glavni knowledge folder
- sinkronizaciju promjena u gotovo realnom vremenu
- održavanje lokalnog indeksa sadržaja za brzo pretraživanje

Prednosti:

- stabilnije produkcijsko rješenje
- ažurnija dokumentacija
- manje ručnog održavanja

Za ovu varijantu, osim gore navedenog, trebamo i:

- javno dostupan backend endpoint za webhookove
- dogovor oko validacije webhook poziva
- potvrdu da je dopušten Graph webhook / delta sync model

## Što nije dovoljno za produkcijsku integraciju

Samo browser link na OneDrive mapu obično nije dovoljan za ozbiljno i pouzdano spajanje bota na dokumentaciju.

Razlog:

- UI link nije isto što i API pristup
- share postavke se mogu promijeniti
- nije prikladno za stabilno listanje i sinkronizaciju svih dokumenata
- near-real-time ažuriranje je teško ili nepouzdano bez Graph API-ja

Takav link eventualno može poslužiti za vrlo ograničen proof of concept, ali nije preporučeni produkcijski model.

## Preporuka

Preporuka je da integraciju radimo ovim redom:

1. potvrditi koji folder ulazi u knowledge base
2. dobiti Azure / Microsoft Entra pristupne podatke
3. dobiti read dozvole za taj folder
4. testirati manji pilot skup dokumenata
5. tek nakon toga proširiti na širu ili produkcijsku integraciju

To je najbrži i najsigurniji način da se provjeri kvaliteta rezultata bez nepotrebnog rizika.

## Kratki popis podataka koje trebamo od klijenta

Za početak nam je dovoljno dostaviti:

- potvrdu da žele uključiti OneDrive dokumentaciju u bazu znanja
- link na točnu mapu koja će se koristiti
- potvrdu da se radi o Microsoft 365 / OneDrive for Business / SharePoint lokaciji
- `Tenant ID`
- `Client ID`
- `Client Secret`
- potvrdu da aplikacija smije čitati tu mapu
- potvrdu koje tipove datoteka uključujemo
- potvrdu da bot smije koristiti sadržaj tih dokumenata za support odgovore

## Završna napomena

OneDrive integracija je u potpunosti izvediva, ali je prirodno naprednija od početne Zendesk Help Center integracije. Početna verzija bota krenula je sa Zendesk bazom znanja zato što je to bio najjednostavniji i najbrži put do prve funkcionalne verzije. Spajanje OneDrive dokumentacije logičan je sljedeći korak za proširenje znanja i kvalitete odgovora.
