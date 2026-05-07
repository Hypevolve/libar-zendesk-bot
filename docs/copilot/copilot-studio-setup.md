# Copilot Studio Setup: Libar Asistent

Ovaj vodič je za javni customer-support bot koji će biti dostupan na webu.

## 1. Kreiraj agenta

1. Otvori `copilotstudio.microsoft.com`.
2. Kreiraj novi agent.
3. Postavi naziv na `Libar Asistent`.
4. U opis stavi:

   `Agent korisničke podrške za Antikvarijat Libar. Pomaže korisnicima oko kupnje i otkupa rabljenih udžbenika, dostave, plaćanja, reklamacija, povrata, kontakta i radnog vremena.`

## 2. Umetni prompt

1. Otvori agent instructions.
2. Zalijepi sadržaj iz datoteke:

   `docs/copilot/libar-copilot-studio-system-prompt.md`

## 3. Postavi sigurnost i AI ponašanje

1. Idi na `Settings > Security > Authentication`.
2. Za javni web bot koristi varijantu bez Microsoft user sign-ina za krajnje kupce.
3. U `Generative AI` uključi generative orchestration.
4. Isključi web search ako želiš da odgovori dolaze samo iz Libar znanja.
5. Ako želiš stroži bot, isključi ungrounded odgovore i obavezno dodaj fallback topic.

## 4. Uploadaj knowledge base

Ne koristi live SharePoint kao glavni public-facing knowledge source u v1.

Umjesto toga:

1. Pokreni lokalno:

   ```bash
   ./scripts/build-copilot-upload-bundle.sh
   ```

2. U Copilot Studio otvori `Knowledge`.
3. Dodaj dokumente iz:

   `dist/copilot-upload-bundle/docx/`

4. Ako želiš bržu iteraciju, možeš uploadati i `.txt` verzije iz:

   `dist/copilot-upload-bundle/txt/`

## 5. Ručno dodaj topic-e

Napravi barem ova četiri topic-a:

- `Kontakt i prijenos na čovjeka`
- `Izmjena ili otkazivanje narudžbe`
- `Povrat / reklamacija`
- `No answer / fallback`

Tekstove i logiku uzmi iz:

- `docs/copilot/fallback-topics.md`

## 5.5. Postavi flow za zapisivanje odgovora agenta na Zendesk ticket

Topic `Kontakt podrške` treba koristiti dva toola:

1. `Create Zendesk ticket` — otvara ticket s korisnikovim upitom
2. `Add comment to Zendesk ticket` — zapisuje odgovor agenta kao javni komentar

Odgovor agenta šalje se korisniku i na email (public comment).

Detaljne upute, dijagram toka i mapiranje polja:

- `docs/copilot/zendesk-ticket-tool-setup.md`

## 6. Suggested prompts

Dodaj startere iz:

- `docs/copilot/starter-prompts.txt`

## 7. Test scenariji

U test panelu provjeri barem:

- `Kako kupiti udžbenike?`
- `Kako prodati udžbenike?`
- `Koji su načini plaćanja?`
- `Koliki je rok dostave?`
- `Kako otkazati narudžbu?`
- `Što ako je stigla kriva knjiga?`
- `Koje vam je radno vrijeme?`
- `Kako vas mogu kontaktirati?`

Bot mora:

- odgovoriti iz knowledge basea bez izmišljanja
- razlikovati kupnju od otkupa
- ne smjeti tvrditi da je status narudžbe provjeren
- kod reklamacija, otkazivanja i specifične narudžbe voditi prema čovjeku

## 8. Objavi

1. Najprije objavi na `demo website`.
2. Kad prođe test, objavi na `live website`.
3. Ako koristiš postojeći Libar web chat middleware iz ovog repoa, pregledaj i:

   `WORDPRESS_EMBED.md`

4. Ako koristiš native Copilot Studio web kanal, ugradi njihov web chat snippet na Libar stranicu.
