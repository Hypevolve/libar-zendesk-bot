# Multi-Channel Bot QA

## Automatizirani scope

- `tests/reasoning.test.js`: intent, continuity, buyback, support info i topic shift heuristike.
- `tests/stability.test.js`: memory, source policy, knowledge quality i product bleed regression.
- `tests/channelPrompting.test.js`: channel prompt pravila i spam-filter asimetrija.
- `tests/conversationRegressionDataset.test.js`: conversation-level parity dataset preko kanala.
- `tests/channelIntegration.test.js`: web chat start/restore flow, Facebook webhook, email spam path i webhook idempotency.

## Manual QA matrix

### Web

1. Pokreni novi chat i potvrdi da su `ime`, `prezime` i `email` obavezni.
2. Odaberi `Prodaja knjiga / otkup` i upiši `Želim prodati knjige`.
3. Nakon odgovora pošalji `Koje vam je radno vrijeme?`.
4. Nakon toga pošalji `Imate li Algebra 1?`.
5. Vrati se na `A gdje se nalazite?`.
6. Refresh stranice i potvrdi da su poruke, aktivna tema i stanje razgovora vraćeni ispravno.
7. Pošalji privitak i potvrdi da flow ne puca i da ide očekivana eskalacija.
8. Provjeri da se product kartice prikazuju samo u `product_lookup` porukama.

### Facebook

1. Pošalji `Htio bih prodati knjige`.
2. Nastavi s `A koje vam je radno vrijeme?`.
3. Nastavi s `A gdje ste?`.
4. Pošalji `Imate li knjigu X?`.
5. Ponovi isti webhook event i potvrdi da nema duplog odgovora.
6. Testiraj poruku sa slikom i potvrdi sigurnu eskalaciju ili ručnu obradu.

### E-mail

1. Pošalji buyback opening mail.
2. Pošalji follow-up mail s upitom za radno vrijeme.
3. Pošalji zaseban mail za adresu ili kontakt.
4. Pošalji `Gdje mi je narudžba?` bez broja i potvrdi jedno kratko potpitanje.
5. Pošalji reklamaciju bez detalja i potvrdi očekivani escalation path.
6. Pošalji spam-like outreach i potvrdi da reply nije poslan.
7. Pošalji quoted/forwarded mail i potvrdi da je zadnja korisnička poruka pravilno ekstrahirana.
8. Pošalji mail s attachmentom i potvrdi očekivanu ručnu provjeru.

## Triage signali koje treba gledati

- `Kanal`
- `Primary intent`
- `Task intent`
- `Active domain`
- `Topic shift type`
- `Topic shift confidence`
- `Source contract`
- `Response policy mode`
- `Knowledge quality`
- `Final outcome`

Ako fail nastane, prvo utvrditi spada li u jednu od tri skupine:

- `intent_wrong`
- `topic_shift_wrong`
- `source_or_render_wrong`
